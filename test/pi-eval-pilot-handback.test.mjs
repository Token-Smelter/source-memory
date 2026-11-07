import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCaseHandback } from '../pi-extension/evaluation/pilot-handback.mjs';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';
import { scoreCase } from '../pi-extension/evaluation/scorer.mjs';
import { fictionalSettings, fictionalCase, fictionalTrace, scoringPacket, clause } from '../pi-extension/evaluation/fictional.mjs';

function fixture() {
  const seal = sealComparison(fictionalSettings()), packet = scoringPacket(), trace = fictionalTrace(), judgment = { clauses: [clause('c', ['r1'])] };
  const score = scoreCase({ seal, expectedDigest: seal.digest, packet, trace, judgment });
  const resultRows = [], ledgerRows = [], outputRows = [];
  for (const [i, arm] of ['candidate', 'baseline', 'empty', 'raw-only'].entries()) {
    resultRows.push({ type: 'answer', case_id: 'c1', arm, answer: { caseId: 'c1', condition: arm, sealDigest: seal.digest, trace } },
      { type: 'judgment', case_id: 'c1', arm, judgment, score });
    for (const [j, purpose] of ['answerer', 'scorer'].entries()) {
      const id = i * 2 + j + 1;
      ledgerRows.push({ type: 'started', id, checkpoint: 'a', arm, purpose }, { type: 'result', id, outcome: 'received' });
      outputRows.push({ id, arm, purpose, message: { role: 'assistant' } });
    }
  }
  const report = { run_id: 'fiction-run', seal_sha256: seal.digest, artifacts: {
    case_snapshots: [{ case_id: 'c1', sha256: 'a'.repeat(64) }], 'case-results.jsonl': { sha256: 'b'.repeat(64) },
    'model-outputs.jsonl': { sha256: 'c'.repeat(64) }, 'ledger.jsonl': { sha256: 'd'.repeat(64) } } };
  return { report, reportSha256: 'e'.repeat(64), seal, progress: [{ type: 'case', case_id: 'c1', status: 'scored' }],
    resultRows, outputRows, ledgerRows, cases: [{ through: 'a', publicCase: fictionalCase(), packet }],
    checkpoints: [{ id: 'a' }, { id: 'b' }], cursor: 'b', sourceKey: 'fiction-source' };
}

test('case handback recomputes all arms under the original seal and binds the snapshot and outputs', () => {
  const result = validateCaseHandback(fixture());
  assert.deepEqual([result.descriptors.length, result.reportRows.length, result.carriedRows.length,
    result.descriptors[0].snapshotSha256, result.descriptors[0].outputsSha256], [1, 1, 8, 'a'.repeat(64), 'c'.repeat(64)]);
});

test('case handback refuses a missing raw model output or altered score', () => {
  const f = fixture();
  assert.throws(() => validateCaseHandback({ ...f, outputRows: f.outputRows.slice(1) }), /handback_outputs_missing/);
  const rows = structuredClone(f.resultRows); rows.find(row => row.type === 'judgment').score.usefulness.credited = 0;
  assert.throws(() => validateCaseHandback({ ...f, resultRows: rows }), /handback_score_mismatch/);
});
