import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/memory.mjs';
import { Neo4jStore } from '../src/store.mjs';
import { indexNames, namespace } from '../src/core.mjs';

test('init waits only for scope full-text indexes and returns native population states without waiting', async () => {
  const waited = [];
  const store = Object.assign(Object.create(Neo4jStore.prototype), {
    vectorIndexStatus: async () => 'populating',
    transaction: async (_mode, action) => action({ run: async (query, params) => {
      if (query.includes('db.await')) waited.push([query, params?.index]);
      return { records: [] };
    } }),
  });
  const result = await store.init('test', 3);
  const names = indexNames('test');
  assert.deepEqual([waited, result], [
    [names.turns, names.records, names.chunks].map(name => ['CALL db.awaitIndex($index,30)', name]),
    { initialized: true, scope: 'test', vector_indexes: { chunk: 'populating', record: 'populating' } },
  ]);
});

test('vector index dimensions cannot silently disagree with configuration', async () => {
  const store = Object.assign(Object.create(Neo4jStore.prototype), {
    transaction: async (_mode, action) => action({ run: async () => ({ records: [{ toObject: () => ({
      type: 'VECTOR', state: 'ONLINE', labelsOrTypes: [`${namespace('test')}Chunk`], properties: ['embedding'],
      options: { indexConfig: { 'vector.dimensions': 4, 'vector.similarity_function': 'cosine' } },
    }) }] }) }),
  });
  await assert.rejects(store.vectorIndexStatus('test', 'chunk', 3), { code: 'vector_index_dimension_mismatch' });
});

for (const capped of [false, true]) {
  test(`native vector queries ${capped ? 'report partial at the widening cap' : 'widen until eligible hits survive'}`, async () => {
    const requests = [];
    const store = Object.assign(Object.create(Neo4jStore.prototype), {
      transaction: async (_mode, action) => action({ run: async (_query, params) => {
        const k = params.k.toNumber();
        requests.push(k);
        return { records: [{ get: name => name === 'raw_count' ? capped || k === 64 ? k : 1
          : capped || k === 64 ? [] : [{ node: { properties: { uid: 'eligible', scope: 'test' } }, score: 0.75 }] }] };
      } }),
    });
    const result = await store.indexedVectors('test', 'chunk', 'model', [1, 0, 1], 1);
    assert.deepEqual([requests, result.partial, result.reason, result.nodes.map(row => row.similarity)], capped
      ? [[64, 128, 256, 512, 1024, 2048, 4096], true, 'vector_overfetch_cap', []]
      : [[64, 128], false, undefined, [0.5]]);
  });
}

for (const [state, expected, calls] of [
  ['ONLINE', { status: 'ready' }, 1],
  ['POPULATING', { status: 'pending' }, 0],
  ['FAILED', { status: 'unavailable', reason: 'chunk_index_failed' }, 0],
  [null, { status: 'unavailable', reason: 'chunk_index_missing' }, 0],
]) {
  test(`chunk lexical ${state ?? 'missing'} readiness controls availability and queries`, async () => {
    let queried = 0;
    const store = Object.assign(Object.create(Neo4jStore.prototype), {
      transaction: async (_mode, action) => action({ run: async () => ({ records: state ? [{ get: () => state }] : [] }) }),
      lexical: async () => [],
      chunkLexical: async () => { queried += 1; return []; },
    });
    const memory = new Memory({ scopes: { read: ['test'] } }, store);
    const recalled = await memory.recall('test', { query: 'needle' });
    assert.deepEqual([recalled.channels.chunk_lexical, queried, recalled.bundles, recalled.retrieval_complete], [expected, calls, [], false]);
  });
}
