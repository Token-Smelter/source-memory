import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTools } from '../pi-extension/core.mjs';

test('a failed or degraded search cannot be converted into a record or successful search', async () => {
  let writes = 0;
  const memory = { async recall() { return { status: 'degraded', bundles: [] }; }, async enrich() { writes++; } };
  const tools = createTurnTools({ scope: 'fiction', requireSearch: true, memory,
    turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fiction' }] }, receipt: { id: 'turn' } });
  await assert.rejects(tools.search('Fiction', []), /search_incomplete/);
  await assert.rejects(tools.record('decision', 'Fiction', ['ref-000001']), /search_required/);
  assert.deepEqual([writes, tools.stats().search_failed], [0, true]);
});

test('inaccessible scope cannot be selected through a memory-search argument', async () => {
  const seen = [];
  const memory = { async recall(scope) { seen.push(scope); return { status: 'no_matches', bundles: [] }; } };
  const tools = createTurnTools({ scope: 'permitted', memory,
    turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fiction' }] }, receipt: { id: 'turn' } });
  await tools.search('Fiction', []);
  assert.deepEqual(seen, ['permitted']);
});
