import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { checkpointId, runPilotSequence } from '../pi-extension/evaluation/pilot-sequence.mjs';

test('failed checkpoint reporting names the attempted leaf rather than the previous cursor', () => {
  assert.equal(checkpointId({ through: 'attempted', cursor: 'previous' }), 'attempted');
});

test('a bounded search invalidates the run before any case is scored', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-pilot-incomplete-'));
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  try {
    let scored = false;
    const memory = journal.track({ async ingest() { return { id: 'turn' }; } });
    const session = { entries: [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: 'fiction', stopReason: 'stop' } }],
      conversation_id: 'fiction', scopes: ['private'], memory, distiller: { memory, async run() { return { status: 'complete', disposition: 'abstained',
        search_limitations: { incomplete: true, statuses: [{ status: 'budget_limited' }] } }; } } };
    const result = await runPilotSequence({ session, journal, checkpoints: [{ id: 'a', time: '2030-01-01T00:00:00Z' }],
      cases: [{ through: 'a', publicCase: { id: 'fiction', queryTime: '2030-01-01T00:00:01Z' } }], budget: { state: () => ({ stopped: null }) },
      async evaluateCase() { scored = true; } });
    assert.deepEqual([result.status, result.results[0].disposition, scored], ['invalid_search_truncation', 'abstained', false]);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a scored source checkpoint with a failed scorer stays explicitly partial', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-pilot-partial-'));
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  try {
    const memory = journal.track({ async ingest() { return { id: 'turn' }; } });
    const session = { entries: [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: 'fiction', stopReason: 'stop' } }],
      conversation_id: 'fiction', scopes: ['private'], memory, distiller: { memory, async run() { return { status: 'complete', disposition: 'abstained', search_limitations: { incomplete: false, statuses: [] } }; } } };
    const result = await runPilotSequence({ session, journal, checkpoints: [{ id: 'a', time: '2030-01-01T00:00:00Z' }],
      cases: [{ through: 'a', publicCase: { id: 'fiction', queryTime: '2030-01-01T00:00:01Z' } }], budget: { state: () => ({ stopped: null }) },
      async evaluateCase() { return { status: 'partial', failed_arms: ['baseline'] }; } });
    assert.deepEqual([result.status, result.cursor, result.evaluated[0].failed_arms], ['complete_with_partial_cases', 'a', ['baseline']]);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('pilot answers each case before processing the next source checkpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-pilot-sequence-'));
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  try {
    const events = [];
    const memory = journal.track({ async ingest(_scope, turn) { events.push(`ingest:${turn.entries.at(-1).id}`); return { id: 'turn' }; } });
    const session = { entries: [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: 'one', stopReason: 'stop' } },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: 'two', stopReason: 'stop' } }],
    conversation_id: 'fiction', scopes: ['private'], memory, distiller: { memory, async run() { return { status: 'complete', disposition: 'abstained', search_limitations: { incomplete: false, statuses: [] } }; } } };
    const result = await runPilotSequence({ session, journal, checkpoints: [{ id: 'a', time: '2030-01-01T00:00:00Z' }, { id: 'b', time: '2030-01-01T00:00:02Z' }],
      cases: [{ through: 'a', publicCase: { queryTime: '2030-01-01T00:00:01Z' } }], budget: { state: () => ({ stopped: null }) },
      async onCheckpoint(row) { events.push(`snapshot:${checkpointId(row)}`); },
      async evaluateCase() { events.push('answer:a'); return { status: 'scored' }; } });
    assert.deepEqual([result.status, events], ['complete', ['ingest:a', 'snapshot:a', 'answer:a', 'ingest:b', 'snapshot:b']]);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
