import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCaseContinuation } from '../pi-extension/evaluation/pilot-continuation.mjs';
import { sealComparison, hash } from '../pi-extension/evaluation/seal.mjs';
import { scoreCase } from '../pi-extension/evaluation/scorer.mjs';
import { fictionalSettings, fictionalCase, fictionalTrace, scoringPacket, clause } from '../pi-extension/evaluation/fictional.mjs';
import { UNKNOWN_ANSWER } from '../pi-extension/evaluation/answerer.mjs';

function fixture() {
  const oldSpec = fictionalSettings(); oldSpec.codeSha = 'a'.repeat(40);
  const oldSeal = sealComparison(oldSpec), currentSpec = structuredClone(oldSpec); currentSpec.codeSha = 'b'.repeat(40);
  const seal = sealComparison(currentSpec), packet = scoringPacket();
  const oldTrace = { ...fictionalTrace(), sealDigest: oldSeal.digest }, emptyTrace = { ...fictionalTrace(), sealDigest: seal.digest };
  const oldJudgment = { clauses: [clause('c', ['r1'])] }, oldScore = scoreCase({ seal: oldSeal, expectedDigest: oldSeal.digest, packet, judgment: oldJudgment, trace: oldTrace });
  const ca = { type: 'answer', case_id: 'c1', arm: 'candidate', answer: { caseId: 'c1', condition: 'candidate', sealDigest: oldSeal.digest, trace: oldTrace,
    answer: { text: UNKNOWN_ANSWER, citations: [] } } };
  const cj = { type: 'judgment', case_id: 'c1', arm: 'candidate', judgment: oldJudgment, score: oldScore };
  const ba = { type: 'answer', case_id: 'c1', arm: 'baseline', answer: { caseId: 'c1', condition: 'baseline', sealDigest: oldSeal.digest, trace: oldTrace,
    answer: { text: UNKNOWN_ANSWER, citations: [] } } };
  const bj = { type: 'judgment', case_id: 'c1', arm: 'baseline', judgment: oldJudgment, score: oldScore,
    repair: { format: 'scorer-r2-v3-specific-repair', repairSealDigest: seal.digest } };
  const ea = { type: 'answer', case_id: 'c1', arm: 'empty', answer: { caseId: 'c1', condition: 'empty', sealDigest: seal.digest, trace: emptyTrace,
    answer: { text: UNKNOWN_ANSWER, citations: [] } } };
  const originalPartial = { descriptor: { caseId: 'c1', sourceSealDigest: oldSeal.digest, candidateScoreSha256: hash(oldScore), baselineAnswerSha256: hash(ba.answer) },
    candidateAnswer: ca, candidateJudgment: cj, baselineAnswer: ba };
  const bad = id => ({ id, judgments: { support: 'pass' }, sourceIds: [] });
  const entries = [{ id: 1, arm: 'baseline', purpose: 'scorer', task_version: 'scorer-r2-v3-specific-repair',
    message: { content: [{ type: 'toolCall', name: 'submit_score', arguments: oldJudgment }] } },
  { id: 2, arm: 'empty', purpose: 'answerer', message: { content: [] } },
  { id: 3, arm: 'empty', purpose: 'scorer', message: { content: [{ type: 'toolCall', name: 'submit_score', arguments: { clauses: [bad('a')] } }] } },
  { id: 4, arm: 'empty', purpose: 'scorer', message: { content: [{ type: 'toolCall', name: 'submit_score', arguments: { clauses: [bad('a'), bad('b')] } }] } }];
  const ledgerRows = entries.flatMap(row => [{ type: 'started', id: row.id, checkpoint: 'a', arm: row.arm, purpose: row.purpose, task_version: row.task_version },
    { type: 'result', id: row.id, outcome: 'received' }]);
  const outputRows = entries.map(row => ({ id: row.id, arm: row.arm, purpose: row.purpose, message: row.message }));
  const report = { run_id: 'fiction', seal_sha256: seal.digest, resume: { partialCaseHandback: originalPartial.descriptor },
    artifacts: { case_snapshots: [{ case_id: 'c1', sha256: 'a'.repeat(64) }], 'case-results.jsonl': { sha256: 'b'.repeat(64) },
      'model-outputs.jsonl': { sha256: 'c'.repeat(64) }, 'ledger.jsonl': { sha256: 'd'.repeat(64) } } };
  return { report, reportSha256: 'e'.repeat(64), seal, resultRows: [ca, cj, ba, bj, ea], outputRows, ledgerRows,
    item: { through: 'a', publicCase: fictionalCase(), packet }, originalPartial, originalSeal: oldSeal };
}

test('continuation validates preserved candidate/baseline and binds all offending empty-control clauses', () => {
  const result = validateCaseContinuation(fixture());
  assert.deepEqual([result.clauseIds, result.descriptor.armOrigins.candidate, result.descriptor.armOrigins.empty],
    [['a', 'b'], result.originalSeal?.digest ?? result.descriptor.originalCaseSealDigest, result.descriptor.sourceSealDigest]);
});

test('continuation refuses a changed retained baseline score', () => {
  const f = fixture(); f.resultRows.find(row => row.arm === 'baseline' && row.type === 'judgment').score = { ...f.resultRows[1].score, usefulness: { credited: 0 } };
  assert.throws(() => validateCaseContinuation(f), /handback_score_mismatch/);
});
