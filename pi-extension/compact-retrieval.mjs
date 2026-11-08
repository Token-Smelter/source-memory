import { authorize, cosine, fuse, integer, text } from '../src/core.mjs';
import { embed, embeddingIdentity } from '../src/models.mjs';

const fail = code => Object.assign(new Error(code), { code });
const kinds = new Set(['decision', 'observation', 'outcome', 'question', 'intention', 'episode', 'action']);
const preview = value => {
  let result = '', bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 80) break;
    result += char;
    bytes += size;
  }
  return { text: result, text_truncated: result.length < value.length };
};

/** Rank record seeds without fetching bundles or original-source evidence. */
export async function searchCompactRecords(memory, scope, input) {
  authorize(memory.config, scope);
  const query = text(input?.query, 4000), limit = integer(input?.limit, 64, 1, 64);
  if (!Array.isArray(input?.kinds) || input.kinds.some(kind => !kinds.has(kind)) || new Set(input.kinds).size !== input.kinds.length) throw fail('invalid_input');
  if (!memory.store || typeof memory.store.lexicalStatus !== 'function' || typeof memory.store.getRecords !== 'function'
    || !memory.config.embedding) throw fail('search_unavailable');
  const lexicalState = await memory.store.lexicalStatus(scope, 'record');
  if (lexicalState?.status !== 'ready') throw fail('search_unavailable');
  const lexical = await memory.store.lexical(scope, 'record', query, 64, []);
  if (!Array.isArray(lexical) || lexical.length > 64 || lexical.some(row => row.kind !== 'record' || typeof row.id !== 'string')) throw fail('search_invalid');
  const key = embeddingIdentity(memory.config.embedding), [vector] = await embed(memory.config.embedding, [query]);
  const index = await memory.store.vectorIndexStatus(scope, 'record', vector.length);
  let nodes;
  if (index === 'online') {
    const result = await memory.store.indexedVectors(scope, 'record', key, vector, 64, null, [], { remaining: 14 });
    if (result.partial !== false || result.unindexed !== 0 || !Array.isArray(result.nodes)) throw fail('search_incomplete');
    nodes = result.nodes;
  } else if (index === 'missing') {
    const scanLimit = integer(memory.config.vector_scan_limit, 10000, 1, 100000);
    const scanned = await memory.store.vectors(scope, key, scanLimit + 1, [], 'record');
    const counts = await memory.store.vectorCounts(scope, 'record', key, []);
    if (!Array.isArray(scanned) || scanned.length > scanLimit || counts?.unindexed !== 0) throw fail('search_incomplete');
    nodes = scanned.map(row => ({ ...row, similarity: cosine(vector, row.embedding) })).filter(row => Number.isFinite(row.similarity))
      .sort((a, b) => b.similarity - a.similarity || a.uid.localeCompare(b.uid)).slice(0, 64);
  } else throw fail('search_incomplete');
  if (!Array.isArray(nodes) || nodes.length > 64 || nodes.some(row => typeof row.record_id !== 'string')) throw fail('search_invalid');
  const ranked = fuse({ record_lexical: lexical, record_vector: nodes.map(row => ({ kind: 'record', id: row.record_id, text: row.text })) });
  const records = await memory.store.getRecords(scope, ranked.map(row => row.id));
  if (!Array.isArray(records) || records.length !== ranked.length) throw fail('search_incomplete');
  const byId = new Map(records.map(row => [row.id, row]));
  if (byId.size !== records.length || ranked.some(row => !byId.has(row.id))) throw fail('search_invalid');
  const matching = ranked.filter(row => !input.kinds.length || input.kinds.includes(byId.get(row.id).kind));
  const selected = matching.slice(0, limit).map(row => {
    const record = byId.get(row.id);
    if (!kinds.has(record.kind) || typeof record.text !== 'string' || typeof record.status !== 'string') throw fail('search_invalid');
    return { id: row.id, kind: record.kind, score: Number(row.score.toFixed(6)), ...preview(record.text) };
  });
  const lexicalCapped = lexical.length === 64, vectorCapped = nodes.length === 64;
  return { records: selected, ranked_count: matching.length, top_k_omitted: Math.max(0, matching.length - selected.length),
    filter_may_be_incomplete: input.kinds.length > 0 && (lexicalCapped || vectorCapped),
    channels: { record_lexical: { status: 'ready', candidate_limit_reached: lexicalCapped },
      record_vector: { status: 'ready', index, candidate_limit_reached: vectorCapped } } };
}
