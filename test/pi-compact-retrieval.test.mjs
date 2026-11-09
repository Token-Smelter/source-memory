import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createMemoryHandlers } from '../pi-extension/memory-process.mjs';
import { createTurnTools } from '../pi-extension/core.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';

const longId = i => `pi-memory-record-${String(i).padStart(64, '0')}`;
function fixture({ count = 40, partial = false, lexicalState = 'ready', linkModule, longIds = false, allActions = false, actionEvery7 = false,
  directCount = count, edges = [], escaped = false, ranking = null, kindOf = null } = {}) {
  const reads = [], rows = Array.from({ length: count }, (_, i) => ({ id: longIds ? longId(i) : `prior-${i}`,
    scope: 'fiction', kind: kindOf ? kindOf(i) : allActions || i === 0 || (actionEvery7 && i % 7 === 0) ? 'action' : 'observation', status: 'proposed',
    text: escaped ? `"\\\n\u0001`.repeat(100) : `Prior ${i}: ${'🌿'.repeat(600)}`,
    attribution: 'fiction', evidence: [{ turn: `source-${i}`, entry_id: 'entry', start: 0, end: 7 }] }));
  const channels = Object.fromEntries(['turn_lexical', 'record_lexical', 'chunk_lexical', 'chunk_vector', 'record_vector']
    .map(name => [name, { status: name === 'record_vector' && partial ? 'partial' : 'ready', candidate_limit_reached: directCount >= 64 }]));
  channels.reranker = { status: 'unconfigured' };
  const memory = { config: { scopes: { read: ['fiction'], write: ['fiction'] } },
    async recall(scope, request, options) {
      assert.equal(options.seedsOnly, true);
      const selected = ranking ? ranking.map(index => rows[index]) : rows.slice(0, directCount);
      return { scope, channels, ranked: selected.slice(0, request.candidates).map((row, index) => ({ kind: 'record', id: row.id,
        score: 0.01, ...(ranking ? { rerank_score: 100 - index } : {}) })) };
    },
    store: {
      async lexicalStatus() { return { status: lexicalState }; },
      async getRecords(_scope, ids) { return ids.map(id => rows.find(row => row.id === id)).filter(Boolean); },
      async recordsForTurn() { return []; },
      async catalogRecords(_scope, limit) { reads.push(['catalog']); return rows.slice(0, limit); },
      async neighbors(_scope, ids, limit) { reads.push(['neighbors', ids[0]]); return edges.filter(edge => ids.includes(edge.from) || ids.includes(edge.to)).slice(0, limit); },
    },
    async show(_scope, input) {
      if (input.kind === 'turn') return { kind: 'turn', turn: { id: input.id, source: 'pi-memory' } };
      reads.push(['record', input.id]);
      return { kind: 'record', record: rows.find(row => row.id === input.id), evidence: [{ role: 'user', text: `private evidence for ${input.id}`,
        occurred_at: '2030-01-01T00:00:00Z', source: 'private-source', conversation_id: 'private-conversation', turn_id: 'private-turn' }] };
    } };
  const handlers = createMemoryHandlers({ memory, scopes: ['fiction'], ...(linkModule ? { linkModule } : {}) });
  return { handlers, reads };
}
const input = { query: 'fiction', kinds: [], limit: 48, max_bytes: 24000 };
const toolsFor = handlers => createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' },
  memory: { searchCompact: (scope, request, trigger) => handlers.searchCompact({ scope, input: request, trigger }),
    fetchCompact: (scope, trigger, handle) => handlers.fetchCompact({ scope, trigger, handle }) } });

test('compact search offers an outcome referent handle on action, decision and intention cards only', async () => {
  const kinds = ['action', 'decision', 'intention', 'question', 'observation', 'outcome'];
  const { handlers } = fixture({ count: kinds.length, kindOf: i => kinds[i] });
  try {
    const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    const placeholder = `action-${'0'.repeat(36)}`;
    assert.deepEqual(surface.records.map(row => [row.kind, typeof row.action_handle === 'string' && row.action_handle !== placeholder]),
      kinds.map(kind => [kind, ['action', 'decision', 'intention'].includes(kind)]));
  } finally { handlers.close(); }
});

