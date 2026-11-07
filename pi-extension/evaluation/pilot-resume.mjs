import { hash, verifySeal } from './seal.mjs';

const fail = code => Object.assign(new Error(code), { code });
const clean = new Set(['committed', 'abstained', 'ineligible_by_policy']);

/** Check the immutable prefix and a reconciled gap before restoring any data. */
export function validatePilotResume({ report, seal, currentSeal, progress, journal, checkpoints, cases, cursor, snapshotSha256, journalSha256,
  sourceSha256, datasetSha256, priorLedgerSha256s }) {
  if (!report || report.status !== 'failed_or_partial' || !Array.isArray(progress) || !Array.isArray(checkpoints) || !Array.isArray(cases)
    || !journal || !/^[a-f0-9]{64}$/.test(snapshotSha256 ?? '') || !/^[a-f0-9]{64}$/.test(journalSha256 ?? '')
    || !Array.isArray(priorLedgerSha256s)) throw fail('resume_invalid');
  const original = verifySeal(seal, report.seal_sha256);
  const current = verifySeal(currentSeal, currentSeal?.digest);
  const unchanged = ['policyVersion', 'policySha256', 'sourceSha256', 'datasetSha256', 'sdkSha256', 'answerer', 'scorer', 'rubric',
    'packetSchema', 'alternativeRule', 'baseline', 'stores', 'access', 'safety', 'cases', 'packets', 'dependenciesDigest', 'comparison', 'resampling'];
  if (unchanged.some(key => hash(original[key]) !== hash(current[key]))
    || ['candidate', 'reviewer', 'answerer', 'scorer'].some(key => original.budget.purposes[key]?.route !== current.budget.purposes[key]?.route)
    || current.resume?.priorRunId !== report.run_id || current.resume?.priorSealDigest !== seal.digest
    || current.resume?.priorCodeSha !== original.codeSha || current.resume?.cursor !== cursor
    || current.resume?.snapshotSha256 !== snapshotSha256 || current.resume?.journalSha256 !== journalSha256
    || current.resume?.transition !== 'structured-submission-format-only') throw fail('resume_treatment_mismatch');
  if (original.sourceSha256 !== sourceSha256 || original.datasetSha256 !== datasetSha256
    || report.artifacts?.source_snapshot?.sha256 !== sourceSha256
    || !priorLedgerSha256s.includes(report.artifacts?.['ledger.jsonl']?.sha256)) throw fail('resume_provenance_mismatch');
  const index = checkpoints.findIndex(row => row.id === cursor);
  if (index < 0 || index + 1 >= checkpoints.length) throw fail('resume_invalid');
  if (cases.some(item => checkpoints.findIndex(row => row.id === item.through) <= index)) throw fail('resume_prior_cases_unsupported');
  const saved = report.artifacts?.checkpoint_snapshots?.filter(row => row.through === cursor && row.sha256 === snapshotSha256);
  const rows = progress.filter(row => row.type === 'checkpoint');
  const lastClean = rows.filter(row => clean.has(row.disposition)).at(-1);
  if (saved?.length !== 1 || lastClean?.through !== cursor || lastClean.snapshot?.sha256 !== snapshotSha256) throw fail('resume_snapshot_mismatch');
  let priorCursor = null;
  for (let i = 0; i <= index; i++) {
    const checkpoint = checkpoints[i];
    const state = journal.coveredDisposition({ through: checkpoint.id, cursor: priorCursor });
    const row = rows.find(item => item.through === checkpoint.id && clean.has(item.disposition));
    const reported = report.coverage?.dispositions?.[i];
    if (!clean.has(state) || row?.disposition !== state || reported?.through !== checkpoint.id || reported.disposition !== state) throw fail('resume_coverage_mismatch');
    priorCursor = checkpoint.id;
  }
  const gap = journal.state();
  if (gap.status === 'uncertain' || gap.reconciliation_required) throw fail('resume_reconciliation_required');
  if (gap.status !== 'ready' && (gap.status !== 'failed' || gap.cursor !== cursor || gap.through !== checkpoints[index + 1].id)) throw fail('resume_gap_mismatch');
  return { priorRunId: report.run_id, priorSealDigest: seal.digest, priorCodeSha: original.codeSha,
    cursor, snapshotSha256, journalSha256, retryFirst: gap.status === 'failed', prefixCount: index + 1,
    transition: 'structured-submission-format-only' };
}
