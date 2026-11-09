import { hash, verifySeal } from './seal.mjs';
import { scoreCase, validateAnswerCitationBinding } from './scorer.mjs';
import { CITATION_PROTOCOL } from './answerer.mjs';

const fail = code => Object.assign(new Error(code), { code });
const arms = ['candidate', 'baseline', 'empty', 'raw-only'];

/** Revalidate previously scored cases against their original seal, snapshot, outputs and ledger. */
export function validateCaseHandback({ report, reportSha256, seal, progress, resultRows, outputRows, ledgerRows, cases, checkpoints, cursor, sourceKey }) {
  const spec = verifySeal(seal, report?.seal_sha256);
  if (!Array.isArray(progress) || !Array.isArray(resultRows) || !Array.isArray(outputRows) || !Array.isArray(ledgerRows)
    || !Array.isArray(cases) || !Array.isArray(checkpoints) || typeof sourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(reportSha256 ?? '')) throw fail('handback_invalid');
  const index = checkpoints.findIndex(row => row.id === cursor);
  if (index < 0) throw fail('handback_invalid');
  const selected = cases.filter(item => checkpoints.findIndex(row => row.id === item.through) <= index);
  const descriptors = [], reportRows = [], carriedRows = [];
  for (const item of selected) {
    const id = item.publicCase.id;
    if (!progress.some(row => row.type === 'case' && row.case_id === id && row.status === 'scored')) throw fail('handback_incomplete');
    const snapshots = report.artifacts?.case_snapshots?.filter(row => row.case_id === id) ?? [];
    if (snapshots.length !== 1 || !/^[a-f0-9]{64}$/.test(snapshots[0].sha256 ?? '')) throw fail('handback_snapshot_invalid');
    const rows = resultRows.filter(row => row.case_id === id);
    if (rows.length !== 8) throw fail('handback_incomplete');
    const byArm = {};
    for (const arm of arms) {
      const answers = rows.filter(row => row.arm === arm && row.type === 'answer');
      const judgments = rows.filter(row => row.arm === arm && row.type === 'judgment');
      if (answers.length !== 1 || judgments.length !== 1) throw fail('handback_incomplete');
      const answer = answers[0].answer, verdict = judgments[0];
      if (answer?.caseId !== id || answer?.condition !== arm || answer?.sealDigest !== seal.digest
        || verdict.score?.sealDigest !== seal.digest || verdict.score.packetDigest !== spec.packets[id]) throw fail('handback_seal_mismatch');
      if (spec.answerer.citationProtocol === CITATION_PROTOCOL) validateAnswerCitationBinding(answer.answer, answer.trace);
      const recomputed = scoreCase({ seal, expectedDigest: seal.digest, packet: item.packet, judgment: verdict.judgment, trace: answer.trace });
      if (hash(recomputed) !== hash(verdict.score)) throw fail('handback_score_mismatch');
      const starts = ledgerRows.filter(row => row.type === 'started' && row.checkpoint === item.through && row.arm === arm
        && ['answerer', 'scorer'].includes(row.purpose));
      if (!starts.some(row => row.purpose === 'answerer') || !starts.some(row => row.purpose === 'scorer')
        || starts.some(row => !ledgerRows.some(result => result.type === 'result' && result.id === row.id && result.outcome === 'received')
          || !outputRows.some(output => output.id === row.id && output.purpose === row.purpose && output.arm === arm && output.message))) throw fail('handback_outputs_missing');
      byArm[arm] = verdict.score;
      carriedRows.push(answers[0], judgments[0]);
    }
    descriptors.push({ caseId: id, sourceRunId: report.run_id, sourceReportSha256: reportSha256, sourceSealDigest: seal.digest, sourceCodeSha: spec.codeSha,
      snapshotSha256: snapshots[0].sha256, resultsSha256: report.artifacts['case-results.jsonl'].sha256,
      outputsSha256: report.artifacts['model-outputs.jsonl'].sha256, ledgerSha256: report.artifacts['ledger.jsonl'].sha256 });
    reportRows.push({ caseId: id, sessions: [sourceKey], sealDigest: seal.digest, packetDigest: spec.packets[id], arms: byArm });
  }
  return { descriptors, reportRows, carriedRows, caseSnapshots: selected.map(item => report.artifacts.case_snapshots.find(row => row.case_id === item.publicCase.id)) };
}