test('compact search exposes scoped ids and graph summaries without hydrating unselected evidence', async () => {
  const { handlers, reads } = fixture();
  try {
    const { surface, bindings } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([surface.status, surface.records.length, surface.budget_omitted, reads.filter(row => row[0] === 'record').length], ['ready', 40, 0, 0]);
    assert.ok(Buffer.byteLength(JSON.stringify(surface)) <= 24000);
    assert.ok(surface.records.every(row => Buffer.byteLength(row.text) <= 80 && row.text_truncated && !Object.hasOwn(row, 'status')));
    assert.ok(surface.records.find(row => row.id === bindings.find(binding => binding.id === 'prior-0').handle).action_handle);
    assert.ok(!JSON.stringify(surface).includes('prior-'));
    const chosen = bindings[1], full = await handlers.fetchCompact({ scope: 'fiction', trigger: 'turn', handle: chosen.handle });
    assert.deepEqual([full.record.id, reads.filter(row => row[0] === 'record'), full.immediate_relations_complete,
      Object.hasOwn(full.record, 'status'), Object.hasOwn(full.record, 'attribution')], [chosen.id, [['record', chosen.id]], true, false, false]);
    await assert.rejects(handlers.fetchCompact({ scope: 'fiction', trigger: 'other', handle: chosen.handle }), /handle_not_offered/);
    await assert.rejects(handlers.fetchCompact({ scope: 'other', trigger: 'turn', handle: chosen.handle }), /scope_denied/);
    await handlers.releaseCompact({ scope: 'fiction', trigger: 'turn' });
    await assert.rejects(handlers.fetchCompact({ scope: 'fiction', trigger: 'turn', handle: chosen.handle }), /handle_not_offered/);
  } finally { handlers.close(); }
});

test('private id bindings cannot be duplicated or rebound to another displayed handle', async () => {
  for (const mode of ['duplicate', 'misaligned']) {
    const memory = { async searchCompact() {
      const envelope = compactResult({ records: [{ id: 'one', kind: 'decision', text: 'one' }, { id: 'two', kind: 'decision', text: 'two' }] });
      if (mode === 'duplicate') envelope.bindings[1].id = 'one';
      else envelope.bindings[1].handle = 'forged';
      return envelope;
    } };
    const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' }, memory });
    await assert.rejects(tools.search('fiction', []), /search_incomplete/);
  }
});

test('relation-only successor has an id and untyped edge without loading evidence', async () => {
  const edge = { id: 'replacement', type: 'supersedes', from: 'prior-2', to: 'prior-0' };
  const { handlers, reads } = fixture({ count: 3, directCount: 1, edges: [edge] });
  try {
    const { surface, bindings } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    const older = bindings.findIndex(row => row.id === 'prior-0'), newer = bindings.findIndex(row => row.id === 'prior-2');
    assert.deepEqual([surface.relationship_context_complete, surface.records[newer].score, surface.relations], [true, null,
      [{ endpoints: [older, newer].sort((a, b) => a - b) }]]);
    assert.equal(reads.filter(row => row[0] === 'record').length, 0);
    assert.equal((await handlers.fetchCompact({ scope: 'fiction', trigger: 'turn', handle: bindings[newer].handle })).record.id, 'prior-2');
  } finally { handlers.close(); }
});

test('multiple typed edges on one pair collapse to one untyped relation with disclosure', async () => {
  const edges = [{ id: 'a', type: 'supersedes', from: 'prior-2', to: 'prior-0' },
    { id: 'b', type: 'qualifies', from: 'prior-0', to: 'prior-2' }];
  const { handlers } = fixture({ count: 3, directCount: 1, edges });
  try {
    const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([surface.relations.length, surface.collapsed_edge_count, Object.keys(surface.relations[0])], [1, 1, ['endpoints']]);
  } finally { handlers.close(); }
});

test('model-facing fetch excludes stored ids, timestamps, attribution and relation type', async () => {
  const edge = { id: 'replacement', type: 'supersedes', from: 'prior-2', to: 'prior-0' };
  const { handlers } = fixture({ count: 3, directCount: 1, edges: [edge] }), tools = toolsFor(handlers);
  try {
    const found = await tools.search('fiction', []), record = found.records[0];
    const result = await tools.fetch(record.id);
    assert.deepEqual([result.record.id, Object.keys(result.evidence[0]).sort(), Object.keys(result.relations[0])],
      [record.id, ['role', 'text'], ['endpoints']]);
    assert.ok(!JSON.stringify(result).includes('supersedes'));
  } finally { handlers.close(); }
});

