#!/usr/bin/env node
/**
 * windsurf-search-mcp — MCP stdio server exposing Windsurf/Devin server-side
 * web search (GetWebSearchResults) as a `web_search` tool.
 *
 * Zero npm dependencies. Speaks both MCP JSON-RPC framings:
 *   - Content-Length framing (official @modelcontextprotocol/sdk client)
 *   - newline-delimited JSON (handcrafted NDJSON clients)
 *
 * Example MCP config:
 *   {
 *     "mcpServers": {
 *       "windsurf-search": {
 *         "command": "npx",
 *         "args": ["-y", "windsurf-search-mcp"]
 *       }
 *     }
 *   }
 *
 * Auth (never commit secrets):
 *   WINDSURF_API_KEY env, or key file under ~/.config/windsurf-search/api-key
 */
import { readFileSync } from 'node:fs';
import { resolveApiKey, searchWindsurf } from './windsurf-search.mjs';

const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0'; // script copied standalone without package.json
  }
})();
const SERVER_INFO = { name: 'windsurf-search-mcp', version: PACKAGE_VERSION };
const PROTOCOL_VERSION = '2024-11-05';

const tools = [
  {
    name: 'web_search',
    description:
      'Search the web via Devin/Windsurf server-side search. ' +
      'Returns JSON hits [{title,url,snippet,source}]. ' +
      'Use for current web facts, docs lookups, and general web research.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (required)' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          default: 5,
          description: 'Max results (1-10)',
        },
        domain: {
          type: 'string',
          description: 'Optional domain restriction, e.g. github.com',
        },
        mode: { type: 'number', description: 'Optional search mode' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

// Raw byte buffer — Content-Length counts BYTES, so we must not slice a
// decoded string (a multi-byte UTF-8 body would desynchronize the stream).
let buffer = Buffer.alloc(0);
// A runaway client (or a bogus huge Content-Length) could grow the buffer
// without bound — cap it and reset rather than exhausting memory.
const MAX_BUFFER_BYTES = 32 << 20;

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // Parse first so a large burst of valid small messages is still processed;
  // the cap only drops unparseable leftover (huge/bogus frames).
  parseBuffer();
  if (buffer.length > MAX_BUFFER_BYTES) {
    process.stderr.write('windsurf-search-mcp: input exceeded 32 MiB, dropping buffered data\n');
    buffer = Buffer.alloc(0);
  }
});
// In-flight request handlers — a client may close stdin immediately after
// writing its requests, so 'end' must drain pending work and flush stdout
// before exiting or responses are silently truncated.
const inflight = new Set();
process.stdin.on('end', () => {
  Promise.allSettled([...inflight]).then(() => {
    process.stdout.write('', () => process.exit(0));
  });
});
process.stdin.on('error', () => process.exit(1));

/**
 * Sniff the framing of the next message in the buffer.
 * Returns 'cl' (Content-Length header block), 'ndjson', or 'wait' (incomplete).
 * Header-block framing starts with a `Content-Length:`/`Content-Type:` line;
 * NDJSON JSON-RPC messages always start with '{'.
 */
function sniffFraming() {
  if (buffer.length === 0) return 'wait';
  if (buffer[0] === 0x7b) return 'ndjson'; // '{'
  const head = buffer.subarray(0, 64).toString('latin1');
  if (/^(content-length|content-type):/i.test(head)) {
    // Header lines are CRLF-terminated; a bare-LF first line is NDJSON
    // garbage (e.g. a stray "content-type: x" log line), not a header block.
    const firstNl = buffer.indexOf(0x0a);
    if (firstNl !== -1 && buffer[firstNl - 1] !== 0x0d) return 'ndjson';
    return 'cl';
  }
  // Not a known header and not '{' — an NDJSON line (possibly garbage).
  // If no newline has arrived yet the line may simply be incomplete — or it
  // could be the prefix of a header block, so wait for more bytes.
  if (buffer.indexOf(0x0a) === -1) return 'wait';
  return 'ndjson';
}

