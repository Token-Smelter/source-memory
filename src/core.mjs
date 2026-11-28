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

/** One exact scope. A subtree selector is never an exact scope, so it can never be written. */
export function authorize(config, scope, operation = 'read') {
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

// Bound UTF-8 input independently of whitespace tokenization. This is not a model tokenizer limit.
export const CHUNK_MAX_BYTES = 8192;

// Whitespace-separated words, each split on code points into parts of at most CHUNK_MAX_BYTES.
function byteBoundedWords(text) {
  const words = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const word = match[0];
    let start = match.index;
    const bytes = Buffer.byteLength(word);
    if (bytes <= CHUNK_MAX_BYTES) {
      words.push({ start, end: start + word.length, bytes });
      continue;
    }
    let end = start, partBytes = 0;
    for (const character of word) {
      const width = Buffer.byteLength(character);
      if (partBytes + width > CHUNK_MAX_BYTES) {
        words.push({ start, end, bytes: partBytes });
        start = end;
        partBytes = 0;
      }
      end += character.length;
      partBytes += width;
    }
    words.push({ start, end, bytes: partBytes });
  }
  return words;
}

export function chunkEntries(turn, size = 256, overlap = 32) {
  integer(size, 256, 8, 4096);
  integer(overlap, 32, 0, size - 1);
  const chunks = [];
  for (const entry of turn.entries) {
    const words = byteBoundedWords(entry.text);
    for (let first = 0; first < words.length;) {
      let last = first;
      let bytes = words[first].bytes;
      while (last + 1 < words.length && last + 1 - first < size) {
        const next = words[last + 1];
        const sinceLast = Buffer.byteLength(entry.text.slice(words[last].end, next.start)) + next.bytes;
        if (bytes + sinceLast > CHUNK_MAX_BYTES) break;
        bytes += sinceLast;
        last++;
      }
      const { start } = words[first];
      const { end } = words[last];
      chunks.push({ entry_id: entry.id, role: entry.role, ordinal: chunks.length, start, end, text: entry.text.slice(start, end) });
      if (last === words.length - 1) break;
      // Retain overlap only when it can fit at least one new segment; otherwise it repeats the same bytes.
      let nextFirst = last + 1;
      let windowBytes = words[nextFirst].bytes;
      while (nextFirst > first + 1 && last + 1 - nextFirst < overlap) {
        const previous = words[nextFirst - 1];
        const extra = previous.bytes + Buffer.byteLength(entry.text.slice(previous.end, words[nextFirst].start));
        if (windowBytes + extra > CHUNK_MAX_BYTES) break;
        windowBytes += extra;
        nextFirst--;
      }
      first = nextFirst;
    }
  }
  return chunks;
}

