import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryHandlers } from '../pi-extension/memory-process.mjs';
import { createTurnTools } from '../pi-extension/core.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';

function fixture({ count = 40, partial = false, linkModule, longIds = false, allActions = false, directCount = count, edges = [] } = {}) {
  const reads = [], rows = Array.from({ length: count }, (_, i) => ({ id: longIds ? `pi-memory-record-${String(i).padStart(64, '0')}` : `prior-${i}`,
    scope: 'fiction', kind: allActions || i === 0 ? 'action' : 'observation', status: 'proposed', text: `Prior ${i}: ${'🌿'.repeat(600)}`,
    attribution: 'fiction', evidence: [{ turn: `source-${i}`, entry_id: 'entry', start: 0, end: 7 }] }));
  const channels = Object.fromEntries(['turn_lexical', 'record_lexical', 'chunk_lexical', 'chunk_vector', 'record_vector']
    .map(name => [name, { status: name === 'record_vector' && partial ? 'partial' : 'ready', candidate_limit_reached: directCount >= 64 }]));
  channels.reranker = { status: 'unconfigured' };
  const memory = { config: { scopes: { read: ['fiction'], write: ['fiction'] } },
    async recall(scope, request, options) {
      assert.equal(options.seedsOnly, true);
      return { scope, channels, ranked: rows.slice(0, Math.min(directCount, request.candidates)).map(row => ({ kind: 'record', id: row.id, score: 0.01 })) };
    },
    store: {
      async getRecords(_scope, ids) { return ids.map(id => rows.find(row => row.id === id)).filter(Boolean); },
      async recordsForTurn() { return []; },
      async neighbors(_scope, ids, limit) { reads.push(['neighbors', ids[0]]); return edges.filter(edge => ids.includes(edge.from) || ids.includes(edge.to)).slice(0, limit); },
    },
    async show(_scope, input) {
      if (input.kind === 'turn') return { kind: 'turn', turn: { id: input.id, source: 'pi-memory' } };
      reads.push(['record', input.id]);
      return { kind: 'record', record: rows.find(row => row.id === input.id), evidence: [{ text: `private evidence for ${input.id}` }] };
    } };
  const handlers = createMemoryHandlers({ memory, scopes: ['fiction'], ...(linkModule ? { linkModule } : {}) });
  return { handlers, reads };
}
const input = { query: 'fiction', kinds: [], limit: 64, max_bytes: 24000 };
const toolsFor = handlers => createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' },
  memory: { searchCompact: (scope, request, trigger) => handlers.searchCompact({ scope, input: request, trigger }) } });

test('compact search exposes graph metadata but hydrates evidence only for a selected scoped handle', async () => {
  const { handlers, reads } = fixture();
  try {
    const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([result.status, result.records.length, result.budget_omitted, reads.filter(row => row[0] === 'record').length], ['ready', 40, 0, 0]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24000);
    assert.ok(result.records.every(row => Buffer.byteLength(row.text) <= 80 && row.text_truncated && !Object.hasOwn(row, 'status')));
    assert.ok(result.records.find(row => row.id === 'prior-0').action_handle);
    assert.ok(!JSON.stringify(result).includes('private evidence'));
    const chosen = result.records[1], full = await handlers.fetchCompact({ scope: 'fiction', trigger: 'turn', handle: chosen.handle });
    assert.deepEqual([full.record.id, reads.filter(row => row[0] === 'record'), full.immediate_relations_complete,
      Object.hasOwn(full.record, 'status'), Object.hasOwn(full.record, 'attribution')], [chosen.id, [['record', chosen.id]], true, false, false]);
    await assert.rejects(handlers.fetchCompact({ scope: 'fiction', trigger: 'other', handle: chosen.handle }), /handle_not_offered/);
    await assert.rejects(handlers.fetchCompact({ scope: 'other', trigger: 'turn', handle: chosen.handle }), /scope_denied/);
    await handlers.releaseCompact({ scope: 'fiction', trigger: 'turn' });
    await assert.rejects(handlers.fetchCompact({ scope: 'fiction', trigger: 'turn', handle: chosen.handle }), /handle_not_offered/);
  } finally { handlers.close(); }
});