test('graph node cutoff is reported as incomplete rather than hidden', async () => {
  const edges = Array.from({ length: 49 }, (_, i) => ({ id: `edge-${i}`, type: 'qualifies', from: 'prior-0', to: `prior-${i + 1}` }));
  const { handlers } = fixture({ count: 50, directCount: 1, edges }), tools = toolsFor(handlers);
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
      const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
      assert.ok(surface.graph_gaps.includes(expected));
      assert.equal(surface.relationship_context_complete, false);
    } finally { handlers.close(); }
  }
});

test('48 action cards with long stored ids and multibyte previews fit the search budget', async () => {
  const { handlers } = fixture({ count: 64, longIds: true, allActions: true });
  try {
    const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([surface.status, surface.records.length, surface.budget_omitted], ['ready', 48, 0]);
    assert.ok(Buffer.byteLength(JSON.stringify(surface)) <= 24000);
  } finally { handlers.close(); }
});

test('48 seeds and 64 relation-only records fit without hiding graph context', async () => {
  const edges = Array.from({ length: 64 }, (_, i) => ({ id: `edge-${i}`, type: 'qualifies', from: longId(i % 48), to: longId(i + 48) }));
  const { handlers } = fixture({ count: 112, directCount: 48, longIds: true, actionEvery7: true, edges });
  try {
    const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([surface.status, surface.records.length, surface.relations.length, surface.relationship_context_complete], ['ready', 112, 64, true]);
    assert.ok(Buffer.byteLength(JSON.stringify(surface)) <= 24000);
  } finally { handlers.close(); }
});

test('escaped previews and actions remain within the same graph-rich budget', async () => {
  const edges = Array.from({ length: 64 }, (_, i) => ({ id: `edge-${i}`, type: 'qualifies', from: longId(i % 48), to: longId(i + 48) }));
  const { handlers } = fixture({ count: 112, directCount: 48, longIds: true, actionEvery7: true, escaped: true, edges });
  try {
    const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual([surface.status, surface.records.length, surface.relations.length, surface.relationship_context_complete], ['ready', 112, 64, true]);
    assert.ok(surface.records.every(row => Buffer.byteLength(JSON.stringify(row.text)) - 2 <= 80));
    assert.ok(Buffer.byteLength(JSON.stringify(surface)) <= 24000);
  } finally { handlers.close(); }
});

test('a single dense graph that cannot fit the declared byte budget is incomplete', async () => {
  const edges = [];
  for (let i = 0; i < 32 && edges.length < 160; i++) for (let j = i + 1; j < 32 && edges.length < 160; j++) {
    edges.push({ id: `edge-${i}-${j}`, type: 'qualifies', from: `prior-${i}`, to: `prior-${j}` });
  }
  const { handlers } = fixture({ count: 32, directCount: 1, allActions: true, edges });
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' },
    memory: { searchCompact: (scope, request, trigger) => handlers.searchCompact({ scope, input: { ...request, max_bytes: 4000 }, trigger }) } });
  try {
    const { surface: full } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.equal(full.relationship_context_complete, true);
    const result = await tools.search('fiction', []);
    assert.equal(result.status, 'budget_limited');
    assert.equal(result.relationship_context_complete, false);
    assert.equal(tools.stats().incomplete_search, true);
  } finally { handlers.close(); }
});

test('the seed bound follows reranked order and excludes unselected seed graphs', async () => {
  const ranking = Array.from({ length: 64 }, (_, i) => 63 - i);
  const edge = { id: 'unselected-edge', type: 'qualifies', from: 'prior-15', to: 'prior-64' };
  const { handlers } = fixture({ count: 65, directCount: 64, ranking, edges: [edge] });
  try {
    const { surface, bindings } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    assert.deepEqual(bindings.map(row => row.id), ranking.slice(0, 48).map(index => `prior-${index}`));
    assert.deepEqual([surface.records[0].score, surface.records[47].score, surface.relationship_context_complete], [100, 53, true]);
    assert.ok(!bindings.some(row => row.id === 'prior-15' || row.id === 'prior-64'));
  } finally { handlers.close(); }
});

