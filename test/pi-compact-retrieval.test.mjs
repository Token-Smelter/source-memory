import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryHandlers } from '../pi-extension/memory-process.mjs';
import { createTurnTools } from '../pi-extension/core.mjs';

function fixture({ count = 40, partial = false, linkModule, longIds = false, allActions = false } = {}) {
  const reads = [], rows = Array.from({ length: count }, (_, i) => ({ id: longIds ? `pi-memory-record-${String(i).padStart(64, '0')}` : `prior-${i}`, scope: 'fiction',
    kind: allActions || i === 0 ? 'action' : 'observation', status: 'proposed', text: `Prior ${i}: ${'🌿'.repeat(600)}`,
    attribution: 'fiction', evidence: [{ turn: `source-${i}`, entry_id: 'entry', start: 0, end: 7 }] }));
  const nodes = rows.map(row => ({ uid: `uid-${row.id}`, record_id: row.id, text: row.text, similarity: 1 }));
  const memory = { config: { scopes: { read: ['fiction'], write: ['fiction'] },
    embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'fiction', dimensions: 2 } },
    store: {
      async lexicalStatus() { return { status: 'ready' }; },
      async lexical(_scope, kind) { assert.equal(kind, 'record'); return rows.map(row => ({ kind: 'record', id: row.id, text: row.text })); },
      async vectorIndexStatus() { return 'online'; },
      async indexedVectors() { return { nodes, unindexed: 0, partial }; },
      async getRecords(_scope, ids) { return ids.map(id => rows.find(row => row.id === id)).filter(Boolean); },
      async neighbors(_scope, ids) { reads.push(['neighbors', ids[0]]); return []; },
    },
    async show(_scope, input) {
      if (input.kind === 'turn') return { kind: 'turn', turn: { id: input.id, source: 'pi-memory' } };
      reads.push(['record', input.id]);
      return { kind: 'record', record: rows.find(row => row.id === input.id), evidence: [{ text: `private evidence for ${input.id}` }] };
    } };
  const handlers = createMemoryHandlers({ memory, scopes: ['fiction'], ...(linkModule ? { linkModule } : {}) });
  return { handlers, reads };
}

async function withEmbedding(action) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'fiction', data: [{ index: 0, embedding: [1, 0] }] }));
  try { await action(); } finally { globalThis.fetch = original; }
}

const input = { query: 'fiction', kinds: [], limit: 64, max_bytes: 24000 };

test('compact search fits many records without fetching unselected evidence and scopes each handle', async () => withEmbedding(async () => {
  const { handlers, reads } = fixture();
  try {
    const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([result.status, result.records.length, result.budget_omitted, reads.length], ['ready', 40, 0, 0]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24000);
    assert.ok(result.records.every(row => Buffer.byteLength(row.text) <= 80 && row.text_truncated && !Object.hasOwn(row, 'status')));
    assert.ok(result.records.find(row => row.id === 'prior-0').action_handle);
    assert.ok(!JSON.stringify(result).includes('private evidence'));
    const chosen = result.records[1];
    const full = await handlers.fetchCompact({ scope: 'fiction', trigger: 'turn', handle: chosen.handle });
    assert.deepEqual([full.record.id, reads, full.relationship_context_complete],
      [chosen.id, [['record', chosen.id], ['neighbors', chosen.id]], true]);
    await assert.rejects(handlers.fetchCompact({ scope: 'fiction', trigger: 'other', handle: chosen.handle }), /handle_not_offered/);
    await assert.rejects(handlers.fetchCompact({ scope: 'other', trigger: 'turn', handle: chosen.handle }), /scope_denied/);
    await handlers.releaseCompact({ scope: 'fiction', trigger: 'turn' });
    await assert.rejects(handlers.fetchCompact({ scope: 'fiction', trigger: 'turn', handle: chosen.handle }), /handle_not_offered/);
  } finally { handlers.close(); }
}));

test('64 action cards with long ids and multibyte previews fit the unchanged search budget', async () => withEmbedding(async () => {
  const { handlers } = fixture({ count: 64, longIds: true, allActions: true });
  try {
    const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([result.status, result.records.length, result.budget_omitted], ['ready', 64, 0]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24000);
  } finally { handlers.close(); }
}));

test('a kind filter applied after a saturated channel is disclosed and invalidates evaluation completeness', async () => withEmbedding(async () => {
  const { handlers } = fixture({ count: 64 });
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' },
    memory: { searchCompact: (scope, request, trigger) => handlers.searchCompact({ scope, input: request, trigger }) } });
  try {
    const result = await tools.search('fiction', ['observation']);
    assert.deepEqual([result.records.length, result.filter_may_be_incomplete, tools.stats().incomplete_search], [63, true, true]);
  } finally { handlers.close(); }
}));

test('a tight budget reports exact whole-card omissions without revealing omitted handles', async () => withEmbedding(async () => {
  const { handlers } = fixture({ count: 8 });
  try {
    const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input: { ...input, max_bytes: 1200 } });
    assert.equal(result.status, 'budget_limited');
    assert.equal(result.records.length + result.budget_omitted, 8);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1200);
  } finally { handlers.close(); }
}));

test('a partial vector channel cannot be presented as a successful compact search', async () => withEmbedding(async () => {
  const { handlers } = fixture({ partial: true });
  try { await assert.rejects(handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input }), /search_incomplete/); }
  finally { handlers.close(); }
}));

test('link offers admit only selected handles from the same trigger', async () => withEmbedding(async () => {
  let selected;
  const linkModule = { async proposeMemoryLinks({ candidate_record_ids, compare }) {
    selected = candidate_record_ids;
    await compare({ packet: { records: [], sources: [] } });
    return {};
  } };
  const { handlers } = fixture({ count: 3, linkModule });
  try {
    const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    const chosen = result.records[1];
    await assert.rejects(handlers.beginLinks({ scope: 'fiction', turn: 'other', record_ids: ['new'],
      candidate_handles: [chosen.handle], review_contract: 'fiction' }), /handle_not_offered/);
    await assert.rejects(handlers.beginLinks({ scope: 'fiction', turn: 'turn', record_ids: ['new'],
      candidate_handles: ['forged'], review_contract: 'fiction' }), /handle_not_offered/);
    const offer = await handlers.beginLinks({ scope: 'fiction', turn: 'turn', record_ids: ['new'],
      candidate_handles: [chosen.handle], review_contract: 'fiction' });
    assert.deepEqual(selected, [chosen.id]);
    await handlers.cancelLinks({ token: offer.token });
  } finally { handlers.close(); }
}));

test('known top-k omissions are retained as an incomplete search limitation', async () => {
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' },
    memory: { async searchCompact() { return { status: 'ready', records: [{ id: 'a', kind: 'decision', text: 'fiction',
      handle: 'h', text_truncated: false, score: 1 }], channels: { record_lexical: { status: 'ready', candidate_limit_reached: false },
        record_vector: { status: 'ready', candidate_limit_reached: false } },
      ranked_count: 2, budget_omitted: 0, top_k_omitted: 1, filter_may_be_incomplete: false, relationship_context: 'not_loaded', completeness_guaranteed: false }; } } });
  await tools.search('fiction', []);
  assert.equal(tools.stats().incomplete_search, true);
});