// Most chunks or gap spans one turn may derive. A larger derivation is recorded as a whole-entry gap, never clipped.
export const CHUNK_DERIVATION_MAX = 8192;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Largest index in (low, high] whose candidate fits, given that `low` itself fits. Every accepted index was counted, so the
// result fits even where subword counts are not monotone in prefix length.
function largestFitting(low, high, fitsAt) {
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fitsAt(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

// Units no larger than the token cap: byte-bounded words, with any word over the cap split on grapheme boundaries, then on
// code points. A code point that cannot fit alone becomes a gap unit.
function tokenBoundedUnits(text, fits) {
  const units = [];
  for (const word of byteBoundedWords(text)) {
    if (fits(text.slice(word.start, word.end))) { units.push(word); continue; }
    const cuts = [];
    for (const { index } of graphemes.segment(text.slice(word.start, word.end))) cuts.push(word.start + index);
    cuts.push(word.end);
    for (let at = 0; at < cuts.length - 1;) {
      if (!fits(text.slice(cuts[at], cuts[at + 1]))) {
        let start = cuts[at];
        for (const point of text.slice(cuts[at], cuts[at + 1])) {
          const end = start + point.length;
          units.push({ start, end, bytes: Buffer.byteLength(point), gap: !fits(point) });
          start = end;
        }
        at++;
        continue;
      }
      const last = largestFitting(at + 1, cuts.length - 1, next => fits(text.slice(cuts[at], cuts[next])));
      units.push({ start: cuts[at], end: cuts[last], bytes: Buffer.byteLength(text.slice(cuts[at], cuts[last])) });
      at = last;
    }
  }
  return units;
}

/**
 * Chunks whose exact rendered input fits `cap` tokens and CHUNK_MAX_BYTES bytes, plus typed gaps for source that cannot fit.
 * `counter.count` is the exact rendered count; `counter.bound` an upper bound that avoids counting short text. Offsets are
 * UTF-16 into the unchanged entry. Windows never span a gap; overlap is recounted with the final text.
 */
export function chunkEntriesTokenCapped(turn, size, overlap, counter, cap, max = CHUNK_DERIVATION_MAX) {
  integer(size, 256, 8, 4096);
  integer(overlap, 32, 0, size - 1);
  requireThat(Number.isSafeInteger(cap) && cap >= 1, 'invalid_chunk_token_cap');
  const fits = value => counter.bound(value) <= cap || counter.count(value) <= cap;
  const chunks = [];
  const gaps = [];
  for (const entry of turn.entries) {
    const units = tokenBoundedUnits(entry.text, fits);
    const span = (first, last) => entry.text.slice(units[first].start, units[last].end);
    for (let index = 0; index < units.length;) {
      if (units[index].gap) {
        const previous = gaps.at(-1);
        if (previous && previous.entry_id === entry.id && previous.end === units[index].start) previous.end = units[index].end;
        else gaps.push({ entry_id: entry.id, start: units[index].start, end: units[index].end, cause: 'unsplittable_unit' });
        if (chunks.length + gaps.length > max) return derivationTooLarge(turn);
        index++;
        continue;
      }
      let runEnd = index;
      while (runEnd + 1 < units.length && !units[runEnd + 1].gap) runEnd++;
      for (let first = index; first <= runEnd;) {
        let last = first;
        let bytes = units[first].bytes;
        while (last + 1 <= runEnd && last + 1 - first < size) {
          const sinceLast = Buffer.byteLength(entry.text.slice(units[last].end, units[last + 1].start)) + units[last + 1].bytes;
          if (bytes + sinceLast > CHUNK_MAX_BYTES) break;
          bytes += sinceLast;
          last++;
        }
        if (!fits(span(first, last))) last = largestFitting(first, last - 1, candidate => fits(span(first, candidate)));
        const text = span(first, last);
        chunks.push({ entry_id: entry.id, role: entry.role, ordinal: chunks.length, start: units[first].start, end: units[last].end,
          text, token_count: counter.count(text) });
        if (chunks.length + gaps.length > max) return derivationTooLarge(turn);
        if (last === runEnd) break;
        let nextFirst = last + 1;
        let windowBytes = units[nextFirst].bytes;
        // Overlap never exceeds half the previous window, so a short token-bound window cannot advance one unit at a time.
        const earliest = first + Math.max(1, Math.ceil((last + 1 - first) / 2));
        while (nextFirst > earliest && last + 1 - nextFirst < overlap) {
          const previous = units[nextFirst - 1];
          const extra = previous.bytes + Buffer.byteLength(entry.text.slice(previous.end, units[nextFirst].start));
          if (windowBytes + extra > CHUNK_MAX_BYTES) break;
          windowBytes += extra;
          nextFirst--;
        }
        // The next window must still reach a new unit, or the same text would repeat.
        while (nextFirst <= last && !fits(span(nextFirst, last + 1))) nextFirst++;
        first = nextFirst;
      }
      index = runEnd + 1;
      if (gaps.length + chunks.length > max) return derivationTooLarge(turn);
    }
  }
  return { chunks, gaps };
}

function derivationTooLarge(turn) {
  return { chunks: [], gaps: turn.entries.filter(entry => /\S/u.test(entry.text))
    .map(entry => ({ entry_id: entry.id, start: 0, end: entry.text.length, cause: 'derivation_bound_exceeded' })) };
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

export function fuse(channels) {
  const hits = new Map();
  for (const [channel, items] of Object.entries(channels)) {
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
