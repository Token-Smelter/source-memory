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
    pendingEmbeddings: async () => [{ uid: 'chunk', chunk: true }],
    observeEmbeddings: async () => [{ uid: 'chunk', chunk: true, eligible: true, text: 'original', observed: { text: 'original' } }],
  };
  const memory = new Memory({ scopes: { write: ['test'], read: ['test'] }, embedding: { url, model: 'fixture', dimensions: 2 } }, store);
  const result = await memory.ingest('test', { source: 'fixture', conversation_id: 'c', turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'original' }] });
  assert.deepEqual([retained.entries[0].text, result.retained, result.indexing.status], ['original', true, 'unavailable']);
});

test('a failed batch defers its members and later runs can index healthy rows', async t => {
  const calls = [];
  const url = await endpoint(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { input } = JSON.parse(body);
    calls.push(input);
    if (input.includes('poison')) res.writeHead(503).end();
    else res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  let now = 0;
  const rows = new Map(Array.from({ length: 17 }, (_, i) => [i, { uid: i, text: i === 0 ? 'poison' : `healthy-${i}` }]));
  const store = {
    async pendingEmbeddings(scope, _key, limit) {
      assert.equal(scope, 'test');
      return [...rows.values()].map(row => ({ uid: row.uid, isolated: Boolean(row.isolated), single: Boolean(row.single), cooling: row.after > now }))
        .sort((a, b) => a.cooling - b.cooling || a.isolated - b.isolated || a.single - b.single || a.uid - b.uid).slice(0, limit);
    },
    async observeEmbeddings(_scope, _key, uids) {
      return uids.filter(uid => rows.has(uid)).map(uid => {
        const row = rows.get(uid);
        return { uid, chunk: true, eligible: true, text: row.text, observed: { text: row.text },
          isolated: Boolean(row.isolated), single: Boolean(row.single), cooling: row.after > now };
      });
    },
    async deferEmbeddings(_scope, _key, deferred, seconds, single) {
      for (const { uid } of deferred) Object.assign(rows.get(uid), { isolated: true, single, after: now + seconds });
      return { applied: deferred.length, refused: 0, uncertain: false };
    },
    async saveEmbeddings(_scope, _key, saved) {
      for (const row of saved) rows.delete(row.uid);
      return { applied: saved.length, refused: 0, uncertain: false };
    },
  };
  const open = () => new Memory({ scopes: { write: ['test'] }, embedding: { url, model: 'fixture', dimensions: 2 } }, store);
  assert.equal((await open().index('test', { limit: 16 })).reason, 'model_request_failed');
  assert.equal(calls.length, 1, 'do not recurse on a slow batch');
  assert.equal((await open().index('test', { limit: 16 })).reason, 'embedding_retry_deferred');
  assert.deepEqual(calls.at(-1), ['healthy-16']);
  now = 61;
  assert.equal((await open().index('test', { limit: 16 })).reason, 'model_request_failed');
  assert.deepEqual(calls.at(-1), ['poison', 'healthy-1', 'healthy-2', 'healthy-3']);
  assert.equal((await open().index('test', { limit: 16 })).indexed, 4);
  assert.deepEqual(calls.at(-1), ['healthy-4', 'healthy-5', 'healthy-6', 'healthy-7']);
  now = 122;
  // Drain the remaining small-group retries before retrying the isolated poison item.
  for (let i = 0; i < 2; i++) assert.equal((await open().index('test', { limit: 16 })).indexed, 4);
  assert.equal((await open().index('test', { limit: 16 })).reason, 'model_request_failed');
  assert.deepEqual(calls.at(-1), ['poison']);
  assert.equal(rows.get(0).after, now + 300, 'a singleton request failure may be an outage, not a poison row');
  assert.equal((await open().index('test', { limit: 16 })).indexed, 1);
  assert.deepEqual(calls.at(-1), ['healthy-1']);
  assert.ok(rows.has(0), 'a deferred item is not indexed or deleted');
});

test('only confirmed embedding writes count as progress and refused or uncertain writes never yield ready', async t => {
  const url = await endpoint(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.end(JSON.stringify({ data: JSON.parse(body).input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  const run = async outcome => {
    const store = {
      async pendingEmbeddings() { return [{ uid: 'a', chunk: true }, { uid: 'b', chunk: true }]; },
      async observeEmbeddings(_scope, _key, uids) {
        return uids.map(uid => ({ uid, chunk: true, eligible: true, text: { a: 'one', b: 'two' }[uid], observed: { text: { a: 'one', b: 'two' }[uid] } }));
      },
      async markOversizedChunks() { assert.fail('no oversized rows'); },
      async status() { return { unindexed: 0, unembeddable: 0 }; },
      async saveEmbeddings(_scope, _key, rows) {
        assert.deepEqual(rows.map(row => [row.uid, row.observed.text]), [['a', 'one'], ['b', 'two']], 'writes carry the observed state');
        return outcome;
      },
    };
    return new Memory({ scopes: { write: ['test'] }, embedding: { url, model: 'fixture', dimensions: 2 } }, store).index('test');
  };
  const ready = await run({ applied: 2, refused: 0, uncertain: false });
  assert.deepEqual([ready.status, ready.indexed, ready.stale, ready.unknown], ['ready', 2, undefined, undefined]);
  const stale = await run({ applied: 1, refused: 1, uncertain: false });
  assert.deepEqual([stale.status, stale.indexed, stale.stale, stale.unknown], ['pending', 1, 1, undefined]);
  const unknown = await run({ applied: 0, refused: 2, uncertain: true });
  assert.deepEqual([unknown.status, unknown.indexed, unknown.stale, unknown.unknown], ['pending', 0, undefined, 2]);
  for (const invalid of [undefined, {}, { applied: 3, refused: -1 }, { applied: 1, refused: 0 }]) {
    assert.deepEqual(await run(invalid), { status: 'unavailable', reason: 'embedding_accounting_invalid', source_retained: true });
  }
});

test('scope denial occurs before storage is accessed', async () => {
  const memory = new Memory({ scopes: { write: [], read: [] } }, { ingest: () => { throw new Error('storage touched'); } });
  await assert.rejects(memory.ingest('foreign', {}), { code: 'scope_denied' });
});

for (const method of ['evidence', 'bundle', 'showBundle']) {
  test(`${method} denies foreign scope before touching storage`, async () => {
    const store = new Proxy({}, { get: () => { throw new Error('storage touched'); } });
    const memory = new Memory({ scopes: { read: ['allowed'], write: [] } }, store);
    const args = method === 'evidence' ? [[{ turn: 'foreign', entry_id: 'u', start: 0, end: 1 }]]
      : method === 'showBundle' ? [{ seed: { kind: 'record', id: 'foreign' } }]
        : [{ kind: 'turn', id: 'foreign' }, 'query', 10, 2];
    await assert.rejects(memory[method]('foreign', ...args), { code: 'scope_denied' });
  });
}
