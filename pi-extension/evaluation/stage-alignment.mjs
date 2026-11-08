const fail = code => Object.assign(new Error(code), { code });

/** Classify only provisional text alignments against the frozen pre-answer store and actual returned IDs. */
export function summarizeStage({ reference, candidate, alignments, cutoff, returnedIds }) {
  if (!Array.isArray(reference?.records) || !Array.isArray(reference?.relations) || !Array.isArray(candidate?.records)
    || !Array.isArray(candidate?.relations) || !Array.isArray(alignments) || !Number.isSafeInteger(cutoff) || cutoff < 1
    || !Array.isArray(returnedIds)) throw fail('stage_invalid');
  const refs = reference.records.filter(row => Number.isSafeInteger(row.checkpoint_index) && row.checkpoint_index <= cutoff);
  const candidates = candidate.records.filter(row => Number.isSafeInteger(row.checkpoint_index) && row.checkpoint_index <= cutoff);
  const candidateIds = new Set(candidates.map(row => row.id)), returned = new Set(returnedIds), map = new Map(alignments.map(row => [row.reference_id, row]));
  if (map.size !== alignments.length || refs.some(row => !map.has(row.id)) || returnedIds.some(id => !candidateIds.has(id))) throw fail('stage_invalid');
  const items = refs.map(row => {
    const match = map.get(row.id), ids = match.candidate_ids.filter(id => candidateIds.has(id));
    const status = match.verdict === 'uncertain' ? 'alignment_uncertain' : !ids.length ? 'not_stored_provisional'
      : ids.some(id => returned.has(id)) ? 'stored_and_returned_provisional' : 'stored_not_returned_provisional';
    return { reference_id: row.id, status, candidate_ids: ids,
      delayed_first_seen_provisional: ids.some(id => candidates.find(record => record.id === id).checkpoint_index > row.checkpoint_index) };
  });
  const itemMap = new Map(items.map(row => [row.reference_id, row])), ids = new Set(refs.map(row => row.id));
  const relations = reference.relations.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(edge => {
    const from = itemMap.get(edge.from), to = itemMap.get(edge.to);
    if (from.status === 'alignment_uncertain' || to.status === 'alignment_uncertain' || !from.candidate_ids.length || !to.candidate_ids.length)
      return { ...edge, status: 'endpoint_unmatched_or_uncertain' };
    const observed = candidate.relations.some(link => link.type === edge.type && from.candidate_ids.includes(link.from) && to.candidate_ids.includes(link.to));
    return { ...edge, status: observed ? 'directed_edge_observed_provisional' : 'directed_edge_not_observed_provisional' };
  });
  const count = (values, key) => Object.fromEntries([...new Set(values.map(row => row[key]))].sort().map(value => [value, values.filter(row => row[key] === value).length]));
  return { cutoff, reference_items: refs.length, candidate_items: candidates.length, returned_items: returned.size,
    item_counts: count(items, 'status'), relation_counts: count(relations, 'status'),
    delayed_first_seen_provisional: items.filter(row => row.delayed_first_seen_provisional).length,
    selection_reasoning: 'not_attributed', recovery: 'not_attributed',
    limitation: 'Model-proposed text alignments only; source support and semantic equivalence are not independently verified. Returned IDs are answerer retrieval, not distiller search traces.',
    items, relations };
}
