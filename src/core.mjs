import { createHash } from 'node:crypto';

export class MemoryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function requireThat(condition, code = 'invalid_input') {
  if (!condition) throw new MemoryError(code);
}

export function text(value, max = 1000, empty = false) {
  requireThat(typeof value === 'string' && (empty || value.length > 0) && value.length <= max);
  return value;
}

export function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : value;
  requireThat(Number.isSafeInteger(n) && n >= min && n <= max);
  return n;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const identity = (kind, scope, ...parts) => `${kind}_${digest([scope, ...parts])}`;
export const namespace = scope => `SMN${digest(scope)}`;
export const indexNames = scope => ({ turns: `smt_${digest(scope)}`, records: `smr_${digest(scope)}`, chunks: `smc_${digest(scope)}` });

export function authorize(config, scope, operation = 'read') {
  text(scope, 256);
  requireThat(config.scopes && Array.isArray(config.scopes[operation]) && config.scopes[operation].includes(scope), 'scope_denied');
  return scope;
}

function timestamp(value) {
  if (value === undefined || value === null) return null;
  text(value, 64);
  requireThat(Number.isFinite(Date.parse(value)), 'invalid_timestamp');
  return value;
}

export function normalizeTurn(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input));
  requireThat(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= 1024);
  const ids = new Set();
  let size = 0;
  const entries = input.entries.map(entry => {
    const id = text(entry.id, 256);
    requireThat(!ids.has(id), 'duplicate_entry');
    ids.add(id);
    const role = text(entry.role, 32);
    requireThat(['user', 'assistant', 'tool', 'system', 'derived'].includes(role), 'invalid_role');
    const body = text(entry.text, 2_000_000, true);
    size += Buffer.byteLength(body);
    return { id, role, text: body, occurred_at: timestamp(entry.occurred_at) };
  });
  requireThat(size <= 2_000_000, 'source_too_large');
  return {
    source: text(input.source, 256),
    conversation_id: text(input.conversation_id, 256),
    turn_id: text(input.turn_id, 256),
    parent_turn_id: input.parent_turn_id == null ? null : text(input.parent_turn_id, 256),
    // Only a caller that knows this is the first turn of its branch says so; a missing parent is otherwise unknown.
    // Absent unless true, so envelopes stored before this field existed keep their identity hash.
    ...(input.lineage_root === undefined ? {} : (requireThat(input.lineage_root === true && input.parent_turn_id == null, 'invalid_input'), { lineage_root: true })),
    occurred_at: timestamp(input.occurred_at),
    entries,
  };
}

export function chunkEntries(turn, size = 256, overlap = 32) {
  integer(size, 256, 8, 4096);
  integer(overlap, 32, 0, size - 1);
  const chunks = [];
  for (const entry of turn.entries) {
    const words = [...entry.text.matchAll(/\S+/gu)];
    for (let first = 0; first < words.length; first += size - overlap) {
      const last = Math.min(first + size, words.length) - 1;
      const start = words[first].index;
      const end = words[last].index + words[last][0].length;
      chunks.push({ entry_id: entry.id, role: entry.role, ordinal: chunks.length, start, end, text: entry.text.slice(start, end) });
      if (last === words.length - 1) break;
    }
  }
  return chunks;
}

export function normalizeSpan(span) {
  return {
    turn: text(span.turn, 100),
    entry_id: text(span.entry_id, 256),
    start: integer(span.start, undefined, 0, 2_000_000),
    end: integer(span.end, undefined, 1, 2_000_000),
  };
}

export function evidenceSpans(spans) {
  requireThat(Array.isArray(spans) && spans.length > 0 && spans.length <= 16, 'evidence_required');
  const normalized = spans.map(normalizeSpan);
  requireThat(normalized.every(span => span.end > span.start && span.end - span.start <= 16000)
    && normalized.reduce((sum, span) => sum + span.end - span.start, 0) <= 32000, 'evidence_too_large');
  return normalized;
}

export function sourceExcerpt(turn, span) {
  const entry = turn.entries.find(row => row.id === span.entry_id);
  requireThat(entry && span.start < span.end && span.end <= entry.text.length, 'invalid_evidence_span');
  // Offsets are UTF-16, but neither edge may split a Unicode surrogate pair.
  const splits = at => at > 0 && at < entry.text.length && /[\uD800-\uDBFF]/u.test(entry.text[at - 1]) && /[\uDC00-\uDFFF]/u.test(entry.text[at]);
  requireThat(!splits(span.start) && !splits(span.end), 'invalid_evidence_span');
  requireThat(entry.role !== 'derived', 'derived_is_not_original_evidence');
  return { ...span, role: entry.role, text: entry.text.slice(span.start, span.end), occurred_at: entry.occurred_at ?? turn.occurred_at };
}

export const RELATIONS = ['supersedes', 'qualifies', 'contradicts', 'depends_on', 'outcome_of'];

export function normalizeEnrichment(input) {
  requireThat(input && Array.isArray(input.records) && Array.isArray(input.relations));
  requireThat(input.records.length <= 128 && input.relations.length <= 256, 'enrichment_too_large');
  const recordIds = new Set();
  const records = input.records.map(record => {
    const id = text(record.id, 256);
    requireThat(!recordIds.has(id), 'duplicate_record');
    recordIds.add(id);
    const kind = text(record.kind, 32);
    requireThat(['decision', 'observation', 'outcome', 'question', 'intention', 'episode', 'action'].includes(kind), 'invalid_kind');
    const status = record.status ?? 'proposed';
    requireThat(['proposed', 'accepted', 'observed'].includes(status), 'invalid_status');
    return { id, kind, text: text(record.text, 16000), status, attribution: text(record.attribution, 512), evidence: evidenceSpans(record.evidence) };
  });
  const edgeIds = new Set();
  const relations = input.relations.map(edge => {
    const id = text(edge.id, 256);
    requireThat(!edgeIds.has(id), 'duplicate_relation');
    edgeIds.add(id);
    requireThat(RELATIONS.includes(edge.type), 'invalid_relation');
    const from = text(edge.from, 256);
    const to = text(edge.to, 256);
    requireThat(from !== to, 'self_relation');
    return { id, type: edge.type, from, to, attribution: text(edge.attribution, 512), evidence: evidenceSpans(edge.evidence) };
  });
  return { records, relations };
}

export function validateVector(vector, dimensions) {
  requireThat(Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite), 'invalid_embedding');
  requireThat(Math.hypot(...vector) > 0, 'invalid_embedding');
  return vector;
}

export function cosine(a, b) {
  if (a.length !== b.length) return -Infinity;
  const scaleA = Math.max(...a.map(Math.abs));
  const scaleB = Math.max(...b.map(Math.abs));
  if (!scaleA || !scaleB) return -Infinity;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] / scaleA;
    const y = b[i] / scaleB;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return dot / Math.sqrt(aa * bb);
}

export function fuse(channels) {
  const hits = new Map();
  for (const [channel, items] of Object.entries(channels)) {
    const seen = new Set();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = hits.get(key) ?? { ...item, score: 0, channels: [] };
      previous.score += 1 / (60 + i + 1);
      previous.channels.push({ channel, rank: i + 1 });
      if (item.match) previous.matches = [...(previous.matches ?? []),
        item.match.role === undefined ? item.match : { ...item.match, text: item.text }];
      hits.set(key, previous);
    }
  }
  return [...hits.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function lexicalQuery(query) {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.slice(0, 64).map(token => `"${token}"`).join(' OR ');
}
