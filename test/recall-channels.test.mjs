import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Memory } from '../src/memory.mjs';
import { MemoryError } from '../src/core.mjs';

async function embeddingEndpoint(t) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ model: 'fixture', data: [{ index: 0, embedding: [1, 0] }] })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/embeddings`;
}

const index = states => async (_scope, kind) => {
  const state = states[kind];
  if (state instanceof Error) throw state;
  return state;
};

function fixture(t, url, states, indexed = { hits: [], nodes: [], omitted: [], unindexed: 0 }) {
  const ready = { status: 'ready' };
  const store = {
    lexicalStatus: async () => ready, admittedLexical: async () => ({ hits: [], omitted: [], admitted_conversations: 0, exhausted: true }),
    chunkLexicalStatus: async () => ready, chunkLexical: async () => [], lexical: async () => [],
    vectorIndexStatus: index(states),
    indexedVectors: async () => indexed,
    status: async () => ({ initialized: true }),
  };
  return new Memory({ scopes: { read: ['test'], write: [] }, embedding: { url, model: 'fixture', dimensions: 2 } }, store);
}

const quantization = new MemoryError('vector_index_quantization_mismatch');

for (const request of [{}, { group: 'conversation' }]) {
  const label = request.group ? 'grouped' : 'default';
  test(`${label} recall channels carry no vector_index and keep status and reasons`, async t => {
    const url = await embeddingEndpoint(t);
    const memory = fixture(t, url, { chunk: 'online', record: 'populating' });
    const reply = await memory.recall('test', { query: 'q', ...request });
    assert.equal(Object.values(reply.channels).some(state => Object.hasOwn(state, 'vector_index')), false);
    assert.deepEqual([reply.channels.chunk_vector.status, reply.channels.record_vector.status, reply.channels.record_vector.reason],
      ['ready', 'partial', 'vector_index_populating']);
  });

  test(`${label} recall reports an incompatible index as unavailable with its reason`, async t => {
    const url = await embeddingEndpoint(t);
    const memory = fixture(t, url, { chunk: 'online', record: quantization });
    const reply = await memory.recall('test', { query: 'q', ...request });
    assert.equal(Object.values(reply.channels).some(state => Object.hasOwn(state, 'vector_index')), false);
    assert.deepEqual([reply.channels.chunk_vector.status, reply.channels.record_vector.status, reply.channels.record_vector.reason],
      ['ready', 'unavailable', 'vector_index_quantization_mismatch']);
  });

  test(`${label} recall keeps the overfetch-cap reason on a partial online channel`, async t => {
    const url = await embeddingEndpoint(t);
    const memory = fixture(t, url, { chunk: 'online', record: 'online' },
      { hits: [], nodes: [], omitted: [], unindexed: 0, partial: true, reason: 'vector_overfetch_cap' });
    const reply = await memory.recall('test', { query: 'q', ...request });
    assert.equal(Object.values(reply.channels).some(state => Object.hasOwn(state, 'vector_index')), false);
    assert.deepEqual([reply.channels.chunk_vector.status, reply.channels.chunk_vector.reason], ['partial', 'vector_overfetch_cap']);
  });
}

test('status still reports index states and errors', async t => {
  const url = await embeddingEndpoint(t);
  const memory = fixture(t, url, { chunk: 'online', record: quantization });
  const status = await memory.status('test');
  assert.deepEqual([status.vector_indexes, status.vector_index_errors],
    [{ chunk: 'online', record: 'incompatible' }, { record: 'vector_index_quantization_mismatch' }]);
});
