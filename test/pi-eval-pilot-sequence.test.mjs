import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { runPilotSequence } from '../pi-extension/evaluation/pilot-sequence.mjs';

test('pilot answers each case before processing the next source checkpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-pilot-sequence-'));
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  try {
    const events = [];
    const memory = journal.track({ async ingest(_scope, turn) { events.push(`ingest:${turn.entries.at(-1).id}`); return { id: 'turn' }; } });
    const session = { entries: [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: 'one', stopReason: 'stop' } },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: 'two', stopReason: 'stop' } }],
    conversation_id: 'fiction', scopes: ['private'], memory, distiller: { memory, async run() { return { status: 'complete', disposition: 'abstained' }; } } };
    const result = await runPilotSequence({ session, journal, checkpoints: [{ id: 'a', time: '2030-01-01T00:00:00Z' }, { id: 'b', time: '2030-01-01T00:00:02Z' }],
      cases: [{ through: 'a', publicCase: { queryTime: '2030-01-01T00:00:01Z' } }], budget: { state: () => ({ stopped: null }) },
      async evaluateCase() { events.push('answer:a'); return { status: 'scored' }; } });
    assert.deepEqual([result.status, events], ['complete', ['ingest:a', 'answer:a', 'ingest:b']]);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
