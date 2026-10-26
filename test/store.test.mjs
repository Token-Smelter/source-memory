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

for (const quantization of [true, undefined]) {
  test(`quantization ${String(quantization)} is refused instead of silently reusing an incompatible vector index`, async () => {
    const store = Object.assign(Object.create(Neo4jStore.prototype), {
      transaction: async (_mode, action) => action({ run: async () => ({ records: [{ toObject: () => ({
        type: 'VECTOR', state: 'ONLINE', labelsOrTypes: [`${namespace('test')}Chunk`], properties: ['embedding'],
        options: { indexConfig: { 'vector.dimensions': 3, 'vector.similarity_function': 'cosine', 'vector.quantization.enabled': quantization } },
      }) }] }) }),
    });
    await assert.rejects(store.vectorIndexStatus('test', 'chunk', 3), { code: 'vector_index_quantization_mismatch' });
  });
}

test('short approximate returns keep widening without independent completeness evidence', async () => {
  const requests = [];
  const store = Object.assign(Object.create(Neo4jStore.prototype), {
    vectorCounts: async () => ({ total: 2, unindexed: 0 }),
    transaction: async (_mode, action) => action({ run: async (_query, params) => {
      requests.push(params.k.toNumber());
      return { records: [{ get: name => name === 'rows' ? [] : 0 }] };
    } }),
  });
  const result = await store.indexedVectors('test', 'chunk', 'model', [1, 0, 1], 1);
  assert.deepEqual([requests, result.partial, result.reason], [[64, 128, 256, 512, 1024, 2048, 4096], true, 'vector_overfetch_cap']);
});

test('grouped admission may complete a short result only when its window considered the entire eligible census', async () => {
  const store = Object.assign(Object.create(Neo4jStore.prototype), {
    vectorCounts: async () => ({ total: 2, unindexed: 0 }),
    admission: async () => ({ hits: [{ id: 'one-parent' }], raw_count: 2, considered: 2 }),
  });
  const result = await store.indexedVectors('test', 'chunk', 'model', [1, 0, 1], 4, 1);
  assert.deepEqual([result.hits.length, result.partial, result.rounds], [1, false, 1]);
});

test('a shared round budget bounds multiple native queries and reports an unexecuted channel without admission counters', async () => {
  const requests = [];
  const store = Object.assign(Object.create(Neo4jStore.prototype), {
    vectorCounts: async () => ({ total: 2, unindexed: 0 }),
    transaction: async (_mode, action) => action({ run: async (_query, params) => {
      requests.push(params.k.toNumber());
      return { records: [{ get: name => name === 'rows' ? [] : 0 }] };
    } }),
  });
  const budget = { remaining: 2 };
  const first = await store.indexedVectors('test', 'chunk', 'model', [1, 0, 1], 1, null, [], budget);
  const second = await store.indexedVectors('test', 'record', 'model', [1, 0, 1], 1, null, [], budget);
  assert.deepEqual([requests, first.reason, first.rounds, first.ran, second.reason, second.rounds, second.ran, budget.remaining],
    [[64, 128], 'vector_query_budget', 2, true, 'vector_query_budget', 0, false, 0]);
});

for (const capped of [false, true]) {
  test(`native vector queries ${capped ? 'report partial at the widening cap' : 'widen until eligible hits survive'}`, async () => {
    const requests = [];
    const store = Object.assign(Object.create(Neo4jStore.prototype), {
      vectorCounts: async () => ({ total: 1, unindexed: 0 }),
      transaction: async (_mode, action) => action({ run: async (_query, params) => {
        const k = params.k.toNumber();
        requests.push(k);
        return { records: [{ get: name => name === 'raw_count' ? capped || k === 64 ? k : 1
          : name === 'considered' ? capped || k === 64 ? 0 : 1
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
