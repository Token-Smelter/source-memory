import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const load = () => import('../pi-extension/bridge-harness.mjs');

test('a connected pilot target stops before init, and owned resources are cleaned by exact IDs', async () => {
  const { runHarness } = await load();
  const actions = [];
  const docker = { async createNetwork() { actions.push('network'); return 'net-owned'; },
    async createDatabase() { actions.push('database'); return 'db-owned'; }, async createDriver() { actions.push('driver'); return 'driver-owned'; },
    async removeContainer(id) { actions.push(`remove:${id}`); }, async removeNetwork(id) { actions.push(`remove:${id}`); } };
  const relay = { async open() { actions.push('relay'); return { async close() { actions.push('relay-close'); } }; } };
  const result = await runHarness({ docker, relay, isolation: async () => ({ ok: false, targets: [{ outcome: 'connected' }] }),
    memory: { async init() { actions.push('init'); } }, sessions: [], cases: [] });
  assert.deepEqual([result.status, actions.includes('init'), actions.slice(-3)], ['isolation_failed', false, ['remove:driver-owned', 'remove:db-owned', 'remove:net-owned']]);
});

test('bridge harness replays the shared cursor core then recalls with only asker exclusion', async () => {
  const { runHarness } = await load();
  const calls = [];
  const docker = { async createNetwork() { return 'net'; }, async createDatabase() { return 'db'; }, async createDriver() { return 'driver'; }, async removeContainer() {}, async removeNetwork() {} };
  const memory = { async init() { calls.push('init'); }, async ingest(_scope, turn) { calls.push(turn.source); return { id: 'turn' }; },
    async recall(_scope, input) { calls.push(input.exclude_conversations); return { status: 'ready', bundles: [] }; } };
  const session = { entries: [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'fiction' } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: 'done', stopReason: 'stop' } }],
    conversation_id: 'fiction', scopes: ['private'], memory, distiller: { async run() { return { status: 'complete' }; } } };
  const result = await runHarness({ docker, relay: { async open() { return { async close() {} }; } }, isolation: async () => ({ ok: true, targets: [{ host: '127.0.0.1', port: 27690, outcome: 'error' },
    { host: '172.30.0.1', port: 27690, outcome: 'error' }, { host: '172.17.0.2', port: 27690, outcome: 'timeout' }] }),
    memory, sessions: [{ session, leaves: ['a'] }], cases: [{ id: 'case', query: 'fiction', asker_conversation_id: 'asker', evidence_not_ingestable: true }] });
  assert.deepEqual([result.status, calls, result.cases[0].evidence_not_ingestable],
    ['complete', ['init', 'pi-memory', [{ source: 'pi-memory', conversation_id: 'asker' }]], true]);
});

test('isolation checks loopback, bridge gateway and all enumerated pilot addresses', async () => {
  const { verifyPilotIsolation } = await load();
  const tested = [];
  const result = await verifyPilotIsolation({ gateway: '172.30.0.1', pilotIps: ['172.17.0.8', '172.18.0.9'],
    connect: async (host, port) => { tested.push([host, port]); return host === '172.18.0.9' ? 'connected' : 'timeout'; } });
  assert.deepEqual([result.ok, tested], [false, [['127.0.0.1', 27690], ['172.30.0.1', 27690], ['172.17.0.8', 27690], ['172.18.0.9', 27690]]]);
});

test('embedding relay binds only the supplied bridge gateway, never a wildcard', async () => {
  const { openEmbeddingRelay } = await load();
  const bindings = [];
  const serverFactory = () => {
    const server = new EventEmitter();
    server.listen = (options, callback) => { bindings.push(options); callback(); };
    server.close = callback => callback();
    return server;
  };
  await assert.rejects(openEmbeddingRelay({ gateway: '0.0.0.0', port: 17688, serverFactory }), /gateway_invalid/);
  const relay = await openEmbeddingRelay({ gateway: '172.30.0.1', port: 17688, serverFactory });
  await relay.close();
  assert.deepEqual(bindings, [{ host: '172.30.0.1', port: 17688 }]);
});

test('embedding relay refuses a different route without calling upstream', async () => {
  const { createEmbeddingHandler } = await load();
  let called = false;
  const handler = createEmbeddingHandler({ fetchFn: async () => { called = true; } });
  const request = Readable.from([]); request.method = 'POST'; request.url = '/other';
  const response = new EventEmitter(); response.writeHead = status => { response.status = status; }; response.end = () => {};
  await handler(request, response);
  assert.deepEqual([response.status, called], [404, false]);
});

test('embedding relay forwards only the exact POST path and never forwards caller credentials', async () => {
  const { createEmbeddingHandler } = await load();
  const calls = [];
  const handler = createEmbeddingHandler({ fetchFn: async (url, options) => { calls.push({ url, options }); return new Response('{"data":[]}'); } });
  const request = Readable.from(['{"model":"fiction","input":["x"]}']);
  request.method = 'POST'; request.url = '/v1/embeddings'; request.headers = { authorization: 'fictional-secret' };
  const response = new EventEmitter(); response.writeHead = status => { response.status = status; }; response.end = text => { response.body = text; };
  await handler(request, response);
  assert.deepEqual([response.status, calls[0].url, calls[0].options.headers], [200, 'http://127.0.0.1:11434/v1/embeddings', { 'content-type': 'application/json' }]);
});