test('relation-only successor gets a card and linkable handle without loading its evidence', async () => {
  const edge = { id: 'replacement', type: 'supersedes', from: 'prior-2', to: 'prior-0' };
  const { handlers, reads } = fixture({ count: 3, directCount: 1, edges: [edge] });
  try {
    const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    const older = result.records.find(row => row.id === 'prior-0'), newer = result.records.find(row => row.id === 'prior-2');
    assert.deepEqual([result.relationship_context_complete, newer.score, result.relations], [true, null,
      [{ type: 'supersedes', from_handle: newer.handle, to_handle: older.handle }]]);
    assert.equal(reads.filter(row => row[0] === 'record').length, 0);
    assert.equal((await handlers.fetchCompact({ scope: 'fiction', trigger: 'turn', handle: newer.handle })).record.id, 'prior-2');
  } finally { handlers.close(); }
});

test('graph node cutoff is reported as incomplete rather than hidden', async () => {
  const edges = Array.from({ length: 49 }, (_, i) => ({ id: `edge-${i}`, type: 'qualifies', from: 'prior-0', to: `prior-${i + 1}` }));
  const { handlers } = fixture({ count: 50, directCount: 1, edges });
  const tools = toolsFor(handlers);
  try {
    const result = await tools.search('fiction', []);
    assert.deepEqual([result.graph_gaps.includes('node_limit'), result.relationship_context_complete, tools.stats().incomplete_search], [true, false, true]);
  } finally { handlers.close(); }
});

test('graph hop and edge cutoffs are disclosed instead of being treated as complete', async () => {
  const chains = Array.from({ length: 5 }, (_, i) => ({ id: `chain-${i}`, type: 'depends_on', from: `prior-${i}`, to: `prior-${i + 1}` }));
  const dense = Array.from({ length: 193 }, (_, i) => ({ id: `edge-${String(i).padStart(3, '0')}`, type: 'qualifies', from: 'prior-0', to: 'prior-1' }));
  for (const [edges, expected] of [[chains, 'hop_limit'], [dense, 'edge_limit']]) {
    const { handlers } = fixture({ count: 6, directCount: 1, edges });
    try {
      const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
      assert.ok(result.graph_gaps.includes(expected));
      assert.equal(result.relationship_context_complete, false);
    } finally { handlers.close(); }
  }
});

test('64 action cards with long ids and multibyte previews fit the unchanged search budget', async () => {
  const { handlers } = fixture({ count: 64, longIds: true, allActions: true });
  try {
    const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([result.status, result.records.length, result.budget_omitted], ['ready', 64, 0]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24000);
  } finally { handlers.close(); }
});

for (const count of [64, 100]) test(`${count} stored records respect the declared top-64 bound without false incompleteness`, async () => {
  const { handlers } = fixture({ count });
  const tools = toolsFor(handlers);
  try {
    const result = await tools.search('fiction', ['observation']);
    assert.deepEqual([result.records.length, result.declared_seed_limit, result.channels.record_vector.candidate_limit_reached,
      tools.stats().incomplete_search], [63, 64, true, false]);
  } finally { handlers.close(); }
});

test('repeated search reuses action handles instead of exhausting the offer cap', async () => {
  const { handlers } = fixture({ count: 64, allActions: true });
  try {
    let prior;
    for (let i = 0; i < 20; i++) {
      const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
      const handle = result.records[0].action_handle;
      if (prior) assert.equal(handle, prior);
      prior = handle;
    }
  } finally { handlers.close(); }
});

test('a tight budget reports exact whole-card omissions', async () => {
  const { handlers } = fixture({ count: 8 });
  try {
    const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input: { ...input, max_bytes: 1200 } });
    assert.equal(result.status, 'budget_limited');
    assert.equal(result.records.length + result.budget_omitted, 8);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1200);
  } finally { handlers.close(); }
});

