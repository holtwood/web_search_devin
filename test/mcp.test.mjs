import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'windsurf-search-mcp.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用 NDJSON（换行分隔）协议起一个 MCP server 子进程。 */
function spawnNdjsonServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message?.id === 'number' && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message ?? 'MCP error'));
        else resolve(message.result);
      }
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function close() {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('close', resolve));
  }
  return { child, send, close };
}

/** 用 Content-Length 帧协议起一个 MCP server 子进程。 */
function spawnContentLengthServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd);
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) return;
      const bodyLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + bodyLength) return;
      const body = buffer.slice(bodyStart, bodyStart + bodyLength);
      buffer = buffer.slice(bodyStart + bodyLength);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      if (typeof message?.id === 'number' && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message ?? 'MCP error'));
        else resolve(message.result);
      }
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  }
  async function close() {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('close', resolve));
  }
  return { child, send, close };
}

test('NDJSON: initialize returns MCP protocol handshake', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'windsurf-search-mcp-test', version: '0.0.0' },
    });
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(result.serverInfo.name, 'windsurf-search-mcp');
    assert.deepEqual(result.capabilities, { tools: {} });
  } finally {
    await server.close();
  }
});

test('NDJSON: tools/list exposes web_search with query required', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('tools/list');
    assert.equal(result.tools.length, 1);
    const tool = result.tools[0];
    assert.equal(tool.name, 'web_search');
    assert.ok(tool.description.includes('Devin/Windsurf'));
    assert.equal(tool.inputSchema.required[0], 'query');
    assert.equal(tool.inputSchema.properties.limit.maximum, 10);
  } finally {
    await server.close();
  }
});

test('NDJSON: tools/call with empty query returns isError', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('tools/call', { name: 'web_search', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /query is required/);
  } finally {
    await server.close();
  }
});

test('NDJSON: tools/call with unknown tool returns isError', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('tools/call', { name: 'nope', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unknown tool/);
  } finally {
    await server.close();
  }
});

test('NDJSON: tools/call web_search performs a real search', { skip: !process.env.WINDSURF_API_KEY && !process.env.RUN_LIVE_SEARCH }, async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('tools/call', {
      name: 'web_search',
      arguments: { query: 'tauri window drag region', limit: 2 },
    });
    assert.equal(result.isError, undefined);
    const { hits } = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].title.length > 0);
    assert.ok(hits[0].url.startsWith('http'));
    assert.equal(hits[0].source, 'windsurf');
  } finally {
    await server.close();
  }
});

test('Content-Length: initialize + tools/list handshake works', async () => {
  const server = spawnContentLengthServer();
  try {
    const init = await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'windsurf-search-mcp-test', version: '0.0.0' },
    });
    assert.equal(init.serverInfo.name, 'windsurf-search-mcp');

    const tools = await server.send('tools/list');
    assert.equal(tools.tools[0].name, 'web_search');

    const call = await server.send('tools/call', { name: 'web_search', arguments: {} });
    assert.equal(call.isError, true);
  } finally {
    await server.close();
  }
});

test('NDJSON: initialize echoes the requested protocolVersion', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'windsurf-search-mcp-test', version: '0.0.0' },
    });
    assert.equal(result.protocolVersion, '2025-03-26');
  } finally {
    await server.close();
  }
});

test('NDJSON: resources/list and prompts/list return empty collections', async () => {
  const server = spawnNdjsonServer();
  try {
    assert.deepEqual(await server.send('resources/list'), { resources: [] });
    assert.deepEqual(await server.send('resources/templates/list'), { resourceTemplates: [] });
    assert.deepEqual(await server.send('prompts/list'), { prompts: [] });
    assert.deepEqual(await server.send('ping'), {});
  } finally {
    await server.close();
  }
});

test('NDJSON: unknown method returns -32601 method-not-found', async () => {
  const server = spawnNdjsonServer();
  try {
    await assert.rejects(
      () => server.send('bogus/method'),
      /Method not found: bogus\/method/,
    );
  } finally {
    await server.close();
  }
});

