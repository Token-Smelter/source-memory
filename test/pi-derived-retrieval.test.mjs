import test from 'node:test';
import assert from 'node:assert/strict';
import { createDerivedAdapter, resolveDerived, searchCombined, searchDerived, searchRaw } from '../pi-extension/derived-retrieval.mjs';

const span = { turn: 'turn', entry_id: 'entry', start: 0, end: 15, text: 'fictional proof' };
const bundle = { records: [{ id: 'record', kind: 'decision', text: 'Fictional decision', status: 'proposed', attribution: 'fiction', supporting_evidence: [span] }],
  relations: [{ id: 'edge', type: 'qualifies', from: 'record', to: 'prior', attribution: 'fiction', supporting_evidence: [span] }], relationship_context_complete: true };

test('primary retrieval fuses record lexical and vector seeds without raw channels, withholding evidence until resolution', async () => {
  const kinds = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'fiction', data: [{ index: 0, embedding: [1, 0] }] }));
  try {
    const memory = { config: { scopes: { read: ['fiction'] }, embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'fiction', dimensions: 2 } },
      store: { async lexicalStatus(_scope, kind) { kinds.push(`status:${kind}`); return { status: 'ready' }; },
        async lexical(_scope, kind) { kinds.push(`search:${kind}`); return []; },
        async vectorIndexStatus(_scope, kind) { kinds.push(`vector-status:${kind}`); return 'online'; },
        async indexedVectors(_scope, kind) { kinds.push(`vector-search:${kind}`); return { nodes: [{ record_id: 'record', text: 'Fictional decision' }], partial: false, unindexed: 0 }; } },
      async bundle() { return bundle; }, async show() { return { bundle }; } };
    const rows = await searchDerived(memory, 'fiction', { query: 'decision', limit: 8 });
    const evidence = await resolveDerived(memory, 'fiction', { item_id: 'record', evidence_id: rows[0].evidence[0].id });
    assert.deepEqual([kinds, rows[0].text.includes('fictional proof'), evidence.text, JSON.parse(rows[0].text).links[0].type],
      [['status:record', 'search:record', 'vector-status:record', 'vector-search:record'], false, 'fictional proof', 'qualifies']);
  } finally { globalThis.fetch = originalFetch; }
});

test('raw-only diagnostic seeds from turn and chunk lexical channels, not derived records', async () => {
  const kinds = [];
  const memory = { config: { scopes: { read: ['fiction'] } }, store: {
    async lexicalStatus(_scope, kind) { kinds.push(`status:${kind}`); return { status: 'ready' }; },
    async chunkLexicalStatus() { kinds.push('status:chunk'); return { status: 'ready' }; },
    async lexical(_scope, kind) { kinds.push(`search:${kind}`); return [{ kind: 'turn', id: 'turn' }]; },
    async chunkLexical() { kinds.push('search:chunk'); return []; } },
  async bundle() { return { source: { excerpts: [{ text: 'fictional raw source' }] } }; } };
  const rows = await searchRaw(memory, 'fiction', { query: 'fiction', limit: 1 });
  assert.deepEqual([kinds, rows], [['status:turn', 'status:chunk', 'search:turn', 'search:chunk'],
    [{ id: 'turn', scope: 'fiction', text: 'fictional raw source' }]]);
});

test('combined recall keeps product ranking, projecting records as derived items and turns as source excerpts', async () => {
  const ready = { status: 'ready' };
  const channels = { turn_lexical: ready, record_lexical: ready, chunk_lexical: ready, chunk_vector: ready, record_vector: ready, reranker: { status: 'unconfigured' } };
  const memory = (channels, lexical = 'ready', ranked = [{ kind: 'turn', id: 'turn' }, { kind: 'record', id: 'record' }]) => ({ config: { scopes: { read: ['fiction'] } },
    store: { async lexicalStatus() { return { status: lexical }; }, async chunkLexicalStatus() { return { status: 'ready' }; } },
    async recall(scope, input, options) { assert.equal(options.seedsOnly, true);
      return { scope, channels, ranked: ranked.slice(0, input.candidates) }; },
    async bundle(_scope, seed) { return seed.kind === 'turn' ? { source: { excerpts: [{ text: 'fictional raw source' }] } } : bundle; } });
  const rows = await searchCombined(memory(channels), 'fiction', { query: 'fiction', limit: 2 });
  assert.deepEqual([rows.map(row => [row.id, row.kind ?? 'derived']), rows[0].text, rows[1].text.includes('fictional proof'), rows[1].evidence.length],
    [[['turn', 'source_excerpt'], ['record', 'derived']], 'fictional raw source', false, 1]);
  const chunks = await searchCombined(memory(channels), 'fiction', { query: 'fiction', limit: 2, records: false });
  assert.deepEqual(chunks.map(row => row.kind), ['source_excerpt']);
  await assert.rejects(searchCombined(memory({ ...channels, chunk_vector: { status: 'partial' } }), 'fiction', { query: 'fiction' }), /search_incomplete/);
  await assert.rejects(searchCombined(memory(channels, 'populating'), 'fiction', { query: 'fiction' }), /search_incomplete/);
  const crowded = Array.from({ length: 256 }, (_, i) => ({ kind: 'record', id: `r${i}` }));
  await assert.rejects(searchCombined(memory(channels, 'ready', crowded), 'fiction', { query: 'fiction', limit: 2, records: false }), /search_incomplete/);
});

test('derived evidence resolution rejects an unoffered source handle', async () => {
  const memory = { config: { scopes: { read: ['fiction'] } }, async show() { return { bundle }; } };
  await assert.rejects(resolveDerived(memory, 'fiction', { item_id: 'record', evidence_id: 'not-offered' }), /evidence_not_offered/);
});

test('answerer adapter refuses an unverified snapshot or inaccessible store scope', async () => {
  let calls = 0;
  const adapter = createDerivedAdapter({ stores: { candidate: { scope: 'private', snapshotId: 'snapshot', authorize: async () => true, verifySnapshot: async () => false,
    client: { async searchDerived() { calls++; } } } } });
  await assert.rejects(adapter.search({ storeId: 'candidate', query: 'fiction', queryTime: '2026-01-01T00:00:00Z', readScopes: ['private'], evidenceScopes: ['private'], limit: 8 }), /snapshot_unverified/);
  await assert.rejects(adapter.search({ storeId: 'candidate', query: 'fiction', queryTime: '2026-01-01T00:00:00Z', readScopes: ['other'], evidenceScopes: ['private'], limit: 8 }), /scope_unresolved/);
  assert.equal(calls, 0);
});
