import { authorize, integer, RELATIONS, text } from '../src/core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const kinds = new Set(['decision', 'observation', 'outcome', 'question', 'intention', 'episode', 'action']);
const requiredChannels = ['turn_lexical', 'record_lexical', 'chunk_lexical', 'chunk_vector', 'record_vector'];
const maxNodes = 48, maxHops = 4, maxEdges = maxNodes * 4;
const maxCards = 256, maxSummaryEdges = 512;
const preview = value => {
  let result = '';
  for (const char of value) {
    const next = result + char;
    if (Buffer.byteLength(JSON.stringify(next)) - 2 > 80) break;
    result = next;
  }
  return { text: result, text_truncated: result.length < value.length };
};
const edgeOrder = (a, b) => Number(b.type === 'supersedes') - Number(a.type === 'supersedes')
  || String(a.uid ?? a.id).localeCompare(String(b.uid ?? b.id));

/** Use the normal recall ranking, expanding graph metadata but never source evidence. */
export async function searchCompactRecords(memory, scope, input) {
  authorize(memory.config, scope);
  const query = text(input?.query, 4000), limit = integer(input?.limit, 48, 1, 48);
  if (!Array.isArray(input?.kinds) || input.kinds.some(kind => !kinds.has(kind)) || new Set(input.kinds).size !== input.kinds.length) throw fail('invalid_input');
  if (typeof memory.recall !== 'function' || typeof memory.store?.getRecords !== 'function'
    || typeof memory.store?.neighbors !== 'function' || typeof memory.store?.recordsForTurn !== 'function'
    || typeof memory.store?.lexicalStatus !== 'function') throw fail('search_unavailable');
  const lexicalStates = await Promise.all(['turn', 'record'].map(kind => memory.store.lexicalStatus(scope, kind)));
  if (lexicalStates.some(state => state?.status !== 'ready')) throw fail('search_incomplete');
  const result = await memory.recall(scope, { query, candidates: 64, limit: Math.min(limit, 32), max_chars: 24000 }, { seedsOnly: true });
  if (result?.scope !== scope || !Array.isArray(result.ranked) || result.ranked.length > 64 || !result.channels
    || requiredChannels.some(name => result.channels[name]?.status !== 'ready')
    || Object.values(result.channels).some(row => ['partial', 'pending', 'unavailable'].includes(row.status))) throw fail('search_incomplete');
  const channels = Object.fromEntries(Object.entries(result.channels).map(([name, value]) => [name, { status: value.status,
    ...(typeof value.candidate_limit_reached === 'boolean' ? { candidate_limit_reached: value.candidate_limit_reached } : {}),
    ...(value.reason ? { reason: value.reason } : {}) }]));
  const cards = new Map(), relations = new Map(), loaded = new Map(), adjacency = new Map(), gaps = new Set();
  const getRecord = async id => {
    if (loaded.has(id)) return loaded.get(id);
    const rows = await memory.store.getRecords(scope, [id]);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== id || rows[0].scope !== scope) throw fail('search_incomplete');
    loaded.set(id, rows[0]);
    return rows[0];
  };
  const neighbors = async id => {
    if (adjacency.has(id)) return adjacency.get(id);
    const rows = await memory.store.neighbors(scope, [id], maxEdges + 1);
    if (!Array.isArray(rows) || rows.length > maxEdges + 1 || rows.some(row => !row?.id || !RELATIONS.includes(row.type)
      || (row.from !== id && row.to !== id))) throw fail('search_incomplete');
    adjacency.set(id, rows);
    return rows;
  };
  const seeds = result.ranked.slice(0, limit);
  for (const seed of seeds) {
    if (!['turn', 'record'].includes(seed.kind) || typeof seed.id !== 'string' || !seed.id || !Number.isFinite(seed.score)
      || (seed.rerank_score !== undefined && !Number.isFinite(seed.rerank_score))) throw fail('search_incomplete');
    let initial = seed.kind === 'record' ? [await getRecord(seed.id)] : await memory.store.recordsForTurn(scope, seed.id, maxNodes + 1);
    if (!Array.isArray(initial)) throw fail('search_incomplete');
    if (initial.length > maxNodes) { gaps.add('node_limit'); initial = initial.slice(0, maxNodes); }
    const local = new Map(), localRelations = new Set(), visited = new Set();
    const add = (record, directlyRanked) => {
      if (!record || record.scope !== scope || typeof record.id !== 'string' || !record.id
        || !kinds.has(record.kind) || typeof record.text !== 'string' || typeof record.status !== 'string') throw fail('search_incomplete');
      if (local.has(record.id)) return true;
      if (local.size >= maxNodes) { gaps.add('node_limit'); return false; }
      if (!cards.has(record.id) && cards.size >= maxCards) { gaps.add('summary_node_limit'); return false; }
      local.set(record.id, record);
      loaded.set(record.id, record);
      const score = Number((seed.rerank_score ?? seed.score).toFixed(6));
      if (!cards.has(record.id)) cards.set(record.id, { id: record.id, kind: record.kind, score: directlyRanked ? score : null, ...preview(record.text) });
      else if (directlyRanked && cards.get(record.id).score === null) cards.get(record.id).score = score;
      return true;
    };
    for (const record of initial) add(record, true);
    let frontier = [...local.keys()];
    for (let hop = 0; hop <= maxHops && frontier.length; hop++) {
      const edges = new Map();
      for (const id of frontier) {
        const rows = await neighbors(id);
        if (rows.length > maxEdges) gaps.add('edge_limit');
        for (const edge of rows.slice(0, maxEdges)) edges.set(edge.id, edge);
        visited.add(id);
      }
      const ordered = [...edges.values()].sort(edgeOrder);
      if (ordered.length > maxEdges) gaps.add('edge_limit');
      const next = new Set();
      for (const edge of ordered.slice(0, maxEdges)) {
        const missing = [edge.from, edge.to].filter(id => !local.has(id));
        if (missing.length && hop === maxHops) { gaps.add('hop_limit'); continue; }
        if (local.size + missing.length > maxNodes) { gaps.add('node_limit'); continue; }
        if (missing.some(id => !cards.has(id)) && cards.size >= maxCards) { gaps.add('summary_node_limit'); continue; }
        for (const id of missing) add(await getRecord(id), false);
        if (!local.has(edge.from) || !local.has(edge.to)) continue;
        if (!localRelations.has(edge.id) && localRelations.size >= maxEdges) { gaps.add('edge_limit'); continue; }
        if (!relations.has(edge.id) && relations.size >= maxSummaryEdges) { gaps.add('summary_edge_limit'); continue; }
        localRelations.add(edge.id);
        relations.set(edge.id, { id: edge.id, type: edge.type, from: edge.from, to: edge.to });
        for (const id of [edge.from, edge.to]) if (!visited.has(id)) next.add(id);
      }
      frontier = [...next];
    }
  }
  const visible = new Set([...cards.values()].filter(row => !input.kinds.length || input.kinds.includes(row.kind)).map(row => row.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of relations.values()) if (visible.has(edge.from) !== visible.has(edge.to)) {
      visible.add(visible.has(edge.from) ? edge.to : edge.from); changed = true;
    }
  }
  const matching = [...cards.values()].filter(row => visible.has(row.id));
  const visibleEdges = [...relations.values()].filter(row => visible.has(row.from) && visible.has(row.to));
  const pairs = new Map();
  for (const edge of visibleEdges) {
    const key = JSON.stringify([edge.from, edge.to].sort());
    if (!pairs.has(key)) pairs.set(key, edge);
  }
  return { records: matching, edges: [...pairs.values()], ranked_count: matching.length, seed_count: seeds.length, declared_seed_limit: limit, candidate_pool_limit: 64,
    filtered_record_count: cards.size - matching.length, filtered_edge_count: relations.size - visibleEdges.length,
    collapsed_edge_count: visibleEdges.length - pairs.size,
    related_kind_count: input.kinds.length ? matching.filter(row => !input.kinds.includes(row.kind)).length : 0,
    graph_gaps: [...gaps].sort(), channels };
}
