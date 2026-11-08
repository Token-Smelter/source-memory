import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTools, entryText } from '../pi-extension/core.mjs';
import { createPiDistiller, parseFinalResult } from '../pi-extension/pi-runtime.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';

test('fallback accepts one fenced JSON object but refuses surrounding commentary', () => {
  const body = '{"result":"done_with_writes","reason":"fiction"}';
  assert.deepEqual(parseFinalResult(`\`\`\`json\n${body}\n\`\`\``), JSON.parse(body));
  assert.throws(() => parseFinalResult(`prefix\n\`\`\`json\n${body}\n\`\`\``), /disposition_invalid/);
});

test('opaque and summarized thinking blocks are never included in citable source text', () => {
  const row = { message: { content: [{ type: 'thinking', text: 'fictional private reasoning' }, { type: 'text', text: 'visible fiction' }] } };
  assert.equal(entryText(row), 'visible fiction');
});

test('a failed or degraded search cannot be converted into a record or successful search', async () => {
  let writes = 0;
  const memory = { async searchCompact() { return compactResult({ status: 'degraded' }); }, async enrich() { writes++; } };
  const tools = createTurnTools({ scope: 'fiction', requireSearch: true, memory,
    turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fiction' }] }, receipt: { id: 'turn' } });
  await assert.rejects(tools.search('Fiction', []), /search_incomplete/);
  await assert.rejects(tools.record('decision', 'Fiction', ['ref-000001']), /search_required/);
  assert.deepEqual([writes, tools.stats().search_failed], [0, true]);
});

test('an unavailable search channel cannot become a successful bounded search', async () => {
  const memory = { async searchCompact() { return compactResult({ budget_omitted: 1,
    channels: { record_lexical: { status: 'ready' }, record_vector: { status: 'unavailable' } } }); } };
  const tools = createTurnTools({ scope: 'fiction', requireSearch: true, memory,
    turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } });
  await assert.rejects(tools.search('fiction', []), /search_incomplete/);
  assert.equal(tools.stats().search_failed, true);
});

test('a selected record with an incomplete relationship expansion is incomplete', async () => {
  const memory = { async searchCompact() { return compactResult({ records: [{ id: 'a', kind: 'decision', text: 'fiction' }] }); },
    async fetchCompact() { return { record: { id: 'a' }, relations: [], immediate_relations_complete: false, relationship_omitted_at_least: 1 }; } };
  const tools = createTurnTools({ scope: 'fiction', memory, turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } });
  const result = await tools.search('fiction', []);
  await tools.fetch(result.records[0].handle);
  assert.deepEqual([tools.stats().incomplete_search, tools.stats().search_statuses[1].relationship_omitted_at_least], [true, 1]);
});

test('a selected record without relationship completeness evidence is incomplete', async () => {
  const memory = { async searchCompact() { return compactResult({ records: [{ id: 'a', kind: 'decision', text: 'fiction' }] }); },
    async fetchCompact() { return {}; } };
  const tools = createTurnTools({ scope: 'fiction', memory, turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } });
  const result = await tools.search('fiction', []);
  await assert.rejects(tools.fetch(result.records[0].handle), /search_incomplete/);
  assert.equal(tools.stats().search_failed, true);
});

test('bounded search exposes omissions and channel status without increasing its budget', async () => {
  const inputs = [];
  const memory = { async searchCompact(_scope, input) { inputs.push(input); return compactResult({ budget_omitted: 2,
    records: [{ id: 'prior', kind: 'observation', text: 'fiction' }] }); } };
  const tools = createTurnTools({ scope: 'fiction', memory, turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fiction' }] }, receipt: { id: 'turn' } });
  const result = await tools.search('fiction', []);
  assert.deepEqual([inputs[0].max_bytes, result.status, result.budget_omitted, result.channels.record_vector.status,
    result.records[0].id, tools.stats().incomplete_search], [24000, 'budget_limited', 2, 'ready', 'prior', true]);
});

test('a bounded successful search permits candidate-assessed abstention and records incompleteness', async () => {
  const tools = new Map();
  class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0]({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } }); } }
  const manager = { getSessionId: () => 'fiction', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const session = { sessionId: 'fiction', agent: { sessionId: 'fiction', state: {} }, messages: [], async prompt() {
    await tools.get('memory_search').execute('search', { query: 'fiction', kinds: [] });
    this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"result":"done_nothing_qualifies","reason":"No useful change."}' }] }];
  } };
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession() { return { session }; } };
  const memory = { async searchCompact() { return compactResult({ budget_omitted: 1 }); } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'fiction', async syncThrough() { return { file: '/fiction' }; } },
    workDir: '/fiction', model: {}, memory, scope: 'fiction' });
  const result = await runtime.run({ throughEntryId: 'a', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } });
  assert.deepEqual([result.disposition, result.search_limitations.incomplete, result.search_limitations.statuses[0].status],
    ['abstained', true, 'budget_limited']);
});

