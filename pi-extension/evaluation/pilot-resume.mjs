import { hash, verifySeal } from './seal.mjs';
import { ANSWERER_TOOLS_SHA256, SCORER_TOOLS_SHA256, ANSWERER_FORMAT_SUFFIX, SCORER_FORMAT_SUFFIX, ANSWERER_REPAIR, SCORER_REPAIR } from './pi-calls.mjs';

const fail = code => Object.assign(new Error(code), { code });
const clean = new Set(['committed', 'abstained', 'ineligible_by_policy']);

/** Check the immutable prefix and a reconciled gap before restoring any data. */
export function validatePilotResume({ report, seal, currentSeal, progress, journal, checkpoints, cases, cursor, snapshotSha256, journalSha256,
  sourceSha256, datasetSha256, priorLedgerSha256s, reconciliationSha256s = [], caseHandbacks = [] }) {
  if (!report || report.status !== 'failed_or_partial' || !Array.isArray(progress) || !Array.isArray(checkpoints) || !Array.isArray(cases)
    || !journal || !/^[a-f0-9]{64}$/.test(snapshotSha256 ?? '') || !/^[a-f0-9]{64}$/.test(journalSha256 ?? '')
    || !Array.isArray(priorLedgerSha256s)) throw fail('resume_invalid');
  const original = verifySeal(seal, report.seal_sha256);
  const current = verifySeal(currentSeal, currentSeal?.digest);
  const evaluatorChange = current.resume?.transition === 'structured-evaluator-submission-only';
  const clarification = current.resume?.transition === 'interpretation-02-abstention-clarification';
  if (!clarification && hash(original.interpretation ?? null) !== hash(current.interpretation ?? null)) throw fail('resume_treatment_mismatch');
  if (clarification && current.interpretation?.id !== 'INTERPRETATION-02') throw fail('resume_treatment_mismatch');
  const unchanged = ['policyVersion', 'policySha256', 'sourceSha256', 'datasetSha256', 'sdkSha256', 'rubric',
    'packetSchema', 'alternativeRule', 'baseline', 'stores', 'access', 'safety', 'cases', 'packets', 'dependenciesDigest', 'comparison', 'resampling',
    ...(!evaluatorChange ? ['answerer', 'scorer'] : [])];
  if (evaluatorChange) {
    const oldAnswerer = structuredClone(original.answerer), newAnswerer = structuredClone(current.answerer);
    const oldScorer = structuredClone(original.scorer), newScorer = structuredClone(current.scorer);
    if (newAnswerer.version !== 'answerer-r2-v2' || newAnswerer.tools_sha256 !== ANSWERER_TOOLS_SHA256
      || newAnswerer.repair_instruction !== ANSWERER_REPAIR || newAnswerer.limits?.formatRepairCalls !== 1
      || newAnswerer.instructions !== oldAnswerer.instructions + ANSWERER_FORMAT_SUFFIX
      || newScorer.version !== 'scorer-r2-v2' || newScorer.tools_sha256 !== SCORER_TOOLS_SHA256
      || newScorer.repair_instruction !== SCORER_REPAIR || newScorer.formatRepairCalls !== 1
      || newScorer.instructions !== oldScorer.instructions.replace('Return JSON only, without a code fence:', 'Use this JSON object schema:') + SCORER_FORMAT_SUFFIX) throw fail('resume_treatment_mismatch');
    for (const key of ['version', 'tools_sha256', 'repair_instruction', 'instructions']) { delete oldAnswerer[key]; delete newAnswerer[key]; }
    delete oldAnswerer.limits.formatRepairCalls; delete newAnswerer.limits.formatRepairCalls;
    for (const key of ['version', 'tools_sha256', 'repair_instruction', 'formatRepairCalls', 'instructions']) { delete oldScorer[key]; delete newScorer[key]; }
    if (hash(oldAnswerer) !== hash(newAnswerer) || hash(oldScorer) !== hash(newScorer)) throw fail('resume_treatment_mismatch');
  }
  if (unchanged.some(key => hash(original[key]) !== hash(current[key]))
    || ['candidate', 'reviewer', 'answerer', 'scorer'].some(key => original.budget.purposes[key]?.route !== current.budget.purposes[key]?.route)
    || current.resume?.priorRunId !== report.run_id || current.resume?.priorSealDigest !== seal.digest
    || current.resume?.priorCodeSha !== original.codeSha || current.resume?.cursor !== cursor
    || current.resume?.snapshotSha256 !== snapshotSha256 || current.resume?.journalSha256 !== journalSha256
    || !['structured-submission-format-only', 'deferred-bounded-indexing-only', 'remove-stale-input-cap-only', 'structured-evaluator-submission-only', 'retained-chunk-labels-and-case-handback', 'interpretation-02-abstention-clarification'].includes(current.resume?.transition)
    || hash(current.resume?.ledgerReconciliationSha256s ?? []) !== hash(reconciliationSha256s)
    || hash(current.resume?.caseHandbacks ?? []) !== hash(caseHandbacks)) throw fail('resume_treatment_mismatch');
  if (original.sourceSha256 !== sourceSha256 || original.datasetSha256 !== datasetSha256
    || report.artifacts?.source_snapshot?.sha256 !== sourceSha256
    || !priorLedgerSha256s.includes(report.artifacts?.['ledger.jsonl']?.sha256)) throw fail('resume_provenance_mismatch');
  const index = checkpoints.findIndex(row => row.id === cursor);
  if (index < 0 || index + 1 >= checkpoints.length) throw fail('resume_invalid');
  const handbackIds = new Set(caseHandbacks.map(row => row.caseId));
  if (handbackIds.size !== caseHandbacks.length) throw fail('handback_invalid');
  if (cases.some(item => checkpoints.findIndex(row => row.id === item.through) < index && !handbackIds.has(item.publicCase.id))) throw fail('resume_prior_cases_unsupported');
  const atCursor = cases.filter(item => item.through === cursor && !handbackIds.has(item.publicCase.id));
  for (const item of atCursor) {
    if (progress.some(row => row.type === 'case' && row.case_id === item.publicCase.id && row.status === 'scored')
      || !report.artifacts?.case_snapshots?.some(row => row.case_id === item.publicCase.id && row.sha256 === snapshotSha256)) throw fail('resume_case_snapshot_mismatch');
  }
  if (caseHandbacks.some(row => !cases.some(item => item.publicCase.id === row.caseId
    && checkpoints.findIndex(cp => cp.id === item.through) <= index))) throw fail('handback_invalid');
  const saved = report.artifacts?.checkpoint_snapshots?.filter(row => row.through === cursor && row.sha256 === snapshotSha256);
  const rows = progress.filter(row => row.type === 'checkpoint');
  const lastClean = rows.filter(row => clean.has(row.disposition)).at(-1);
  if (saved?.length !== 1 || lastClean?.through !== cursor || lastClean.snapshot?.sha256 !== snapshotSha256) throw fail('resume_snapshot_mismatch');
  let priorCursor = null;
  for (let i = 0; i <= index; i++) {
    const checkpoint = checkpoints[i];
    const state = journal.coveredDisposition({ through: checkpoint.id, cursor: priorCursor });
    const row = rows.find(item => item.through === checkpoint.id && clean.has(item.disposition));
    const reported = report.coverage?.dispositions?.[i] ?? rows.filter(item => clean.has(item.disposition))[i];
    if (!clean.has(state) || row?.disposition !== state || reported?.through !== checkpoint.id || reported.disposition !== state) throw fail('resume_coverage_mismatch');
    priorCursor = checkpoint.id;
  }
  const gap = journal.state();
  if (gap.status === 'uncertain' || gap.reconciliation_required) throw fail('resume_reconciliation_required');
  if (gap.status !== 'ready' && (gap.status !== 'failed' || gap.cursor !== cursor || gap.through !== checkpoints[index + 1].id)) throw fail('resume_gap_mismatch');
  return { priorRunId: report.run_id, priorSealDigest: seal.digest, priorCodeSha: original.codeSha,
    cursor, snapshotSha256, journalSha256, retryFirst: gap.status === 'failed', prefixCount: index + 1,
    transition: current.resume.transition, ledgerReconciliationSha256s: [...reconciliationSha256s], caseHandbacks };
}
