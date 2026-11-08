import { prepareReferenceSnapshot } from './reference-import.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** Rebuild a diagnostic store only from a qualified candidate cut and the pinned reference labels. */
export function prepareReferenceInputs({ report, candidateSnapshot, candidateSnapshotSha256, reference, sourceKey, sourceSha256, caseId, through }) {
  if (!report || !candidateSnapshot || !reference || !/^[a-f0-9]{64}$/.test(candidateSnapshotSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(sourceSha256 ?? '') || ![sourceKey, caseId, through].every(value => typeof value === 'string' && value)) throw fail('reference_input_invalid');
  const coverage = report.coverage;
  if (report.status !== 'partial_reference_unavailable' || report.failure != null || coverage?.status !== 'complete' || !Array.isArray(coverage.dispositions)
    || !Number.isSafeInteger(coverage.scheduled) || coverage.scheduled < 1 || coverage.processed !== coverage.scheduled
    || coverage.dispositions.length !== coverage.scheduled || coverage.dispositions.some(row =>
      !['committed', 'abstained', 'ineligible_by_policy'].includes(row.disposition)
      || (row.disposition !== 'ineligible_by_policy' && row.search_incomplete !== false))) throw fail('candidate_run_unqualified');
  const matches = report.artifacts?.case_snapshots?.filter(row => row.case_id === caseId) ?? [];
  if (matches.length !== 1 || matches[0].sha256 !== candidateSnapshotSha256 || matches[0].through_entry_id !== through
    || report.artifacts?.source_snapshot?.sha256 !== sourceSha256 || !coverage.dispositions.some(row => row.through === through)
    || reference.source_key !== sourceKey || reference.source_sha256 !== sourceSha256
    || reference.case_id !== caseId || reference.through_entry_id !== through) throw fail('reference_binding_mismatch');
  const result = prepareReferenceSnapshot({ snapshot: candidateSnapshot, reference, sourceKey, through });
  return { ...result, qualification: 'prepared_not_evaluated', sourceSha256, candidateSnapshotSha256, caseId, through,
    limitation: 'Reference-store imports omit incompatible edges and unfit citations as itemized in the audit; semantic support remains unaudited.' };
}
