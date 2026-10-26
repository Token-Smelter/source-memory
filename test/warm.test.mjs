import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tcp } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { warm, WARM_INPUT } from '../src/warm.mjs';
import { embeddingIdentity } from '../src/models.mjs';

const BIN = fileURLToPath(new URL('../bin/memory.mjs', import.meta.url));

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return server.address().port;
}

// handler overrides the default valid response; a no-op handler never answers.
async function fake(t, handler) {
  const requests = [];
  const port = await listen(t, createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (handler) handler(req, res);
    else res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  }));
  return { requests, url: `http://127.0.0.1:${port}/v1/embeddings` };
}

const config = embedding => ({ scopes: { read: ['s'], write: [] }, ...(embedding && { embedding }) });
const run = args => new Promise(resolve => execFile(process.execPath, [BIN, ...args], { timeout: 15000 },
  (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));

test('warm sends exactly one request with the constant input', async t => {
  const { requests, url } = await fake(t);
  const embedding = { url, model: 'fixture', dimensions: 2 };
  const result = await warm(config(embedding), 's');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { model: 'fixture', input: [WARM_INPUT] });
  assert.equal(WARM_INPUT, 'source-memory warm');
  assert.equal(result.warm.model, 'fixture');
  assert.equal(result.warm.embedding_key, embeddingIdentity(embedding));
  assert.ok(Number.isInteger(result.warm.ms) && result.warm.ms >= 0);
});

test('warm needs read authorization for the scope', async t => {
  const { requests, url } = await fake(t);
  await assert.rejects(warm(config({ url, model: 'fixture', dimensions: 2 }), 'other'), { code: 'scope_denied' });
  assert.equal(requests.length, 0);
});

test('unconfigured embedding makes no request', async () => {
  assert.deepEqual(await warm(config(), 's'), { warm: { status: 'unconfigured' } });
});

test('the configured timeout is honored', async t => {
  const { url } = await fake(t, () => {});
  const started = Date.now();
  await assert.rejects(warm(config({ url, model: 'fixture', dimensions: 2, timeout_ms: 100 }), 's'), { code: 'model_timeout' });
  assert.ok(Date.now() - started < 5000);
});

test('an endpoint error is model_request_failed', async t => {
  const { url } = await fake(t, (_req, res) => res.writeHead(503).end());
  await assert.rejects(warm(config({ url, model: 'fixture', dimensions: 2 }), 's'), { code: 'model_request_failed' });
});

test('a remote URL is refused unless allow_remote', async () => {
  const embedding = { url: 'https://models.example/v1/embeddings', model: 'fixture', dimensions: 2 };
  await assert.rejects(warm(config(embedding), 's'), { code: 'model_endpoint_must_be_loopback' });
});

test('CLI warm never constructs the store or connects to Neo4j', async t => {
  const { requests, url } = await fake(t);
  let connections = 0;
  const dbPort = await listen(t, tcp(socket => { connections += 1; socket.destroy(); }));
  const dir = await mkdtemp(join(tmpdir(), 'warm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const embedding = { url, model: 'fixture', dimensions: 2 };
  // Without a neo4j section, constructing Neo4jStore would throw; with one, it would dial the counter.
  for (const [name, neo4j] of [['with-db', { uri: `bolt://127.0.0.1:${dbPort}`, auth: 'none' }], ['no-db', undefined]]) {
    const path = join(dir, `${name}.json`);
    await writeFile(path, JSON.stringify({ ...config(embedding), ...(neo4j && { neo4j }) }));
    const { code, stdout } = await run(['warm', '--config', path, '--scope', 's']);
    assert.equal(code, 0, name);
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.warm.model, 'fixture');
  }
  assert.equal(requests.length, 2);
  assert.equal(connections, 0);
});

test('CLI warm reports unconfigured and error codes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'warm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'c.json');
  await writeFile(path, JSON.stringify(config()));
  assert.deepEqual(JSON.parse((await run(['warm', '--config', path, '--scope', 's'])).stdout), { ok: true, warm: { status: 'unconfigured' } });
  const denied = await run(['warm', '--config', path, '--scope', 'x']);
  assert.equal(denied.code, 1);
  assert.deepEqual(JSON.parse(denied.stderr), { ok: false, error: 'scope_denied' });
});
