import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { embed, localEndpoint, localJson, rerank } from '../src/models.mjs';
import { Memory } from '../src/memory.mjs';

async function endpoint(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/model`;
}

test('model endpoints refuse hosted text transmission', () => {
  assert.throws(() => localEndpoint('https://example.com/embeddings'), { code: 'model_endpoint_must_be_loopback' });
});

test('a remote model endpoint is accepted only with explicit opt-in', () => {
  assert.equal(localEndpoint('https://models.example/v1/embeddings', true), 'https://models.example/v1/embeddings');
});

test('deferred indexing returns without contacting the embedding endpoint', async () => {
  const store = { ingest: async () => ({ id: 'source', retained: true }), pendingEmbeddings: () => { throw new Error('indexed'); } };
  const memory = new Memory({ scopes: { write: ['test'], read: ['test'] }, index_on_write: false,
    embedding: { url: 'http://127.0.0.1:9/never', model: 'fixture', dimensions: 2 } }, store);
  const result = await memory.ingest('test', { source: 's', conversation_id: 'c', turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'x' }] });
  assert.equal(result.indexing.status, 'deferred');
});

test('a non-loopback database requires explicit opt-in', () => {
  assert.throws(() => new Memory({ neo4j: { uri: 'bolt://db.example:7687', auth: 'none' }, scopes: {} }), { code: 'database_must_be_loopback' });
});

test('model redirects do not escape the loopback boundary', async t => {
  const url = await endpoint(t, (_req, res) => res.writeHead(302, { location: 'https://example.com/' }).end());
  await assert.rejects(localJson(url, {}), { code: 'model_request_failed' });
});

test('embedding response order is restored by provider index', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify({ data: [
    { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
  ] })));
  assert.deepEqual(await embed({ url, model: 'fixture', dimensions: 2 }, ['one', 'two']), [[1, 0], [0, 1]]);
});

test('embedding identity mismatches are explicit', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify({ model: 'wrong', data: [] })));
  await assert.rejects(embed({ url, model: 'expected', dimensions: 2 }, ['one']), { code: 'embedding_model_mismatch' });
});

test('reranking cannot silently discard candidates', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] })));
  await assert.rejects(rerank({ url, model: 'fixture' }, 'query', [{ text: 'one' }, { text: 'two' }]), { code: 'invalid_rerank_response' });
});

test('failed embeddings leave an ingested source retained', async t => {
  const url = await endpoint(t, (_req, res) => res.writeHead(503).end());
  let retained = null;
  const store = {
    ingest: async (_scope, turn) => { retained = turn; return { id: 'source', retained: true }; },
    pendingEmbeddings: async () => [{ uid: 'chunk', text: 'original' }],
  };
  const memory = new Memory({ scopes: { write: ['test'], read: ['test'] }, embedding: { url, model: 'fixture', dimensions: 2 } }, store);
  const result = await memory.ingest('test', { source: 'fixture', conversation_id: 'c', turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'original' }] });
  assert.deepEqual([retained.entries[0].text, result.retained, result.indexing.status], ['original', true, 'unavailable']);
});

test('scope denial occurs before storage is accessed', async () => {
  const memory = new Memory({ scopes: { write: [], read: [] } }, { ingest: () => { throw new Error('storage touched'); } });
  await assert.rejects(memory.ingest('foreign', {}), { code: 'scope_denied' });
});

for (const method of ['evidence', 'bundle']) {
  test(`${method} denies foreign scope before touching storage`, async () => {
    const store = new Proxy({}, { get: () => { throw new Error('storage touched'); } });
    const memory = new Memory({ scopes: { read: ['allowed'], write: [] } }, store);
    const args = method === 'evidence' ? [[{ turn: 'foreign', entry_id: 'u', start: 0, end: 1 }]]
      : [{ kind: 'turn', id: 'foreign' }, 'query', 10, 2];
    await assert.rejects(memory[method]('foreign', ...args), { code: 'scope_denied' });
  });
}
