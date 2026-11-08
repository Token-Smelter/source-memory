import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { summarizeStage } from '../pi-extension/evaluation/stage-alignment.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  return {
    coverage: { status: 'complete', scheduled: 1, processed: 1, dispositions: [{ disposition: 'committed', search_incomplete: false }] },
    reference: { records: [{ id: 'r1', checkpoint_index: 1 }, { id: 'r2', checkpoint_index: 1 }, { id: 'r3', checkpoint_index: 2 }],
      relations: [{ from: 'r1', to: 'r2', type: 'qualifies' }, { from: 'r1', to: 'r3', type: 'depends_on' }] },
    candidate: { records: [{ id: 'c1', text: 'one', checkpoint_index: 1 }, { id: 'c2', text: 'two', checkpoint_index: 2 }],
      relations: [{ from: 'c1', to: 'c2', type: 'qualifies' }] },
    alignments: [{ reference_id: 'r1', verdict: 'matched', candidate_ids: ['c1'] },
      { reference_id: 'r2', verdict: 'matched', candidate_ids: ['c2'] }, { reference_id: 'r3', verdict: 'uncertain', candidate_ids: ['c1'] }],
    alignmentCandidateHashes: { c1: sha('one'), c2: sha('two') }, cutoff: 2, returnedIds: ['c1'],
  };
}

test('stage summaries distinguish returned items from provisional unmatched endpoints', () => {
  const out = summarizeStage(fixture());
  assert.deepEqual([out.item_counts, out.relation_counts],
    [{ alignment_uncertain: 1, stored_and_returned_provisional: 1, stored_not_returned_provisional: 1 },
      { directed_edge_observed_provisional: 1, endpoint_unmatched_or_uncertain: 1 }]);
});

test('invalid search coverage cannot produce a stage report', () => {
  const f = fixture(); f.coverage.dispositions[0].search_incomplete = true;
  assert.throws(() => summarizeStage(f), /candidate_run_unqualified/);
});

test('an uncertain hint never counts as a match', () => {
  const out = summarizeStage(fixture());
  assert.deepEqual(out.items.find(row => row.reference_id === 'r3').candidate_ids, []);
});

test('changed candidate text is uncertain rather than matched', () => {
  const f = fixture(); f.candidate.records[1].text = 'changed';
  assert.equal(summarizeStage(f).items.find(row => row.reference_id === 'r2').status, 'alignment_uncertain');
});

test('invalid verdicts and unverified checkpoint metadata are refused', () => {
  const f = fixture(); f.alignments[0].verdict = 'unknown';
  assert.throws(() => summarizeStage(f), /stage_invalid/);
  const g = fixture(); g.candidate.records[0].checkpoint_index = null;
  assert.throws(() => summarizeStage(g), /stage_invalid/);
});

test('a returned item outside the pre-answer snapshot is refused', () => {
  const f = fixture(); f.cutoff = 1; f.candidate.relations = []; f.returnedIds = ['c2'];
  assert.throws(() => summarizeStage(f), /stage_invalid/);
});
