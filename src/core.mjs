import { createHash } from 'node:crypto';

export class MemoryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Write provenance for an ingest/enrich failure: 'before_write' (raised before its write transaction began) or 'rolled_back'
// (raised inside it on the first attempt, so nothing committed). An unmarked failure may follow a commit.
export function markStage(error, stage) {
  if (error && typeof error === 'object' && error.stage === undefined) error.stage = stage;
  return error;
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
export const indexNames = scope => ({ turns: `smt_${digest(scope)}`, records: `smr_${digest(scope)}`, chunks: `smc_${digest(scope)}`,
  vectorChunks: `smvc_${digest(scope)}`, vectorRecords: `smvr_${digest(scope)}` });

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/u;

/** The segments of a path scope (1–8 segments of [A-Za-z0-9_-]{1,64}, at most 256 characters), or null for any other name. */
export function scopePath(scope) {
  if (typeof scope !== 'string' || scope.length > 256) return null;
  const segments = scope.split('/');
  return segments.length <= 8 && segments.every(segment => SEGMENT.test(segment)) ? segments : null;
}

// A path of depth 1 and any non-path (opaque) name keep their per-scope labels and indexes; deeper paths use the shared tree.
export const isNested = scope => (scopePath(scope)?.length ?? 0) >= 2;
const subtreeRoot = value => typeof value === 'string' && value.length <= 256 && value.endsWith('/**') && scopePath(value.slice(0, -3))
  ? value.slice(0, -3) : null;
export const isSelector = value => subtreeRoot(value) !== null;

const within = (root, path) => root.length <= path.length && root.every((segment, index) => segment === path[index]);

// A grant entry `A/**` (A a path) covers A and every descendant; any other entry grants exactly the name it spells.
function covered(grants, scope, exactAllowed) {
  if (exactAllowed && grants.includes(scope)) return true;
  const path = scopePath(scope);
  return path !== null && grants.some(entry => {
    const root = subtreeRoot(entry);
    return root !== null && within(root.split('/'), path);
  });
}

const grantsFor = (config, operation) => {
  requireThat(config.scopes && Array.isArray(config.scopes[operation]), 'scope_denied');
  return config.scopes[operation];
};

/** One exact scope. A subtree selector is never an exact scope, so it can never be written; a set is never one scope. */
export function authorize(config, scope, operation = 'read') {
  requireThat(!Array.isArray(scope), 'scope_denied');
  text(scope, 256);
  requireThat(!isSelector(scope) && covered(grantsFor(config, operation), scope, true), 'scope_denied');
  return scope;
}

/**
 * An exact scope (returned as the string) or a subtree selector `S/**` (returned as {scope:S, subtree:true}). A subtree is
 * granted only by a pattern on S or an ancestor: exact grants on its current members never add up to an open-ended subtree.
 */
export function authorizeTarget(config, value, operation = 'read') {
  const root = subtreeRoot(value);
  if (root === null) return authorize(config, value, operation);
  requireThat(covered(grantsFor(config, operation), root, false), 'scope_denied');
  return { scope: root, subtree: true };
}

export const SCOPE_SET_MAX = 4;
export const isScopeSet = target => typeof target === 'object' && target !== null && Array.isArray(target.scopes);

/**
 * A read selection: an exact scope or subtree as authorizeTarget gives it, or for an array of exact scopes a closed set
 * {scopes} in UTF-16 code-unit order. Every element needs its own read grant, so exact grants never add up to anything
 * open; one refused element refuses the whole read. A one-element array is that exact scope.
 */
export function authorizeSelection(config, value, operation = 'read') {
  if (!Array.isArray(value)) return authorizeTarget(config, value, operation);
  requireThat(value.length >= 1 && value.length <= SCOPE_SET_MAX, 'invalid_input');
  value.forEach(scope => text(scope, 256));
  requireThat(new Set(value).size === value.length, 'invalid_input');
  value.forEach(scope => authorize(config, scope, operation));
  return value.length === 1 ? value[0] : { scopes: [...value].sort() };
}

export const targetName = target => typeof target === 'string' ? target : `${target.scope}/**`;

export const scopeTerm = (scope, exact) => `${exact ? 'x' : 't'}${digest(['source-memory.scope/1', scope])}`;

/** Shared-tree filter terms of a path scope: one subtree term per ancestor-or-self and one exact term. */
export function scopeTerms(scope) {
  const path = scopePath(scope);
  requireThat(path !== null, 'scope_denied');
  return [...path.map((_, index) => scopeTerm(path.slice(0, index + 1).join('/'), false)), scopeTerm(scope, true)].join(' ');
}

/** Labels and indexes shared by every nested scope under one root segment; a selector never spans roots. */
export function treeLayout(root) {
  const d = digest(['source-memory.tree/1', root]);
  return { root, labels: { turn: `SMTree${d}Turn`, chunk: `SMTree${d}Chunk`, record: `SMTree${d}Record` },
    indexes: { turns: `smtree_t_${d}`, records: `smtree_r_${d}`, chunks: `smtree_c_${d}`, vectorChunks: `smtree_vc_${d}`, vectorRecords: `smtree_vr_${d}` } };
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

// Names the stored record contract: uid derivation, normalizeEnrichment output and the digest compared on replay. A change
// that alters a stored uid, body or hash for the same input is a new version; test/qualification.test.mjs pins version 1.
export const RECORD_CONTRACT = 'source-memory.record/1';

export const RECORD_KINDS = ['decision', 'observation', 'outcome', 'question', 'intention', 'episode', 'action'];
export const RECORD_STATUSES = ['proposed', 'accepted', 'observed'];

export const RELATIONS = ['supersedes', 'qualifies', 'contradicts', 'depends_on', 'outcome_of'];

// An outcome may result from something done, something decided or something intended; any other target is refused.
export const OUTCOME_REFERENT_KINDS = ['action', 'decision', 'intention'];

export function normalizeEnrichment(input) {
  requireThat(input && Array.isArray(input.records) && Array.isArray(input.relations));
  requireThat(input.records.length <= 128 && input.relations.length <= 256, 'enrichment_too_large');
  const recordIds = new Set();
  const records = input.records.map(record => {
    const id = text(record.id, 256);
    requireThat(!recordIds.has(id), 'duplicate_record');
    recordIds.add(id);
    const kind = text(record.kind, 32);
    requireThat(RECORD_KINDS.includes(kind), 'invalid_kind');
    const status = record.status ?? 'proposed';
    requireThat(RECORD_STATUSES.includes(status), 'invalid_status');
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

export const fuse = channels => fuseGroups([channels]);

/**
 * Reciprocal-rank fusion over channels run separately per index group: an item's rank in a channel is its rank in its own
 * group's result, and every item of a set read carries the scope that puts it in exactly one group.
 */
export function fuseGroups(groups) {
  const hits = new Map();
  for (const [channel, items] of groups.flatMap(channels => Object.entries(channels))) {
    const seen = new Set();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Only subtree hits carry a scope; a record id is unique only within its scope.
      const key = item.scope === undefined ? `${item.kind}:${item.id}` : JSON.stringify([item.kind, item.id, item.scope]);
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
  return [...hits.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || (a.scope ?? '').localeCompare(b.scope ?? ''));
}

export function lexicalQuery(query) {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.slice(0, 64).map(token => `"${token}"`).join(' OR ');
}
