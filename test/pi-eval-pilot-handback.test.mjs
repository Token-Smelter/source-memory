import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCaseHandback, validatePartialCaseHandback } from '../pi-extension/evaluation/pilot-handback.mjs';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';
import { scoreCase } from '../pi-extension/evaluation/scorer.mjs';
import { fictionalSettings, fictionalCase, fictionalTrace, scoringPacket, clause } from '../pi-extension/evaluation/fictional.mjs';
import { CITATION_PROTOCOL, UNKNOWN_ANSWER } from '../pi-extension/evaluation/answerer.mjs';
import { GROUNDING_PROTOCOL, CITED_RUBRIC_VERSION, CITED_RUBRIC, CITED_WORKED_EXAMPLES } from '../pi-extension/evaluation/rubric.mjs';

function fixture({ grounded = false } = {}) {
  const settings = fictionalSettings();
  if (grounded) {
    settings.answerer.citationProtocol = CITATION_PROTOCOL;
    settings.scorer.groundingProtocol = GROUNDING_PROTOCOL;
    settings.rubric = { version: CITED_RUBRIC_VERSION, instructions: CITED_RUBRIC, examples: CITED_WORKED_EXAMPLES };
  }
  const seal = sealComparison(settings), packet = scoringPacket(), trace = { ...fictionalTrace(), sealDigest: seal.digest },
    judgment = { clauses: grounded ? [] : [clause('c', ['r1'])] };
  const score = scoreCase({ seal, expectedDigest: seal.digest, packet, trace, judgment });
  const resultRows = [], ledgerRows = [], outputRows = [];
  for (const [i, arm] of ['candidate', 'baseline', 'empty', 'raw-only'].entries()) {
    resultRows.push({ type: 'answer', case_id: 'c1', arm, answer: { caseId: 'c1', condition: arm, sealDigest: seal.digest, trace,
      answer: { text: UNKNOWN_ANSWER, citations: [] } } },
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

test('partial case handback preserves candidate score, baseline answer and exact invalid scorer submission', () => {
  const f = fixture(), id = 'c1';
  const rows = f.resultRows.filter(row => row.arm === 'candidate' || (row.arm === 'baseline' && row.type === 'answer'));
  const bad = { id: 'bad-clause', judgments: { support: 'pass' }, sourceIds: [] };
  const message = { content: [{ type: 'toolCall', name: 'submit_score', arguments: { clauses: [bad] } }] };
  const prior = f.ledgerRows.filter(row => row.type !== 'started' || row.arm !== 'baseline' || row.purpose !== 'scorer');
  const starts = [{ type: 'started', id: 50, checkpoint: 'a', arm: 'baseline', purpose: 'scorer' },
    { type: 'started', id: 51, checkpoint: 'a', arm: 'baseline', purpose: 'scorer' }];
  const ledgerRows = [...prior.filter(row => ![4].includes(row.id)), ...starts,
    ...starts.map(row => ({ type: 'result', id: row.id, outcome: 'received' }))];
  const outputRows = [...f.outputRows.filter(row => row.id !== 4), ...starts.map(row => ({ id: row.id, arm: 'baseline', purpose: 'scorer', message }))];
  const result = validatePartialCaseHandback({ report: f.report, reportSha256: f.reportSha256, seal: f.seal, resultRows: rows,
    outputRows, ledgerRows, item: f.cases[0] });
  assert.deepEqual([result.descriptor.caseId, result.clauseId, result.candidateJudgment.score.usefulness.credited], [id, 'bad-clause', 1]);
});

test('case handback refuses a missing raw model output or altered score', () => {
  const f = fixture();
  assert.throws(() => validateCaseHandback({ ...f, outputRows: f.outputRows.slice(1) }), /handback_outputs_missing/);
  const rows = structuredClone(f.resultRows); rows.find(row => row.type === 'judgment').score.usefulness.credited = 0;
  assert.throws(() => validateCaseHandback({ ...f, resultRows: rows }), /handback_score_mismatch/);
  const bound = fixture({ grounded: true });
  const changedAnswer = structuredClone(bound.resultRows); changedAnswer.find(row => row.type === 'answer').answer.answer.text = 'Invented.';
  assert.throws(() => validateCaseHandback({ ...bound, resultRows: changedAnswer }), /citation_trace_invalid/);
});
