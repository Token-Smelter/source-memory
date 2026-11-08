export function compactResult({ records = [], status, budget_omitted = 0, edge_budget_omitted = 0, graph_gaps = [], channels, relations = [] } = {}) {
  const rows = records.map((row, index) => ({ handle: `record-${index}`, score: 0.01, text_truncated: false, ...row }));
  const names = ['turn_lexical', 'record_lexical', 'chunk_lexical', 'chunk_vector', 'record_vector'];
  return { status: status ?? (budget_omitted || edge_budget_omitted ? 'budget_limited' : rows.length ? 'ready' : 'no_matches'), records: rows, relations,
    ranked_count: rows.length + budget_omitted, seed_count: rows.length, declared_seed_limit: 64, budget_omitted, edge_budget_omitted,
    filtered_record_count: 0, filtered_edge_count: 0, related_kind_count: 0, graph_edge_count: relations.length + edge_budget_omitted, graph_gaps,
    relationship_context_complete: !graph_gaps.length && !budget_omitted && !edge_budget_omitted,
    channels: channels ?? Object.fromEntries(names.map(name => [name, { status: 'ready', candidate_limit_reached: false }])), completeness_guaranteed: false };
}
