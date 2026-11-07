import { hash, verifySeal } from './seal.mjs';
import { scoreCase } from './scorer.mjs';

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
