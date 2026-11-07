import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDerived } from '../pi-extension/derived-retrieval.mjs';

const base = () => ({ config: { scopes: { read: ['fiction'] }, embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'fiction', dimensions: 2 } },
  store: { async lexicalStatus() { return { status: 'ready' }; }, async lexical() { return []; } },
  async bundle() { return { records: [{ id: 'record', kind: 'observation', text: 'Fiction', status: 'proposed', attribution: 'fiction', supporting_evidence: [] }],
    relations: [], relationship_context_complete: true }; } });

test('missing record vector index falls back to the record-only cosine scan', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'fiction', data: [{ index: 0, embedding: [1, 0] }] }));
  try {
    const memory = base();
    memory.store.vectorIndexStatus = async () => 'missing';
    memory.store.vectorCounts = async () => ({ unindexed: 0 });
    memory.store.vectors = async (_scope, _key, _limit, _exclude, kind) => {
      assert.equal(kind, 'record'); return [{ uid: 'u', record_id: 'record', text: 'Fiction', embedding: [1, 0] }];
    };
    const rows = await searchDerived(memory, 'fiction', { query: 'fiction', limit: 1 });
    assert.equal(rows[0].id, 'record');
  } finally { globalThis.fetch = originalFetch; }
});

test('partial record-vector availability is an explicit failure rather than lexical-only success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'fiction', data: [{ index: 0, embedding: [1, 0] }] }));
  try {
    const memory = base();
    memory.store.vectorIndexStatus = async () => 'online';
    memory.store.indexedVectors = async () => ({ nodes: [], partial: true, unindexed: 0 });
    await assert.rejects(searchDerived(memory, 'fiction', { query: 'fiction', limit: 1 }), /search_incomplete/);
  } finally { globalThis.fetch = originalFetch; }
});
