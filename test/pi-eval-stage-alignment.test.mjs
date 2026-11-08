import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStage } from '../pi-extension/evaluation/stage-alignment.mjs';

const reference = { records: [{ id: 'r1', checkpoint_index: 1 }, { id: 'r2', checkpoint_index: 1 }, { id: 'r3', checkpoint_index: 2 }],
  relations: [{ from: 'r1', to: 'r2', type: 'qualifies' }, { from: 'r1', to: 'r3', type: 'depends_on' }] };
const candidate = { records: [{ id: 'c1', checkpoint_index: 1 }, { id: 'c2', checkpoint_index: 2 }],
  relations: [{ from: 'c1', to: 'c2', type: 'qualifies' }] };
const alignments = [{ reference_id: 'r1', verdict: 'matched', candidate_ids: ['c1'] },
  { reference_id: 'r2', verdict: 'matched', candidate_ids: ['c2'] }, { reference_id: 'r3', verdict: 'uncertain', candidate_ids: [] }];

test('stage summaries distinguish returned items from provisional unmatched endpoints', () => {
  const out = summarizeStage({ reference, candidate, alignments, cutoff: 2, returnedIds: ['c1'] });
  assert.deepEqual([out.item_counts, out.relation_counts, out.delayed_first_seen_provisional],
    [{ alignment_uncertain: 1, stored_and_returned_provisional: 1, stored_not_returned_provisional: 1 },
      { directed_edge_observed_provisional: 1, endpoint_unmatched_or_uncertain: 1 }, 1]);
});

test('a returned item outside the pre-answer snapshot is refused', () => {
  assert.throws(() => summarizeStage({ reference, candidate, alignments, cutoff: 1, returnedIds: ['c2'] }), /stage_invalid/);
});
