import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStageBatches } from '../pi-extension/evaluation/stage-reconcile.mjs';

const reference = { records: [{ id: 'r1' }, { id: 'r2' }] }, candidate = { records: [{ id: 'c1' }] };
const row = (id, items) => ({ id, message: { stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'submit_alignment', arguments: { items } }] } });
const ledger = [{ type: 'started', id: 1, checkpoint: 'batch-1' }, { type: 'result', id: 1, outcome: 'received' },
  { type: 'started', id: 2, checkpoint: 'batch-1' }, { type: 'result', id: 2, outcome: 'received' }];

test('reconciliation preserves uncertain candidate IDs as hints and chooses the earliest valid original submission', () => {
  const first = [{ reference_id: 'r1', verdict: 'uncertain', candidate_ids: ['c1'], reason: 'fiction' },
    { reference_id: 'r2', verdict: 'no_match', candidate_ids: [], reason: 'fiction' }];
  const second = [{ reference_id: 'r1', verdict: 'matched', candidate_ids: ['c1'], reason: 'fiction' }, first[1]];
  const result = reconcileStageBatches({ reference, candidate, outputs: [row(1, first), row(2, second)], ledger });
  assert.deepEqual([result.choices[0].source_call_id, result.alignments[0].verdict, result.uncertain_hint_count], [1, 'uncertain', 1]);
});

test('unoffered IDs remain invalid and yield explicit unknowns', () => {
  const invalid = [{ reference_id: 'r1', verdict: 'matched', candidate_ids: ['unknown'], reason: 'fiction' },
    { reference_id: 'r2', verdict: 'no_match', candidate_ids: [], reason: 'fiction' }];
  const result = reconcileStageBatches({ reference, candidate, outputs: [row(1, invalid)], ledger });
  assert.deepEqual([result.unresolved, result.alignments.map(row => row.verdict)], [[1], ['uncertain', 'uncertain']]);
});