test('a successful budget-limited search may return zero complete cards', async () => {
  const memory = { async searchCompact() { return compactResult({ budget_omitted: 3 }); } };
  const tools = createTurnTools({ scope: 'fiction', memory, requireSearch: true,
    turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } });
  const result = await tools.search('fiction', []);
  assert.deepEqual([result.status, result.records.length, tools.stats().incomplete_search], ['budget_limited', 0, true]);
});

test('no memory tool may run after the final submission', async () => {
  const tools = new Map();
  class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0]({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } }); } }
  const manager = { getSessionId: () => 'fiction', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const session = { sessionId: 'fiction', agent: { sessionId: 'fiction', state: {} }, messages: [], async prompt() {
    await tools.get('memory_search').execute('search', { query: 'fiction', kinds: [] });
    await tools.get('memory_submit').execute('submit', { result: 'done_nothing_qualifies', reason: 'fiction' });
    await assert.rejects(tools.get('memory_search').execute('late', { query: 'fiction', kinds: [] }), /evaluation_already_submitted/);
    this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'submitted' }] }];
  } };
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession() { return { session }; } };
  const memory = { async searchCompact() { return compactResult(); } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'fiction', async syncThrough() { return { file: '/fiction' }; } },
    workDir: '/fiction', model: {}, memory, scope: 'fiction' });
  await assert.rejects(runtime.run({ throughEntryId: 'a', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } }), /disposition_invalid/);
});

test('the model cannot declare operational uncertainty as its result', async () => {
  const tools = new Map();
  class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0]({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } }); } }
  const manager = { getSessionId: () => 'fiction', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const session = { sessionId: 'fiction', agent: { sessionId: 'fiction', state: {} }, messages: [], async prompt() {
    await tools.get('memory_search').execute('search', { query: 'fiction', kinds: [] });
    this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"disposition":"uncertain"}' }] }];
  } };
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession() { return { session }; } };
  const memory = { async searchCompact() { return compactResult(); } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'fiction', async syncThrough() { return { file: '/fiction' }; } },
    workDir: '/fiction', model: {}, memory, scope: 'fiction' });
  await assert.rejects(runtime.run({ throughEntryId: 'a', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } }), /disposition_invalid/);
});

test('an unknown write aborts the Pi tool loop immediately', async () => {
  const tools = new Map();
  let aborted = 0;
  class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0]({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } }); } }
  const manager = { getSessionId: () => 'fiction', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const session = { sessionId: 'fiction', agent: { sessionId: 'fiction', state: {}, abort() { aborted++; } }, messages: [], async prompt() {
    await tools.get('memory_search').execute('search', { query: 'fiction', kinds: [] });
    await assert.rejects(tools.get('memory_record').execute('record', { kind: 'action', text: 'fiction', evidence_labels: ['ref-000001'] }), /write_uncertain/);
    this.messages = [{ role: 'assistant', stopReason: 'aborted', content: [] }];
  } };
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession() { return { session }; } };
  const memory = { async searchCompact() { return compactResult(); },
    async enrich() { throw Object.assign(new Error('write_uncertain'), { code: 'write_uncertain', write_outcome_unknown: true }); } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'fiction', async syncThrough() { return { file: '/fiction' }; } },
    workDir: '/fiction', model: {}, memory, scope: 'fiction' });
  await assert.rejects(runtime.run({ throughEntryId: 'a', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fiction' }] }, receipt: { id: 'turn' } }), /distillation_incomplete/);
  assert.equal(aborted, 1);
});

for (const primary of [false, true]) test(`failed handle release ${primary ? 'preserves the earlier error' : 'prevents a successful interval'}`, async () => {
  const tools = new Map();
  class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0]({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } }); } }
  const manager = { getSessionId: () => 'fiction', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const session = { sessionId: 'fiction', agent: { sessionId: 'fiction', state: {} }, messages: [], async prompt() {
    await tools.get('memory_search').execute('search', { query: 'fiction', kinds: [] });
    if (primary) throw Object.assign(new Error('write_uncertain'), { code: 'write_uncertain', write_outcome_unknown: true });
    this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"result":"done_nothing_qualifies","reason":"fiction"}' }] }];
  } };
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession() { return { session }; } };
  const memory = { async searchCompact() { return compactResult(); }, async releaseCompact() { throw new Error('release_failed'); } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'fiction', async syncThrough() { return { file: '/fiction' }; } },
    workDir: '/fiction', model: {}, memory, scope: 'fiction' });
  await assert.rejects(runtime.run({ throughEntryId: 'a', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } }),
    primary ? /write_uncertain/ : /handle_release_unconfirmed/);
});

test('inaccessible scope cannot be selected through a memory-search argument', async () => {
  const seen = [];
  const memory = { async searchCompact(scope) { seen.push(scope); return compactResult(); } };
  const tools = createTurnTools({ scope: 'permitted', memory,
    turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fiction' }] }, receipt: { id: 'turn' } });
  await tools.search('Fiction', []);
  assert.deepEqual(seen, ['permitted']);
});