test('NDJSON: a JSON-RPC response (no method) gets no reply', async () => {
  const server = spawnNdjsonServer();
  const seen = [];
  server.child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      try {
        seen.push(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  });
  try {
    server.child.stdin.write('{"jsonrpc":"2.0","id":99,"result":{}}\n');
    const reply = await server.send('tools/list');
    assert.equal(reply.tools[0].name, 'web_search');
    assert.ok(!seen.some((m) => m.id === 99), 'server replied to a response message');
  } finally {
    await server.close();
  }
});

// Regression: Content-Length counts bytes, not UTF-16 chars. A multi-byte
// (e.g. Chinese) request body used to desynchronize the parser — the message
// was silently dropped and the stream stayed corrupted until restart.
test('Content-Length: non-ASCII body is parsed and stream stays healthy', async () => {
  const noHome = await mkdtemp(join(tmpdir(), 'windsurf-mcp-nohome-'));
  const server = spawnContentLengthServer({
    HOME: noHome,
    WINDSURF_API_KEY: '',
    WINDSURFAPI_CODEIUM_API_KEY: '',
  });
  try {
    const result = await Promise.race([
      server.send('tools/call', {
        name: 'web_search',
        arguments: { query: '中文搜索测试' },
      }),
      sleep(5000).then(() => {
        throw new Error('request swallowed — byte/char desync regression');
      }),
    ]);
    // no key configured → a parsed request still answers with isError
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no API key/);

    // the stream is not poisoned: a follow-up request still gets a reply
    const tools = await server.send('tools/list');
    assert.equal(tools.tools[0].name, 'web_search');
  } finally {
    await server.close();
    await rm(noHome, { recursive: true, force: true });
  }
});

test('Content-Length: header block with Content-Type is parsed', async () => {
  const server = spawnContentLengthServer();
  let raw = '';
  server.child.stdout.setEncoding('utf8');
  server.child.stdout.on('data', (chunk) => {
    raw += chunk;
  });
  try {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }));
    server.child.stdin.write(
      Buffer.concat([
        Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n'),
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
        body,
      ]),
    );
    await sleep(300);
    assert.match(raw, /"id":99/);
  } finally {
    await server.close();
  }
});

// Regression: 'stdin end' used to exit(0) immediately, truncating responses to
// in-flight requests (async tool calls) and even queued stdout writes. A batch
// client that writes requests and closes stdin must still get every reply.
test('stdin end drains in-flight responses before exit', async () => {
  const server = spawnNdjsonServer();
  const child = server.child;
  try {
    let raw = '';
    child.stdout.on('data', (chunk) => { raw += chunk; });
    const q1 = JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list' });
    const q2 = JSON.stringify({
      jsonrpc: '2.0', id: 92, method: 'tools/call',
      params: { name: 'web_search', arguments: { query: 'drain check' } },
    });
    child.stdin.end(`${q1}\n${q2}\n`);
    await Promise.race([
      new Promise((resolve) => child.on('close', resolve)),
      sleep(8000).then(() => { throw new Error('server did not exit after stdin end'); }),
    ]);
    assert.match(raw, /"id":91/);
    assert.match(raw, /"id":92/);
  } finally {
    child.kill('SIGTERM');
  }
});

// Regression: the Content-Length header regex must be line-anchored — an
// 'X-Content-Length:' header used to match the unanchored substring and
// poison the body length, desyncing the whole stream.
test('Content-Length: X-Content-Length headers do not poison the frame length', async () => {
  const server = spawnContentLengthServer();
  let raw = '';
  server.child.stdout.setEncoding('utf8');
  server.child.stdout.on('data', (chunk) => { raw += chunk; });
  try {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'ping' }));
    const follow = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'ping' }));
    server.child.stdin.write(
      Buffer.concat([
        Buffer.from('Content-Type: application/json\r\nX-Content-Length: 999\r\n'),
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
        body,
        Buffer.from(`\r\nContent-Length: ${follow.length}\r\n\r\n`),
        follow,
      ]),
    );
    await sleep(400);
    assert.match(raw, /"id":71/);
    assert.match(raw, /"id":72/);
  } finally {
    await server.close();
  }
});