/** Preserve a completed candidate arm and an already-generated baseline answer without replay. */
export function validatePartialCaseHandback({ report, reportSha256, seal, resultRows, outputRows, ledgerRows, item }) {
  const spec = verifySeal(seal, report?.seal_sha256), id = item?.publicCase?.id;
  if (!/^[a-f0-9]{64}$/.test(reportSha256 ?? '') || !Array.isArray(resultRows) || !Array.isArray(outputRows)
    || !Array.isArray(ledgerRows) || typeof id !== 'string') throw fail('handback_invalid');
  const rows = resultRows.filter(row => row.case_id === id);
  const find = (arm, type) => rows.filter(row => row.arm === arm && row.type === type);
  const ca = find('candidate', 'answer'), cj = find('candidate', 'judgment'), ba = find('baseline', 'answer');
  if (rows.length !== 3 || ca.length !== 1 || cj.length !== 1 || ba.length !== 1) throw fail('handback_incomplete');
  for (const [arm, row] of [['candidate', ca[0]], ['baseline', ba[0]]]) {
    if (row.answer?.caseId !== id || row.answer?.condition !== arm || row.answer?.sealDigest !== seal.digest) throw fail('handback_seal_mismatch');
    if (spec.answerer.citationProtocol === CITATION_PROTOCOL) validateAnswerCitationBinding(row.answer.answer, row.answer.trace);
    scoreCase({ seal, expectedDigest: seal.digest, packet: item.packet, judgment: { clauses: [] }, trace: row.answer.trace });
  }
  const candidate = scoreCase({ seal, expectedDigest: seal.digest, packet: item.packet, judgment: cj[0].judgment, trace: ca[0].answer.trace });
  if (hash(candidate) !== hash(cj[0].score)) throw fail('handback_score_mismatch');
  const starts = ledgerRows.filter(row => row.type === 'started' && row.checkpoint === item.through && ['candidate', 'baseline'].includes(row.arm)
    && ['answerer', 'scorer'].includes(row.purpose));
  if (!starts.some(row => row.arm === 'candidate' && row.purpose === 'answerer') || !starts.some(row => row.arm === 'candidate' && row.purpose === 'scorer')
    || !starts.some(row => row.arm === 'baseline' && row.purpose === 'answerer')
    || starts.some(row => !ledgerRows.some(result => result.type === 'result' && result.id === row.id && result.outcome === 'received')
    || !outputRows.some(output => output.id === row.id && output.purpose === row.purpose && output.arm === row.arm && output.message))) throw fail('handback_outputs_missing');
  const scorers = starts.filter(row => row.arm === 'baseline' && row.purpose === 'scorer');
  if (scorers.length !== 2) throw fail('handback_incomplete');
  const previous = outputRows.find(row => row.id === scorers.at(-1).id)?.message;
  const calls = previous?.content?.filter(part => part.type === 'toolCall' && part.name === 'submit_score') ?? [];
  const offending = calls.length === 1 ? calls[0].arguments?.clauses?.filter(row => row.judgments?.support === 'pass'
    && Array.isArray(row.sourceIds) && row.sourceIds.length === 0) ?? [] : [];
  if (offending.length !== 1 || typeof offending[0].id !== 'string' || !offending[0].id) throw fail('handback_repair_unbound');
  const snapshots = report.artifacts?.case_snapshots?.filter(row => row.case_id === id) ?? [];
  if (snapshots.length !== 1 || spec.packets[id] !== cj[0].score.packetDigest) throw fail('handback_snapshot_invalid');
  const descriptor = { caseId: id, sourceRunId: report.run_id, sourceReportSha256: reportSha256, sourceSealDigest: seal.digest,
    sourceCodeSha: spec.codeSha, snapshotSha256: snapshots[0].sha256, resultsSha256: report.artifacts['case-results.jsonl'].sha256,
    outputsSha256: report.artifacts['model-outputs.jsonl'].sha256, ledgerSha256: report.artifacts['ledger.jsonl'].sha256,
    candidateScoreSha256: hash(cj[0].score), baselineAnswerSha256: hash(ba[0].answer), previousMessageSha256: hash(previous),
    offendingClauseIdSha256: hash(offending[0].id), repairFormat: 'scorer-r2-v3-specific-repair' };
  return { descriptor, candidateAnswer: ca[0], candidateJudgment: cj[0], baselineAnswer: ba[0],
    previousMessage: previous, clauseId: offending[0].id, caseSnapshot: snapshots[0] };
}