for (const count of [64, 100]) test(`${count} stored records respect the declared top-48 bound without false incompleteness`, async () => {
  const { handlers } = fixture({ count }), tools = toolsFor(handlers);
  try {
    const result = await tools.search('fiction', ['observation']);
    assert.deepEqual([result.records.length, result.declared_seed_limit, result.channels.record_vector.candidate_limit_reached,
      tools.stats().incomplete_search], [47, 48, true, false]);
  } finally { handlers.close(); }
});

test('repeated search reuses action handles instead of exhausting the offer cap', async () => {
  const { handlers } = fixture({ count: 64, allActions: true });
  try {
    let prior;
    for (let i = 0; i < 20; i++) {
      const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
      const handle = surface.records[0].action_handle;
      if (prior) assert.equal(handle, prior);
      prior = handle;
    }
  } finally { handlers.close(); }
});

test('a tight budget reports exact whole-card omissions', async () => {
  const { handlers } = fixture({ count: 8 });
  try {
    const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input: { ...input, max_bytes: 1200 } });
    assert.equal(surface.status, 'budget_limited');
    assert.equal(surface.records.length + surface.budget_omitted, 8);
    assert.ok(Buffer.byteLength(JSON.stringify(surface)) <= 1200);
  } finally { handlers.close(); }
});

test('a graph edge omitted by the response budget marks relationship context incomplete', async () => {
  const edges = Array.from({ length: 6 }, (_, i) => ({ id: `edge-${i}`, type: 'qualifies', from: 'prior-0', to: `prior-${i + 1}` }));
  const { handlers } = fixture({ count: 7, directCount: 1, edges });
  try {
    let bounded;
    for (let max_bytes = 1000; max_bytes <= 6000; max_bytes += 25) {
      const { surface } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input: { ...input, max_bytes } });
      if (!surface.budget_omitted && surface.edge_budget_omitted) { bounded = surface; break; }
    }
    assert.ok(bounded);
    assert.deepEqual([bounded.status, bounded.relationship_context_complete], ['budget_limited', false]);
  } finally { handlers.close(); }
});

test('a non-online lexical index fails before ranking', async () => {
  const { handlers } = fixture({ lexicalState: 'pending' });
  try { await assert.rejects(handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input }), /search_incomplete/); }
  finally { handlers.close(); }
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
    const { bindings } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input });
    const chosen = bindings[1];
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

test('uncited current-turn context omitted from a link offer is disclosed, while omitted prior memory stays incomplete', async () => {
  const offerWith = async retrieval => {
    const memory = { async searchCompact() { return compactResult({ records: [{ id: 'one', kind: 'decision', text: 'one' }] }); },
      async enrich() { return {}; }, async beginLinks() { return { token: 'offer', packet: { records: [], sources: [], retrieval } }; } };
    const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fiction' }] }, receipt: { id: 'turn' }, memory });
    const found = await tools.search('fiction', []);
    await tools.record('decision', 'fiction', ['ref-000001']);
    await tools.offer([found.records[0].id]);
    return tools.stats();
  };
  const base = { status: 'selected', relationship_context_complete: false, completeness_guaranteed: false, budget_omitted: 0, omitted_prior_records: 0, omitted_prior_spans: 0 };
  const context = await offerWith({ ...base, trigger_omissions: [{ entry_id: 'u', start: 0, end: 4, reason: 'packet_budget' }] });
  const prior = await offerWith({ ...base, omitted_prior_records: 1, omitted_prior_spans: 1, trigger_omissions: [] });
  assert.deepEqual([context.incomplete_search, context.search_statuses.at(-1).trigger_context_omitted, prior.incomplete_search], [false, 1, true]);
});

