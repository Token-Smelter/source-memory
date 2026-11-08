import test from 'node:test';
import assert from 'node:assert/strict';
import { namespace } from '../src/core.mjs';
import { prepareReferenceInputs } from '../pi-extension/evaluation/reference-prepare.mjs';

function fixture() {
  const scope = 'fiction', sourceSha256 = 'a'.repeat(64), candidateSnapshotSha256 = 'b'.repeat(64);
  const report = { status: 'partial_reference_unavailable', coverage: { status: 'complete', scheduled: 1, processed: 1,
    dispositions: [{ through: 'a', disposition: 'abstained', search_incomplete: false }] },
  artifacts: { source_snapshot: { sha256: sourceSha256 }, case_snapshots: [{ case_id: 'fiction-case', sha256: candidateSnapshotSha256 }] } };
  const candidateSnapshot = { schema: 'source-memory-logical-snapshot/v1', scope, nodes: [{ uid: 'turn', labels: ['SMTurn', `${namespace(scope)}Turn`],
    properties: { uid: 'turn', scope, body: JSON.stringify({ entries: [{ id: 'entry', role: 'user', text: 'fictional evidence' }] }) } }], relationships: [] };
  const reference = { schema: 'source-memory-r2-reference-cut/v1', source_key: 'fiction-source', source_sha256: sourceSha256,
    case_id: 'fiction-case', scope, through_entry_id: 'a', records: [{ id: 'record', kind: 'observation', text: 'fiction',
      evidence: [{ source_key: 'fiction-source', entry_id: 'entry' }] }], edges: [] };
  return { report, candidateSnapshot, candidateSnapshotSha256, reference, sourceKey: 'fiction-source', sourceSha256, caseId: 'fiction-case', through: 'a' };
}

test('reference preparation derives a private plan from an explicitly complete candidate cut', () => {
  const result = prepareReferenceInputs(fixture());
  assert.deepEqual([result.qualification, result.audit.input_records, result.audit.imported_records], ['prepared_not_evaluated', 1, 1]);
});

test('reference preparation refuses an incomplete or unproven candidate search', () => {
  const input = fixture(); input.report.coverage.dispositions[0].search_incomplete = true;
  assert.throws(() => prepareReferenceInputs(input), /candidate_run_unqualified/);
  delete input.report.coverage.dispositions[0].search_incomplete;
  assert.throws(() => prepareReferenceInputs(input), /candidate_run_unqualified/);
});

test('reference preparation refuses a reference cut from a different source', () => {
  const input = fixture(); input.reference.source_sha256 = 'c'.repeat(64);
  assert.throws(() => prepareReferenceInputs(input), /reference_binding_mismatch/);
});
