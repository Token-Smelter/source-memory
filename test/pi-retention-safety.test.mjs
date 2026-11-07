import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTools } from '../pi-extension/core.mjs';
import { createPiDistiller } from '../pi-extension/pi-runtime.mjs';

test('a failed or degraded search cannot be converted into a record or successful search', async () => {
  let writes = 0;
  const memory = { async recall() { return { status: 'degraded', bundles: [] }; }, async enrich() { writes++; } };
  const tools = createTurnTools({ scope: 'fiction', requireSearch: true, memory,
    turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fiction' }] }, receipt: { id: 'turn' } });
  await assert.rejects(tools.search('Fiction', []), /search_incomplete/);
  await assert.rejects(tools.record('decision', 'Fiction', ['ref-000001']), /search_required/);
  assert.deepEqual([writes, tools.stats().search_failed], [0, true]);
});

test('bounded search exposes omissions and channel status without increasing its budget', async () => {
  const inputs = [];
  const memory = { async recall(_scope, input) { inputs.push(input); return { status: 'budget_limited', budget_omitted: 2,
    retrieval_complete: false, channels: { record_lexical: { status: 'ready' }, chunk_vector: { status: 'partial' } },
    bundles: [{ records: [{ id: 'prior', kind: 'observation', text: 'fiction' }] }] }; } };
  const tools = createTurnTools({ scope: 'fiction', memory, turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fiction' }] }, receipt: { id: 'turn' } });
  const result = await tools.search('fiction', []);
  assert.deepEqual([inputs[0].max_chars, result.status, result.budget_omitted, result.channels.chunk_vector.status,
    result.records[0].id, tools.stats().incomplete_search], [24000, 'budget_limited', 2, 'partial', 'prior', true]);
});

test('an incomplete search without a returned prior cannot justify abstention', async () => {
  const tools = new Map();
  class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0]({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } }); } }
  const manager = { getSessionId: () => 'fiction', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const session = { sessionId: 'fiction', agent: { sessionId: 'fiction', state: {} }, messages: [], async prompt() {
    await tools.get('memory_search').execute('search', { query: 'fiction', kinds: [] });
    this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"disposition":"abstained"}' }] }];
  } };
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession() { return { session }; } };
  const memory = { async recall() { return { status: 'budget_limited', budget_omitted: 1, channels: { record_lexical: { status: 'ready' } }, bundles: [{ records: [] }] }; } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'fiction', async syncThrough() { return { file: '/fiction' }; } },
    workDir: '/fiction', model: {}, memory, scope: 'fiction' });
  await assert.rejects(runtime.run({ throughEntryId: 'a', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } }), /search_incomplete/);
});

test('inaccessible scope cannot be selected through a memory-search argument', async () => {
  const seen = [];
  const memory = { async recall(scope) { seen.push(scope); return { status: 'no_matches', bundles: [] }; } };
  const tools = createTurnTools({ scope: 'permitted', memory,
    turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fiction' }] }, receipt: { id: 'turn' } });
  await tools.search('Fiction', []);
  assert.deepEqual(seen, ['permitted']);
});