test('search trace distinguishes previewed, fetched and link-selected identities', async () => {
  const retrieval = { status: 'selected', relationship_context_complete: false, completeness_guaranteed: false,
    budget_omitted: 0, omitted_prior_records: 0, omitted_prior_spans: 0, trigger_omissions: [] };
  const memory = { async searchCompact() { return compactResult({ records: [{ id: 'one', kind: 'decision', text: 'one' }, { id: 'two', kind: 'decision', text: 'two' }] }); },
    async fetchCompact() { return { record: { id: 'one' }, evidence: [{ role: 'user', text: 'fiction' }], relations: [], immediate_relations_complete: true }; },
    async enrich() { return {}; }, async beginLinks() { return { token: 'offer', packet: { records: [], sources: [], retrieval } }; } };
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fiction' }] }, receipt: { id: 'turn' }, memory });
  const found = await tools.search('fiction', []);
  await tools.fetch(found.records[0].id);
  await tools.record('decision', 'fiction', ['ref-000001']);
  await tools.offer([found.records[1].id]);
  const stats = tools.stats();
  assert.deepEqual([stats.returned_prior_ids, stats.fetched_ids, stats.link_candidate_ids,
    stats.search_statuses.map(row => row.previewed_ids ?? row.id ?? row.candidate_ids)],
  [['one', 'two'], ['one'], ['two'], [['one', 'two'], 'one', ['two']]]);
  const directory = mkdtempSync(join(tmpdir(), 'pi-compact-trace-'));
  try {
    const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
    journal.begin({ cursor: null, through: 'a' });
    journal.finish('abstained', null, { incomplete: stats.incomplete_search, statuses: stats.search_statuses });
    const path = journal.path;
    journal.close();
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.find(row => row.type === 'finish').search_statuses.map(row => row.previewed_ids ?? row.id ?? row.candidate_ids),
      [['one', 'two'], 'one', ['two']]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('selected-record fetches are bounded per turn', async () => {
  const memory = { async searchCompact() { return compactResult({ records: [{ id: 'one', kind: 'decision', text: 'one' }] }); },
    async fetchCompact() { return { record: { id: 'one' }, evidence: [{ role: 'user', text: 'fiction' }], relations: [], immediate_relations_complete: true }; } };
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' }, memory });
  const found = await tools.search('fiction', []);
  for (let i = 0; i < 32; i++) await tools.fetch(found.records[0].id);
  await assert.rejects(tools.fetch(found.records[0].id), /fetch_limit/);
  assert.deepEqual([tools.stats().search_failed, tools.stats().incomplete_search], [false, true]);
});

test('an oversized selected fetch records incompleteness without fabricating evidence', async () => {
  const memory = { async searchCompact() { return compactResult({ records: [{ id: 'one', kind: 'decision', text: 'one' }] }); },
    async fetchCompact() { throw Object.assign(new Error('fetch_budget_exceeded'), { code: 'fetch_budget_exceeded' }); } };
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' }, memory });
  const found = await tools.search('fiction', []);
  await assert.rejects(tools.fetch(found.records[0].id), /fetch_budget_exceeded/);
  assert.deepEqual([tools.stats().search_failed, tools.stats().incomplete_search, tools.stats().fetched_ids], [false, true, []]);
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
  const first = await tools.offer([found.records[0].id]);
  await assert.rejects(tools.offer([found.records[1].id]), /fictional_refusal/);
  const third = await tools.offer([found.records[0].id]);
  assert.deepEqual([first.token, third.token], ['offer-1', 'offer-3']);
});

test('the D0 oracle catalog offers every prior record with its relations, ignoring query and kind', async () => {
  const edges = [{ id: 'e1', type: 'supersedes', from: 'prior-2', to: 'prior-1' }];
  const { handlers, reads } = fixture({ count: 30, directCount: 2, edges });
  try {
    const { surface, bindings } = await handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input: { query: 'x', kinds: ['decision'], limit: 48, max_bytes: 120000, catalog: true } });
    assert.deepEqual([surface.status, surface.records.length, surface.relations.length, surface.declared_seed_limit, Object.keys(surface.channels), reads[0]],
      ['ready', 30, 1, 256, ['catalog'], ['catalog']]);
    assert.equal(new Set(bindings.map(row => row.id)).size, 30);
    const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' }, retrieval: 'oracle-catalog',
      memory: { searchCompact: (scope, request, trigger) => handlers.searchCompact({ scope, input: request, trigger }) } });
    assert.equal((await tools.search('anything', [])).records.length, 30);
    await assert.rejects(handlers.searchCompact({ scope: 'fiction', trigger: 'turn', input: { ...input, max_bytes: 120000 } }), /invalid_input/);
  } finally { handlers.close(); }
});
