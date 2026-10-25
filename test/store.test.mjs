import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/memory.mjs';
import { Neo4jStore } from '../src/store.mjs';

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
