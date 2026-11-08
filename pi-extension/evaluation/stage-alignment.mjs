import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const textSha = value => createHash('sha256').update(value).digest('hex');
const nonempty = value => typeof value === 'string' && value.length > 0;
const types = new Set(['supersedes', 'qualifies', 'contradicts', 'depends_on', 'outcome_of']);

/** Summarize pre-existing, provisional alignments only against a verified, non-truncated run. */
export function summarizeStage({ coverage, reference, candidate, alignments, alignmentCandidateHashes, cutoff, returnedIds }) {
  if (!coverage || coverage.status !== 'complete' || !Array.isArray(coverage.dispositions)
    || !Number.isSafeInteger(coverage.scheduled) || coverage.scheduled < 1 || coverage.processed !== coverage.scheduled
    || coverage.dispositions.length !== coverage.scheduled || coverage.dispositions.some(row =>
      !['committed', 'abstained', 'ineligible_by_policy'].includes(row.disposition)
      || (row.disposition !== 'ineligible_by_policy' && row.search_incomplete !== false))) throw fail('candidate_run_unqualified');
  if (!Array.isArray(reference?.records) || !Array.isArray(reference?.relations) || !Array.isArray(candidate?.records)
    || !Array.isArray(candidate?.relations) || !Array.isArray(alignments) || !alignmentCandidateHashes || Array.isArray(alignmentCandidateHashes)
    || !Number.isSafeInteger(cutoff) || cutoff < 1 || !Array.isArray(returnedIds) || new Set(returnedIds).size !== returnedIds.length) throw fail('stage_invalid');
  const allRefs = new Map(), allCandidates = new Map();
  for (const row of reference.records) {
    if (!nonempty(row?.id) || allRefs.has(row.id) || !Number.isSafeInteger(row.checkpoint_index) || row.checkpoint_index < 1) throw fail('stage_invalid');
    allRefs.set(row.id, row);
  }
  for (const row of candidate.records) {
    if (!nonempty(row?.id) || allCandidates.has(row.id) || typeof row.text !== 'string'
      || !Number.isSafeInteger(row.checkpoint_index) || row.checkpoint_index < 1) throw fail('stage_invalid');
    allCandidates.set(row.id, row);
  }
  const map = new Map();
  for (const row of alignments) {
    if (!allRefs.has(row?.reference_id) || map.has(row.reference_id) || !['matched', 'no_match', 'uncertain'].includes(row.verdict)
      || !Array.isArray(row.candidate_ids) || new Set(row.candidate_ids).size !== row.candidate_ids.length
      || row.candidate_ids.some(id => !nonempty(id) || !/^[a-f0-9]{64}$/.test(alignmentCandidateHashes[id] ?? ''))
      || (row.verdict === 'matched' && row.candidate_ids.length === 0)
      || (row.verdict === 'no_match' && row.candidate_ids.length !== 0)) throw fail('stage_invalid');
    map.set(row.reference_id, row);
  }
  const refs = [...allRefs.values()].filter(row => row.checkpoint_index <= cutoff);
  if (refs.some(row => !map.has(row.id))) throw fail('stage_invalid');
  const candidates = new Map([...allCandidates].filter(([, row]) => row.checkpoint_index <= cutoff)), returned = new Set(returnedIds);
  if (returnedIds.some(id => !candidates.has(id))) throw fail('stage_invalid');
  const items = refs.map(row => {
    const alignment = map.get(row.id);
    if (alignment.verdict === 'uncertain') return { reference_id: row.id, status: 'alignment_uncertain', candidate_ids: [] };
    if (alignment.verdict === 'no_match') return { reference_id: row.id, status: 'no_match_provisional', candidate_ids: [] };
    const present = alignment.candidate_ids.filter(id => candidates.has(id));
    if (present.some(id => textSha(candidates.get(id).text) !== alignmentCandidateHashes[id])) {
      return { reference_id: row.id, status: 'alignment_uncertain', candidate_ids: [] };
    }
    return { reference_id: row.id, status: !present.length ? 'not_stored_provisional'
      : present.some(id => returned.has(id)) ? 'stored_and_returned_provisional' : 'stored_not_returned_provisional', candidate_ids: present };
  });
  const itemMap = new Map(items.map(row => [row.reference_id, row])), visibleRefs = new Set(refs.map(row => row.id));
  const relations = reference.relations.map(edge => {
    if (!allRefs.has(edge?.from) || !allRefs.has(edge?.to) || edge.from === edge.to || !types.has(edge.type)) throw fail('stage_invalid');
    return edge;
  }).filter(edge => visibleRefs.has(edge.from) && visibleRefs.has(edge.to)).map(edge => {
    const from = itemMap.get(edge.from), to = itemMap.get(edge.to);
    if (!from.candidate_ids.length || !to.candidate_ids.length) return { ...edge, status: 'endpoint_unmatched_or_uncertain' };
    const observed = candidate.relations.some(link => link.type === edge.type && from.candidate_ids.includes(link.from) && to.candidate_ids.includes(link.to));
    return { ...edge, status: observed ? 'directed_edge_observed_provisional' : 'directed_edge_not_observed_provisional' };
  });
  for (const edge of candidate.relations) if (!candidates.has(edge?.from) || !candidates.has(edge?.to) || edge.from === edge.to || !types.has(edge.type)) throw fail('stage_invalid');
  const count = values => Object.fromEntries([...new Set(values.map(row => row.status))].sort().map(value => [value, values.filter(row => row.status === value).length]));
  return { cutoff, reference_items: refs.length, candidate_items: candidates.size, returned_items: returned.size,
    item_counts: count(items), relation_counts: count(relations), selection_reasoning: 'not_attributed', recovery: 'not_attributed',
    limitation: 'Provisional alignments are not source-verified or causal. Returned IDs describe answerer retrieval, not distiller search.', items, relations };
}
