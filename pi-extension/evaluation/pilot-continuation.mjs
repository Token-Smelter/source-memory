import { hash, verifySeal } from './seal.mjs';
import { scoreCase } from './scorer.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** Validate a retained candidate/baseline and an empty-control answer awaiting one specific repair. */
export function validateCaseContinuation({ report, reportSha256, seal, resultRows, outputRows, ledgerRows, item, originalPartial, originalSeal }) {
  const spec = verifySeal(seal, report?.seal_sha256), original = verifySeal(originalSeal, originalPartial?.descriptor?.sourceSealDigest), id = item?.publicCase?.id;
  if (!/^[a-f0-9]{64}$/.test(reportSha256 ?? '') || !Array.isArray(resultRows) || !Array.isArray(outputRows) || !Array.isArray(ledgerRows)
    || typeof id !== 'string' || report.resume?.partialCaseHandback?.caseId !== id
    || hash(report.resume.partialCaseHandback) !== hash(originalPartial.descriptor)) throw fail('handback_invalid');
  const rows = resultRows.filter(row => row.case_id === id), find = (arm, type) => rows.filter(row => row.arm === arm && row.type === type);
  const ca = find('candidate', 'answer'), cj = find('candidate', 'judgment'), ba = find('baseline', 'answer'), bj = find('baseline', 'judgment'), ea = find('empty', 'answer');
  if (rows.length !== 5 || [ca, cj, ba, bj, ea].some(group => group.length !== 1)) throw fail('handback_incomplete');
  if (hash(cj[0].score) !== originalPartial.descriptor.candidateScoreSha256 || hash(ba[0].answer) !== originalPartial.descriptor.baselineAnswerSha256
    || hash(ca[0]) !== hash(originalPartial.candidateAnswer) || hash(cj[0]) !== hash(originalPartial.candidateJudgment)
    || hash(ba[0]) !== hash(originalPartial.baselineAnswer) || bj[0].repair?.repairSealDigest !== seal.digest
    || bj[0].repair?.format !== 'scorer-r2-v3-specific-repair') throw fail('handback_seal_mismatch');
  const baseline = scoreCase({ seal: originalSeal, expectedDigest: originalSeal.digest, packet: item.packet, judgment: bj[0].judgment, trace: ba[0].answer.trace });
  if (hash(baseline) !== hash(bj[0].score)) throw fail('handback_score_mismatch');
  if (ea[0].answer?.caseId !== id || ea[0].answer?.condition !== 'empty' || ea[0].answer?.sealDigest !== seal.digest) throw fail('handback_seal_mismatch');
  scoreCase({ seal, expectedDigest: seal.digest, packet: item.packet, judgment: { clauses: [] }, trace: ea[0].answer.trace });
  const starts = ledgerRows.filter(row => row.type === 'started' && row.checkpoint === item.through
    && ((row.arm === 'baseline' && row.purpose === 'scorer') || (row.arm === 'empty' && ['answerer', 'scorer'].includes(row.purpose))));
  if (!starts.some(row => row.arm === 'baseline' && row.purpose === 'scorer' && row.task_version === 'scorer-r2-v3-specific-repair')
    || !starts.some(row => row.arm === 'empty' && row.purpose === 'answerer') || starts.filter(row => row.arm === 'empty' && row.purpose === 'scorer').length !== 2
    || starts.some(row => !ledgerRows.some(result => result.type === 'result' && result.id === row.id && result.outcome === 'received')
      || !outputRows.some(output => output.id === row.id && output.purpose === row.purpose && output.arm === row.arm && output.message))) throw fail('handback_outputs_missing');
  const baselineCall = starts.find(row => row.arm === 'baseline' && row.purpose === 'scorer');
  const baselineMessage = outputRows.find(row => row.id === baselineCall.id).message;
  const baselineTool = baselineMessage.content?.filter(row => row.type === 'toolCall' && row.name === 'submit_score') ?? [];
  if (baselineTool.length !== 1 || hash(baselineTool[0].arguments) !== hash(bj[0].judgment)) throw fail('handback_score_mismatch');
  const emptyCall = starts.filter(row => row.arm === 'empty' && row.purpose === 'scorer').at(-1);
  const previous = outputRows.find(row => row.id === emptyCall.id).message;
  const tools = previous.content?.filter(row => row.type === 'toolCall' && row.name === 'submit_score') ?? [];
  const offending = tools.length === 1 ? tools[0].arguments?.clauses?.filter(row => row.judgments?.support === 'pass'
    && Array.isArray(row.sourceIds) && row.sourceIds.length === 0) ?? [] : [];
  const clauseIds = offending.map(row => row.id);
  if (!clauseIds.length || clauseIds.some(id => typeof id !== 'string' || !id) || new Set(clauseIds).size !== clauseIds.length) throw fail('handback_repair_unbound');
  const snapshot = report.artifacts?.case_snapshots?.find(row => row.case_id === id);
  if (!snapshot || original.packets[id] !== spec.packets[id]) throw fail('handback_snapshot_invalid');
  const descriptor = { caseId: id, sourceRunId: report.run_id, sourceReportSha256: reportSha256, sourceSealDigest: seal.digest, sourceCodeSha: spec.codeSha,
    originalCaseSealDigest: originalSeal.digest, originalCaseCodeSha: original.codeSha, snapshotSha256: snapshot.sha256,
    resultsSha256: report.artifacts['case-results.jsonl'].sha256, outputsSha256: report.artifacts['model-outputs.jsonl'].sha256,
    ledgerSha256: report.artifacts['ledger.jsonl'].sha256, candidateScoreSha256: hash(cj[0].score), baselineScoreSha256: hash(bj[0].score),
    baselineAnswerSha256: hash(ba[0].answer), emptyAnswerSha256: hash(ea[0].answer), previousMessageSha256: hash(previous),
    offendingClauseIdSha256: hash(clauseIds), repairFormat: 'scorer-r2-v3-specific-repair', armOrigins: { candidate: originalSeal.digest, baseline: originalSeal.digest, empty: seal.digest } };
  return { descriptor, candidateAnswer: ca[0], candidateJudgment: cj[0], baselineAnswer: ba[0], baselineJudgment: bj[0], emptyAnswer: ea[0],
    previousMessage: previous, clauseIds, caseSnapshot: snapshot };
}
