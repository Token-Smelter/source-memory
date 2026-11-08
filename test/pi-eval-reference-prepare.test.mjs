import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('the private CLI reconstructs the plan from pinned fictional inputs without model calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-prepare-')), out = join(directory, 'out'); mkdirSync(out, { mode: 0o700 });
  const input = fixture(), sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const save = (name, value) => { const path = join(directory, name), bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(path, bytes, { mode: 0o600 }); return { path, sha256: sha(bytes) }; };
  try {
    const snapshot = save('snapshot.json', input.candidateSnapshot);
    input.report.artifacts.case_snapshots[0].sha256 = snapshot.sha256;
    const report = save('report.json', input.report), reference = save('reference.json', input.reference);
    const config = save('config.json', { schema: 'source-memory-reference-preparation/v1', split: 'development', report, snapshot, reference,
      source_key: input.sourceKey, source_sha256: input.sourceSha256, case_id: input.caseId, through_entry_id: input.through });
    const cli = fileURLToPath(new URL('../scripts/prepare-reference-store.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, config.path, config.sha256, out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout), audit = JSON.parse(readFileSync(receipt.audit.path));
    assert.deepEqual([receipt.status, receipt.model_calls, audit.imported_records], ['prepared_not_evaluated', 0, 1]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reference preparation refuses a reference cut from a different source', () => {
  const input = fixture(); input.reference.source_sha256 = 'c'.repeat(64);
  assert.throws(() => prepareReferenceInputs(input), /reference_binding_mismatch/);
});