test('a graph edge omitted by the response budget marks relationship context incomplete', async () => {
  const edges = Array.from({ length: 6 }, (_, i) => ({ id: `edge-${i}`, type: 'qualifies', from: 'prior-0', to: `prior-${i + 1}` }));
  const { handlers } = fixture({ count: 7, directCount: 1, edges });
  try {
    let bounded;
    for (let max_bytes = 1000; max_bytes <= 6000; max_bytes += 25) {
      const result = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input: { ...input, max_bytes } });
      if (!result.budget_omitted && result.edge_budget_omitted) { bounded = result; break; }
    }
    assert.ok(bounded);
    assert.deepEqual([bounded.status, bounded.relationship_context_complete], ['budget_limited', false]);
  } finally { handlers.close(); }
});

test('a partial vector channel cannot be presented as a successful compact search', async () => {
  const { handlers } = fixture({ partial: true });
  try { await assert.rejects(handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input }), /search_incomplete/); }
  finally { handlers.close(); }
});

test('link offers admit only selected handles from the same trigger', async () => {
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
});

test('search trace distinguishes previewed, fetched and link-selected identities', async () => {
  const retrieval = { status: 'selected', relationship_context_complete: false, completeness_guaranteed: false,
    budget_omitted: 0, omitted_prior_records: 0, omitted_prior_spans: 0, trigger_omissions: [] };
  const memory = { async searchCompact() { return compactResult({ records: [{ id: 'one', kind: 'decision', text: 'one' }, { id: 'two', kind: 'decision', text: 'two' }] }); },
    async fetchCompact() { return { record: { id: 'one' }, relations: [], immediate_relations_complete: true }; },
    async enrich() { return {}; }, async beginLinks() { return { token: 'offer', packet: { records: [], sources: [], retrieval } }; } };
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fiction' }] }, receipt: { id: 'turn' }, memory });
  const found = await tools.search('fiction', []);
  await tools.fetch(found.records[0].handle);
  await tools.record('decision', 'fiction', ['ref-000001']);
  await tools.offer([found.records[1].handle]);
  const stats = tools.stats();
  assert.deepEqual([stats.returned_prior_ids, stats.fetched_ids, stats.link_candidate_ids,
    stats.search_statuses.map(row => row.previewed_ids ?? row.id ?? row.candidate_ids)],
  [['one', 'two'], ['one'], ['two'], [['one', 'two'], 'one', ['two']]]);
});

test('selected-record fetches are bounded per turn', async () => {
  const memory = { async searchCompact() { return compactResult({ records: [{ id: 'one', kind: 'decision', text: 'one' }] }); },
    async fetchCompact() { return { record: { id: 'one' }, relations: [], immediate_relations_complete: true }; } };
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' }, memory });
  const found = await tools.search('fiction', []);
  for (let i = 0; i < 32; i++) await tools.fetch(found.records[0].handle);
  await assert.rejects(tools.fetch(found.records[0].handle), /fetch_limit/);
  assert.equal(tools.stats().search_failed, true);
});

test('a failed re-offer never reuses its cancelled token', async () => {
  let calls = 0;
  const memory = { async searchCompact() { return compactResult({ records: [{ id: 'one', kind: 'decision', text: 'one' }, { id: 'two', kind: 'decision', text: 'two' }] }); },
    async enrich() { return {}; }, async cancelLinks() {}, async beginLinks() {
      calls++;
      if (calls === 2) throw new Error('fictional_refusal');
      return { token: `offer-${calls}`, packet: { records: [], sources: [] } };
    } };
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fiction' }] }, receipt: { id: 'turn' }, memory });
  const found = await tools.search('fiction', []);
  await tools.record('decision', 'fiction', ['ref-000001']);
  const first = await tools.offer([found.records[0].handle]);
  await assert.rejects(tools.offer([found.records[1].handle]), /fictional_refusal/);
  const third = await tools.offer([found.records[0].handle]);
  assert.deepEqual([first.token, third.token], ['offer-1', 'offer-3']);
});