function parseBuffer() {
  for (;;) {
    const kind = sniffFraming();
    if (kind === 'wait') return;

    if (kind === 'cl') {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString('latin1');
      // Line-anchored: 'X-Content-Length:' or a value mentioning the name must
      // not be read as the frame length.
      const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
      if (!match) {
        // header block without Content-Length — drop it rather than stalling
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + bodyLength) return;
      const body = buffer.subarray(bodyStart, bodyStart + bodyLength);
      buffer = buffer.subarray(bodyStart + bodyLength);
      dispatch(body.toString('utf8'), 'content-length');
      continue;
    }

    // Newline-delimited JSON (handcrafted client)
    const newlineIndex = buffer.indexOf(0x0a);
    if (newlineIndex === -1) return;
    const line = buffer.subarray(0, newlineIndex).toString('utf8').trim();
    buffer = buffer.subarray(newlineIndex + 1);
    if (!line) continue;
    dispatch(line, 'ndjson');
  }
}

function dispatch(text, framing) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return; // ignore malformed JSON-RPC messages
  }
  const task = handleMessage(message, framing);
  inflight.add(task);
  const untrack = () => inflight.delete(task);
  task.then(untrack, untrack);
}

async function handleMessage(message, framing) {
  if (!message || typeof message !== 'object') return;
  // A JSON-RPC *response* (has id+result but no method) is not a request.
  if (typeof message.method !== 'string' || message.method === '') return;
  const method = message.method;
  const id = message.id;

  if (method === 'initialize') {
    const requested = message.params && typeof message.params === 'object'
      ? message.params.protocolVersion
      : undefined;
    writeResult(id, {
      // Echo the client's version when plausible; this server is version-agnostic.
      protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }, framing);
    return;
  }
  if (method.startsWith('notifications/')) {
    return;
  }
  // A method-bearing message without an id is a notification — it gets no
  // response, so there is no point executing work for it.
  if (id === undefined || id === null) return;
  if (method === 'ping') {
    writeResult(id, {}, framing);
    return;
  }
  if (method === 'tools/list') {
    writeResult(id, { tools }, framing);
    return;
  }
  if (method === 'tools/call') {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    await callTool(toolName, args, id, framing);
    return;
  }
  if (method === 'resources/list') {
    writeResult(id, { resources: [] }, framing);
    return;
  }
  if (method === 'resources/templates/list') {
    writeResult(id, { resourceTemplates: [] }, framing);
    return;
  }
  if (method === 'prompts/list') {
    writeResult(id, { prompts: [] }, framing);
    return;
  }
  writeRpcError(id, -32601, `Method not found: ${method}`, framing);
}

async function callTool(toolName, args, id, framing) {
  if (toolName !== 'web_search') {
    writeToolError(id, `unknown tool: ${toolName}`, framing);
    return;
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    writeToolError(id, 'web_search: query is required', framing);
    return;
  }
  try {
    const apiKey = await resolveApiKey({});
    const options = {};
    if (typeof args.limit === 'number' && args.limit > 0) options.limit = args.limit;
    if (typeof args.domain === 'string' && args.domain) options.domain = args.domain;
    if (typeof args.mode === 'number') options.mode = args.mode;
    const hits = await searchWindsurf(apiKey, query, options);
    writeResult(id, { content: [{ type: 'text', text: JSON.stringify({ hits }) }] }, framing);
  } catch (error) {
    writeToolError(id, error instanceof Error ? error.message : String(error), framing);
  }
}

/** MCP tool-level failure: a normal result carrying isError content. */
function writeToolError(id, message, framing) {
  writeResult(id, { isError: true, content: [{ type: 'text', text: message }] }, framing);
}

/** JSON-RPC protocol-level error (e.g. -32601 method not found). */
function writeRpcError(id, code, message, framing) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } }, framing);
}

function writeResult(id, result, framing) {
  if (id === undefined || id === null) return;
  writeMessage({ jsonrpc: '2.0', id, result }, framing);
}

function writeMessage(message, framing) {
  const body = JSON.stringify(message);
  if (framing === 'content-length') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

// Keep the event loop alive while the stdio pipes are idle.
setInterval(() => {}, 1 << 30);
