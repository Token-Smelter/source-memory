export function compactResult({ records = [], status, budget_omitted = 0, top_k_omitted = 0, channels } = {}) {
  const rows = records.map((row, index) => ({ handle: `record-${index}`, score: 0.01, text_truncated: false, ...row }));
  return { status: status ?? (budget_omitted ? 'budget_limited' : rows.length ? 'ready' : 'no_matches'), records: rows,
    ranked_count: rows.length + budget_omitted + top_k_omitted, budget_omitted, top_k_omitted,
    channels: channels ?? { record_lexical: { status: 'ready', candidate_limit_reached: false }, record_vector: { status: 'ready', candidate_limit_reached: false } },
    filter_may_be_incomplete: false, relationship_context: 'not_loaded', completeness_guaranteed: false };
}
