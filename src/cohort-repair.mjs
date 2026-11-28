import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import neo4j from 'neo4j-driver';
import { canonical, CHUNK_MAX_BYTES, digest, identity, integer, MemoryError, normalizeTurn, requireThat, validateVector } from './core.mjs';
import { chunkPolicy, DEFAULT_CHUNK_TOKEN_CAP, deriveChunks, TOKEN_POLICY, verifiedCounter } from './chunk-policy.mjs';
import { embeddingIdentity, localEndpoint, localJson } from './models.mjs';

// Names this repair's file and receipt formats. One owner-run repair of a frozen cohort of derived chunks in one scope: the
// chunks whose stored text is over an explicitly chosen token threshold or over CHUNK_MAX_BYTES, across T turns that predate
// first-retain manifests. It freezes the exact preimage, stages token-capped replacements with full-input vectors, swaps them
// in one guarded transaction, and keeps the exact inverse. Turns, entries, spans, records and relations are not touched.
export const REPAIR_CONTRACT = 'source-memory.cohort-repair/1';
// The selection threshold is chosen by the owner, never implied: over the 1,920-token cap (retroactive margin) or over the
// 2,048-token context (current exposure). A chunk in 1,921–2,048 is a target only under 1,920.
export const THRESHOLDS = Object.freeze([DEFAULT_CHUNK_TOKEN_CAP, 2048]);
export const PAGE_MAX = 500;
// The write transaction's own timeout; the plan's caps keep the swap well inside it.
const WRITE_TIMEOUT_MS = 120_000;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROPERTY_TYPES = ['STRING', 'BOOLEAN', 'INTEGER', 'FLOAT', 'ZONED DATETIME', 'LIST<FLOAT>', 'LIST<INTEGER>', 'LIST<STRING>'];
// Properties a first retain under a chunk policy writes; a turn carrying any of them has a manifest this repair would break.
const MANIFEST_PROPERTIES = ['chunk_policy', 'chunk_policy_digest', 'chunk_qualification', 'chunk_count', 'chunk_gap_count',
  'chunk_manifest', 'chunk_manifest_digest', 'chunk_manifest_status'];

// The property's type with nullability annotations removed, e.g. `LIST<FLOAT NOT NULL> NOT NULL` -> `LIST<FLOAT>`.
const baseType = type => String(type).replaceAll(' NOT NULL', '');

/** One node's exact stored state: labels and typed properties, in a canonical, digestible form. Integers stay decimal strings. */
function nodeState(labels, typed) {
  const properties = {};
  for (const { k, t, v } of typed) {
    const type = baseType(t);
    // `__proto__` would not survive as an own property of a plain object, so it is refused like any unsupported state.
    requireThat(SAFE_NAME.test(k) && k !== '__proto__' && !Object.hasOwn(properties, k) && PROPERTY_TYPES.includes(type), 'repair_unsupported_property');
    // JSON keeps every finite double exactly except negative zero; a value JSON cannot carry is refused before any write.
    const exactFloat = x => Number.isFinite(x) && !Object.is(x, -0);
    requireThat(type !== 'FLOAT' || exactFloat(v), 'repair_unsupported_property');
    requireThat(type !== 'LIST<FLOAT>' || (Array.isArray(v) && v.every(exactFloat)), 'repair_unsupported_property');
    properties[k] = { type, value: v };
  }
  requireThat(labels.every(label => SAFE_NAME.test(label)), 'repair_unsupported_label');
  return { labels: [...labels].sort(), properties };
}
const stateDigest = state => digest(canonical(state));
const textDigest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const value = (state, key) => state.properties[key]?.value;
// A stored integer offset or ordinal as a JS number: an INTEGER (held as a decimal string) or an integral FLOAT, nonnegative
// and safe. Any other type or value is refused rather than coerced.
const numeric = (state, key) => {
  const property = state.properties[key];
  requireThat(property && ['INTEGER', 'FLOAT'].includes(property.type), 'repair_target_changed');
  const n = property.type === 'INTEGER' ? (/^\d{1,16}$/u.test(property.value) ? Number(property.value) : NaN) : property.value;
  requireThat(Number.isSafeInteger(n) && n >= 0, 'repair_target_changed');
  return n;
};

// A UTF-16 offset that does not split a surrogate pair.
const boundary = (text, at) => at === 0 || at === text.length
  || !(/[\uD800-\uDBFF]/u.test(text[at - 1]) && /[\uDC00-\uDFFF]/u.test(text[at]));

// Values are returned in a lossless form: integers as decimal strings (the store driver would round large ones), datetimes as
// ISO strings with their zone.
const TYPED = node => `[k IN keys(${node}) | {k: k, t: valueType(${node}[k]), v: CASE
  WHEN valueType(${node}[k]) STARTS WITH 'ZONED DATETIME' THEN toString(${node}[k])
  WHEN valueType(${node}[k]) STARTS WITH 'INTEGER' THEN toString(${node}[k])
  WHEN valueType(${node}[k]) STARTS WITH 'LIST<INTEGER' THEN [i IN ${node}[k] | toString(i)]
  ELSE ${node}[k] END}]`;

// A chunk's stored vector, classified inside the database so no vector values are returned: `current` under this key with
// exactly `dimensions` finite numbers, not all zero; `stale` for a numeric list under another key; `absent` for none.
// Anything else is `invalid` and refuses the freeze. Absent and stale are kept apart throughout.
const VECTOR_STATE = `CASE WHEN c.embedding IS NULL THEN 'absent'
  WHEN NOT (valueType(c.embedding) STARTS WITH 'LIST<FLOAT' OR valueType(c.embedding) STARTS WITH 'LIST<INTEGER')
    OR size(c.embedding) = 0 THEN 'invalid'
  WHEN c.embedding_key IS NULL THEN 'invalid'
  WHEN c.embedding_key = $key THEN CASE WHEN size(c.embedding) = $dimensions
    AND all(x IN c.embedding WHERE x >= -1.7976931348623157e308 AND x <= 1.7976931348623157e308)
    AND any(x IN c.embedding WHERE x <> 0)
    THEN 'current' ELSE 'invalid' END
  ELSE 'stale' END`;
const VECTOR_STATES = ['absent', 'stale', 'current'];

export async function storeIdentity(tx) {
  const info = (await tx.run('CALL db.info() YIELD id, name RETURN id, name')).records;
  requireThat(info.length === 1, 'repair_target_changed');
  return { system: 'neo4j', database_id: info[0].get('id'), database: info[0].get('name') };
}

/**
 * Refuses inside the transaction, before any lock or content read, unless it runs on the expected physical store. A wrong
 * store is therefore never locked or read beyond its identity.
 */
export async function requireStore(tx, expected) {
  requireThat(canonical(await storeIdentity(tx)) === canonical(expected), 'repair_store_mismatch');
}

/**
 * One turn and every derived chunk linked to it, with each chunk's exact state and every relationship it has (type,
 * direction, other end, property count). A chunk linked from the turn but bound to another scope or turn is refused before
 * any of its content is read.
 */
export async function readTurn(tx, scope, turnUid) {
  const turns = await tx.run(`MATCH (t:SMTurn {uid:$turn, scope:$scope}) RETURN labels(t) AS labels, ${TYPED('t')} AS typed`, { scope, turn: turnUid });
  requireThat(turns.records.length === 1, 'repair_target_changed');
  const turn = nodeState(turns.records[0].get('labels'), turns.records[0].get('typed'));
  const misbound = await tx.run(`MATCH (t:SMTurn {uid:$turn, scope:$scope})-[:SM_HAS_CHUNK]->(c)
    WHERE NOT c:SMChunk OR c.scope IS NULL OR c.scope <> $scope OR c.turn_uid IS NULL OR c.turn_uid <> $turn RETURN count(c) AS n`,
  { scope, turn: turnUid });
  requireThat(Number(misbound.records[0].get('n')) === 0, 'repair_target_misbound');
  const rows = await tx.run(`MATCH (t:SMTurn {uid:$turn, scope:$scope})-[:SM_HAS_CHUNK]->(c:SMChunk {scope:$scope, turn_uid:$turn})
    RETURN c.uid AS uid, labels(c) AS labels, ${TYPED('c')} AS typed,
      [(c)-[r]-(o) | {type: type(r), incoming: endNode(r) = c, from_turn: o = t, properties: size(keys(r))}] AS links
    ORDER BY c.uid`, { scope, turn: turnUid });
  const chunks = rows.records.map(record => ({ uid: record.get('uid'),
    links: record.get('links').map(link => ({ ...link, properties: Number(link.properties) }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b))),
    state: nodeState(record.get('labels'), record.get('typed')) }));
  return { turn, chunks };
}

/**
 * Scope counts as one fingerprint. It detects count-changing writes in the scope; it does not detect a same-count update of
 * another row, so writer exclusion remains a hard external requirement of the owner, not something this check provides.
 */
async function scopeFingerprint(tx, scope, embeddingKey) {
  const missing = 'n.embedding IS NULL OR n.embedding_key IS NULL OR n.embedding_key <> $key';
  // Each count is its own ungrouped aggregate, so a zero is a row and every key is always present.
  const [counts] = (await tx.run(`CALL { MATCH (n:SMTurn {scope:$scope}) RETURN count(n) AS turns }
    CALL { MATCH (n:SMChunk {scope:$scope}) RETURN count(n) AS chunks }
    CALL { MATCH (n:SMChunk {scope:$scope}) WHERE ${missing} RETURN count(n) AS chunks_without_current_vector }
    CALL { MATCH (n:SMRecord {scope:$scope}) RETURN count(n) AS records }
    CALL { MATCH (n:SMRecord {scope:$scope}) WHERE ${missing} RETURN count(n) AS records_without_current_vector }
    CALL { MATCH (n:SMRelation {scope:$scope}) RETURN count(n) AS relations }
    RETURN turns, chunks, chunks_without_current_vector, records, records_without_current_vector, relations`,
  { scope, key: embeddingKey })).records;
  const fingerprint = Object.fromEntries(['turns', 'chunks', 'chunks_without_current_vector', 'records', 'records_without_current_vector', 'relations']
    .map(kind => [kind, Number(counts.get(kind))]));
  requireThat(Object.values(fingerprint).every(Number.isSafeInteger), 'repair_target_changed');
  return fingerprint;
}

// The only link a repaired chunk may have: the turn's property-free SM_HAS_CHUNK edge into it.
const TURN_LINK = [{ type: 'SM_HAS_CHUNK', incoming: true, from_turn: true, properties: 0 }];
const onlyTurnLink = chunk => canonical(chunk.links) === canonical(TURN_LINK);

// One turn's binding: its own state, the named chunks' exact states and links, and every other linked chunk as one digest.
function turnBinding(snapshot, uids) {
  const named = snapshot.chunks.filter(chunk => uids.includes(chunk.uid));
  const siblings = snapshot.chunks.filter(chunk => !uids.includes(chunk.uid));
  return {
    turn_digest: stateDigest(snapshot.turn),
    chunks: named.map(chunk => ({ uid: chunk.uid, links: chunk.links, digest: stateDigest(chunk.state) })),
    siblings_digest: digest(canonical(siblings.map(chunk => [chunk.uid, chunk.links, stateDigest(chunk.state)]))),
  };
}

async function readOnly(driver, database, work, timeout = 60_000) {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const tx = session.beginTransaction({ timeout });
    try { return await work(tx); } finally { if (tx.isOpen()) await tx.rollback().catch(() => {}); }
  } finally { await session.close(); }
}

/** Finite absolute caps for one freeze, all required; nothing defaults to unbounded. */
export function freezeCaps(input) {
  requireThat(input && typeof input === 'object', 'invalid_input');
  return {
    max_rows: integer(input.max_rows, undefined, 1, 10_000_000),
    max_text_bytes: integer(input.max_text_bytes, undefined, 1, 100_000_000_000),
    max_pages: integer(input.max_pages, undefined, 1, 1_000_000),
    page_size: integer(input.page_size, undefined, 1, PAGE_MAX),
    max_seconds: integer(input.max_seconds, undefined, 1, 86_400),
    transaction_timeout_ms: integer(input.transaction_timeout_ms, undefined, 1, 600_000),
    max_turns: integer(input.max_turns, undefined, 1, 100_000),
    max_targets: integer(input.max_targets, undefined, 1, 100_000),
    max_target_bytes: integer(input.max_target_bytes, undefined, 1, 10_000_000_000),
  };
}

/**
 * Bounded discovery over one scope's chunks, before any turn is read: identifiers, parent turn, text and vector state, page
 * by page in separate read transactions, with every cap checked as it is reached. Tokens are counted locally with the
 * verified counter. A chunk is a target when its text is over `overTokens` tokens or over CHUNK_MAX_BYTES. A chunk without a
 * current vector inside both limits is not a target; it is counted for ordinary guarded indexing. Pages are separate reads,
 * so the scope total must be the same before and after and equal the rows seen; the freeze rechecks every target.
 */
export async function discover({ driver, database, scope, embeddingKey, dimensions, counter, overTokens, caps, deadline, clock }) {
  const remaining = () => Math.floor(deadline - clock());
  const timeout = () => { const left = Math.min(caps.transaction_timeout_ms, remaining()); requireThat(left > 0, 'repair_cap_seconds'); return left; };
  const total = () => readOnly(driver, database, async tx => Number((await tx.run('MATCH (c:SMChunk {scope:$scope}) RETURN count(c) AS n',
    { scope })).records[0].get('n')), timeout());
  const before = await total();
  requireThat(Number.isSafeInteger(before) && before <= caps.max_rows, 'repair_cap_rows');
  const targets = [];
  const vectorless = { absent: 0, stale: 0 };
  let rows = 0, pages = 0, bytes = 0, targetBytes = 0;
  for (let after = null; ;) {
    requireThat(pages < caps.max_pages, 'repair_cap_pages');
    const page = await readOnly(driver, database, async tx => (await tx.run(`MATCH (c:SMChunk {scope:$scope})
      WHERE $after IS NULL OR c.uid > $after
      RETURN c.uid AS uid, c.turn_uid AS turn_uid, c.text AS text, ${VECTOR_STATE} AS vector
      ORDER BY c.uid LIMIT $limit`, { scope, after, limit: neo4j.int(caps.page_size), key: embeddingKey, dimensions: neo4j.int(dimensions) })).records
      .map(record => ({ uid: record.get('uid'), turn_uid: record.get('turn_uid'), text: record.get('text'), vector: record.get('vector') })), timeout());
    pages++;
    requireThat(remaining() > 0, 'repair_cap_seconds');
    for (const row of page) {
      requireThat(typeof row.uid === 'string' && (after === null || row.uid > after), 'repair_target_changed');
      requireThat(typeof row.turn_uid === 'string' && typeof row.text === 'string', 'repair_target_misbound');
      requireThat(VECTOR_STATES.includes(row.vector), 'repair_unsupported_vector');
      after = row.uid;
      rows++;
      requireThat(rows <= caps.max_rows, 'repair_cap_rows');
      const size = Buffer.byteLength(row.text);
      bytes += size;
      requireThat(bytes <= caps.max_text_bytes, 'repair_cap_text_bytes');
      // The bound never undercounts, so a text whose bound fits needs no exact count.
      const tokens = counter.bound(row.text) <= overTokens ? null : counter.count(row.text);
      if (size > CHUNK_MAX_BYTES || (tokens !== null && tokens > overTokens)) {
        targets.push({ uid: row.uid, turn_uid: row.turn_uid, text_sha256: textDigest(row.text), bytes: size, tokens, vector: row.vector });
        targetBytes += size;
        requireThat(targets.length <= caps.max_targets, 'repair_cap_targets');
        requireThat(targetBytes <= caps.max_target_bytes, 'repair_cap_target_bytes');
      } else if (row.vector !== 'current') vectorless[row.vector]++;
    }
    if (page.length < caps.page_size) break;
  }
  const afterTotal = await total();
  requireThat(afterTotal === before && rows === before, 'repair_target_changed');
  const turns = [...new Set(targets.map(target => target.turn_uid))].sort();
  requireThat(turns.length <= caps.max_turns, 'repair_cap_turns');
  requireThat(targets.length > 0, 'repair_no_targets');
  return { rows, targets, turns, vectorless_within_limits: vectorless };
}

/**
 * Freezes the exact preimage of a cohort repair. Discovery runs first under the caps; only then does one read transaction,
 * which first checks the physical store, read the target turns. Every target turn must predate first-retain manifests and
 * carry only chunks bound to it. Every target must still have the discovered text and vector state, only the turn's
 * property-free link, and a stated span that equals its source exactly. The scope's chunk total must still equal the rows
 * discovered. The frozen record names the selection, the caps and every bound value; its digest is what the owner approves.
 */
export async function freeze({ driver, database, expectedStore, scope, embedding, overTokens, caps: input, verified, clock = () => performance.now() }) {
  const started = clock();
  requireThat(typeof expectedStore?.database_id === 'string' && typeof expectedStore.database === 'string', 'invalid_input');
  requireThat(THRESHOLDS.includes(overTokens), 'repair_threshold_required');
  const caps = freezeCaps(input);
  const deadline = started + caps.max_seconds * 1000;
  const policy = verified ? chunkPolicy({ embedding }, verified) : chunkPolicy({ embedding });
  const resolved = await verifiedCounter(policy);
  requireThat(resolved.counter, 'repair_tokenizer_unverified');
  const embeddingKey = embeddingIdentity(embedding);
  // The owner names the intended store; another one is refused before any chunk is read.
  const store = await readOnly(driver, database, async tx => {
    await requireStore(tx, { system: 'neo4j', database_id: expectedStore.database_id, database: expectedStore.database });
    return storeIdentity(tx);
  });
  const found = await discover({ driver, database, scope, embeddingKey, dimensions: embedding.dimensions, counter: resolved.counter,
    overTokens, caps, deadline, clock });
  const byTurn = new Map(found.turns.map(turnUid => [turnUid, found.targets.filter(target => target.turn_uid === turnUid)]));
  const frozenTurns = await readOnly(driver, database, async tx => {
    await requireStore(tx, store);
    const out = [];
    for (const [turnUid, discovered] of byTurn) {
      requireThat(clock() < deadline, 'repair_cap_seconds');
      const snapshot = await readTurn(tx, scope, turnUid);
      requireThat(MANIFEST_PROPERTIES.every(key => !(key in snapshot.turn.properties)), 'repair_turn_has_manifest');
      const body = JSON.parse(value(snapshot.turn, 'body'));
      const entries = new Map(body.entries.map(entry => [entry.id, entry]));
      const targets = [];
      for (const target of discovered) {
        const chunk = snapshot.chunks.find(item => item.uid === target.uid);
        requireThat(chunk, 'repair_target_changed');
        const text = value(chunk.state, 'text');
        const entry = entries.get(value(chunk.state, 'entry_id'));
        requireThat(onlyTurnLink(chunk), 'repair_unsupported_link');
        requireThat(typeof text === 'string' && textDigest(text) === target.text_sha256, 'repair_target_changed');
        requireThat(entry && entry.role === value(chunk.state, 'role'), 'repair_target_changed');
        // The stated interval itself must be valid: in bounds, the exact text length, on code-point boundaries. A slice
        // would clamp an out-of-range end instead.
        const start = numeric(chunk.state, 'start');
        const end = numeric(chunk.state, 'end');
        requireThat(start < end && end <= entry.text.length && end - start === text.length
          && boundary(entry.text, start) && boundary(entry.text, end) && entry.text.slice(start, end) === text, 'repair_target_changed');
        targets.push({ uid: chunk.uid, state: chunk.state, tokens: target.tokens, bytes: target.bytes, vector: target.vector });
      }
      // Replacements take new ordinals above every existing one in the turn: unique integers, so no sibling is renumbered
      // and the evidence-span reader, which requires a unique integer ordinal per entry, stays valid.
      const ordinalCeiling = Math.max(...snapshot.chunks.map(chunk => numeric(chunk.state, 'ordinal')));
      out.push({ turn_uid: turnUid, ordinal_ceiling: ordinalCeiling, preimage: turnBinding(snapshot, targets.map(target => target.uid)), targets });
    }
    const fingerprint = await scopeFingerprint(tx, scope, embeddingKey);
    requireThat(fingerprint.chunks === found.rows, 'repair_target_changed');
    return { turns: out, fingerprint };
  }, Math.min(caps.transaction_timeout_ms, Math.max(1, Math.floor(deadline - clock()))));
  requireThat(clock() < deadline, 'repair_cap_seconds');
  const byVector = Object.fromEntries(VECTOR_STATES.map(state => [state, found.targets.filter(target => target.vector === state).length]));
  const frozen = { contract: REPAIR_CONTRACT, store, scope, embedding_key: embeddingKey,
    selection: { over_tokens: overTokens, byte_cap: CHUNK_MAX_BYTES, policy_digest: policy.digest, tokenizer_sha256: policy.descriptor.tokenizer_sha256 },
    caps, discovery: { rows: found.rows, turns: found.turns.length, targets: found.targets.length, targets_by_vector: byVector,
      vectorless_within_limits: found.vectorless_within_limits },
    fingerprint: frozenTurns.fingerprint, turns: frozenTurns.turns };
  return { ...frozen, frozen_digest: digest(canonical(frozen)) };
}

const nativeEndpoint = embedding => {
  requireThat(embedding?.ollama_transport === 'native_no_truncate' && embedding.allow_remote !== true, 'repair_transport_required');
  const url = new URL(localEndpoint(embedding.url));
  requireThat(url.protocol === 'http:' && url.pathname === '/v1/embeddings', 'repair_transport_required');
  url.pathname = '/api/embed';
  return url.toString();
};

/**
 * The verified token policy and vector key a repair runs under, resolved from the current configuration. A configured cap
 * above 1,920 tokens is refused; `apply` and `inverse` require the same policy and key as the plan at the point of use.
 */
export function repairTreatment(config, verified) {
  const policy = verified ? chunkPolicy(config, verified) : chunkPolicy(config);
  requireThat(policy.descriptor.policy === TOKEN_POLICY && policy.descriptor.context !== null, 'repair_tokenizer_unverified');
  requireThat(policy.descriptor.token_cap <= DEFAULT_CHUNK_TOKEN_CAP, 'repair_treatment_mismatch');
  return { policy, key: embeddingIdentity(config.embedding), endpoint: nativeEndpoint(config.embedding) };
}

// The pieces' intervals, in order, must exactly cover the target's text: same ends and no hole. Overlap is allowed.
function coversExactly(pieces, length) {
  let reached = 0;
  for (const piece of [...pieces].sort((a, b) => a.start - b.start)) {
    if (piece.start > reached) return false;
    reached = Math.max(reached, piece.end);
  }
  return pieces.length > 0 && pieces[0].start === 0 && reached === length;
}

const frozenTargets = frozen => frozen.turns.flatMap(turn => turn.targets);

/**
 * Stages the replacements for the frozen record whose digest the owner approved. Each target's exact text is re-derived under
 * the verified token policy and must be covered exactly by its pieces. One monotonic `budget` ({max_pieces, max_seconds})
 * starts at entry: the piece count, sizes and ordinal ranges are checked before any text is sent, each call gets at most
 * the remaining time, and a plan finished after the deadline is refused. The deadline is a completion cutoff; it does not
 * preempt local work or the model server. Each piece is embedded alone through the native no-truncate transport, and the
 * served count must equal the local count, with no retry. Replacement IDs are new and collision-free, and ordinals are new
 * integers above every existing one in their turn.
 */
export async function stage({ frozen, approvedFrozen, config, verified, budget, request = localJson, clock = () => performance.now() }) {
  const started = clock();
  requireThat(frozen?.contract === REPAIR_CONTRACT, 'invalid_input');
  requireThat(Number.isSafeInteger(budget?.max_pieces) && budget.max_pieces > 0 && Number.isSafeInteger(budget.max_seconds)
    && budget.max_seconds > 0, 'invalid_input');
  const deadline = started + budget.max_seconds * 1000;
  const { frozen_digest: frozenDigest, ...body } = frozen;
  requireThat(digest(canonical(body)) === frozenDigest, 'repair_frozen_invalid');
  requireThat(approvedFrozen === frozenDigest, 'repair_frozen_not_approved');
  const { policy, key, endpoint } = repairTreatment(config, verified);
  requireThat(key === frozen.embedding_key, 'repair_key_mismatch');
  requireThat(policy.digest === frozen.selection?.policy_digest, 'repair_treatment_mismatch');
  const embedding = config.embedding;
  const derivations = [];
  for (const turn of frozen.turns) {
    for (const target of turn.targets) {
      const text = value(target.state, 'text');
      const normalized = normalizeTurn({ source: 'repair', conversation_id: 'repair', turn_id: 'repair',
        entries: [{ id: value(target.state, 'entry_id'), role: value(target.state, 'role'), text }] });
      const derived = await deriveChunks(normalized, policy);
      requireThat(derived.gaps.length === 0 && coversExactly(derived.chunks, text.length), 'repair_coverage_incomplete');
      for (const piece of derived.chunks) {
        requireThat(Buffer.byteLength(piece.text) <= CHUNK_MAX_BYTES && piece.token_count <= policy.descriptor.token_cap, 'repair_derivation_gap');
      }
      derivations.push({ turn, target, pieces: derived.chunks });
    }
  }
  const total = derivations.reduce((sum, item) => sum + item.pieces.length, 0);
  // A piece count over the cap is its own refusal: unchanged bytes derive the same count again, so it is never the time
  // budget's one permitted re-run.
  requireThat(total <= budget.max_pieces, 'repair_piece_cap_exceeded');
  const ordinals = new Map();
  for (const turn of frozen.turns) {
    const count = derivations.filter(item => item.turn === turn).reduce((sum, item) => sum + item.pieces.length, 0);
    requireThat(Number.isSafeInteger(turn.ordinal_ceiling) && Number.isSafeInteger(turn.ordinal_ceiling + count), 'repair_derivation_gap');
    ordinals.set(turn.turn_uid, turn.ordinal_ceiling);
  }
  const replacements = [];
  for (const { turn, target, pieces } of derivations) {
    const start = numeric(target.state, 'start');
    const nodes = [];
    for (const [part, piece] of pieces.entries()) {
      const remaining = Math.floor(deadline - clock());
      requireThat(remaining > 0, 'repair_budget_exceeded');
      const result = await request(endpoint, { model: embedding.model, input: piece.text, truncate: false },
        Math.min(embedding.timeout_ms ?? 30_000, remaining));
      requireThat(clock() < deadline, 'repair_budget_exceeded');
      requireThat(result?.model === embedding.model && Array.isArray(result.embeddings) && result.embeddings.length === 1, 'invalid_embedding_response');
      // The served input must be exactly what was counted locally; a different count means the contract does not hold.
      requireThat(result.prompt_eval_count === piece.token_count, 'repair_count_mismatch');
      const vector = validateVector(result.embeddings[0], embedding.dimensions);
      const uid = identity('chunk', frozen.scope, turn.turn_uid, `${REPAIR_CONTRACT}:${frozenDigest}:${target.uid}:${part}`);
      const ordinal = ordinals.get(turn.turn_uid) + 1;
      ordinals.set(turn.turn_uid, ordinal);
      const properties = { ...Object.fromEntries(Object.entries(target.state.properties)
        .filter(([name]) => ['entry_id', 'role', 'turn_uid', 'scope', 'scope_terms'].includes(name))),
      ordinal: { type: 'FLOAT', value: ordinal },
      uid: { type: 'STRING', value: uid }, start: { type: 'FLOAT', value: start + piece.start }, end: { type: 'FLOAT', value: start + piece.end },
      text: { type: 'STRING', value: piece.text }, repair_part: { type: 'FLOAT', value: part },
      repair_of: { type: 'STRING', value: target.uid }, repair_contract: { type: 'STRING', value: REPAIR_CONTRACT },
      embedding: { type: 'LIST<FLOAT>', value: vector }, embedding_key: { type: 'STRING', value: frozen.embedding_key } };
      nodes.push({ uid, state: { labels: target.state.labels, properties } });
    }
    replacements.push({ turn_uid: turn.turn_uid, old_uid: target.uid, nodes });
  }
  const created = replacements.flatMap(item => item.nodes);
  requireThat(new Set(created.map(node => node.uid)).size === created.length, 'repair_derivation_gap');
  const targets = frozenTargets(frozen);
  const fingerprint = { ...frozen.fingerprint, chunks: frozen.fingerprint.chunks - targets.length + created.length,
    chunks_without_current_vector: frozen.fingerprint.chunks_without_current_vector - targets.filter(target => target.vector !== 'current').length };
  const postimage = { store: frozen.store, fingerprint, turns: frozen.turns.map(turn => ({ turn_uid: turn.turn_uid,
    turn_digest: turn.preimage.turn_digest, siblings_digest: turn.preimage.siblings_digest,
    chunks: replacements.filter(item => item.turn_uid === turn.turn_uid).flatMap(item => item.nodes)
      .map(node => ({ uid: node.uid, links: TURN_LINK, digest: stateDigest(node.state) }))
      // Code-point order, as the store's ORDER BY returns the rows the postimage is compared with.
      .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)) })) };
  // A plan completed after the deadline is not accepted.
  requireThat(clock() < deadline, 'repair_budget_exceeded');
  const plan = { contract: REPAIR_CONTRACT, frozen_digest: frozenDigest, frozen, policy_digest: policy.digest, embedding_key: key,
    budget, replacements, postimage };
  return { ...plan, plan_digest: digest(canonical(plan)) };
}

/**
 * One explicit write transaction, never retried. `rolled_back` only when the rollback was acknowledged; a failed rollback is
 * `rollback_unconfirmed`, and a commit error is `unknown`. Session cleanup is reported separately and never replaces the
 * outcome. An unknown outcome is settled only by the owner, from `reconcile` plus independent evidence that writers ceased;
 * an observed state is not authority to retry.
 */
export async function writeOnce(driver, database, work) {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.WRITE });
  let result;
  try {
    const tx = session.beginTransaction({ timeout: WRITE_TIMEOUT_MS });
    try { await work(tx); } catch (error) {
      const code = error instanceof MemoryError ? error.code : 'repair_failed';
      try { await tx.rollback(); result = { outcome: 'rolled_back', error: code }; } catch { result = { outcome: 'rollback_unconfirmed', error: code }; }
    }
    if (!result) {
      try { await tx.commit(); result = { outcome: 'committed' }; } catch { result = { outcome: 'unknown' }; }
    }
  } catch {
    result ??= { outcome: 'unknown' };
  }
  let cleanup = 'ok';
  try { await session.close(); } catch { cleanup = 'failed'; }
  return { ...result, cleanup };
}

// Typed values back to driver parameters: integers from their decimal strings, losslessly.
const params = state => {
  const out = {};
  for (const [key, { type, value: v }] of Object.entries(state.properties)) {
    out[key] = type === 'INTEGER' ? neo4j.int(v) : type === 'LIST<INTEGER>' ? v.map(item => neo4j.int(item)) : v;
  }
  return out;
};

// Creates one node with exactly the given labels and typed properties and links it from the turn with a property-free edge.
async function createNode(tx, scope, turnUid, state) {
  const labels = state.labels.map(label => `\`${label}\``).join(':');
  const values = params(state);
  const assignments = Object.entries(state.properties).map(([key, { type }], index) =>
    `c.\`${key}\` = ${type === 'ZONED DATETIME' ? `datetime($v${index})` : `$v${index}`}`);
  const bound = Object.fromEntries(Object.keys(state.properties).map((key, index) => [`v${index}`, values[key]]));
  const result = await tx.run(`MATCH (t:SMTurn {uid:$turn, scope:$scope}) CREATE (c:${labels}) SET ${assignments.join(', ')}
    CREATE (t)-[:SM_HAS_CHUNK]->(c) RETURN count(c) AS n`, { turn: turnUid, scope, ...bound });
  requireThat(Number(result.records[0].get('n')) === 1, 'repair_target_changed');
}

// Deletes exactly the verified chunks and their one property-free turn edge; any other edge makes the delete refuse.
async function deleteVerified(tx, scope, turnUid, uids) {
  const deleted = await tx.run(`UNWIND $uids AS uid
    MATCH (t:SMTurn {uid:$turn, scope:$scope})-[r:SM_HAS_CHUNK]->(c:SMChunk {uid:uid, scope:$scope})
    WHERE size(keys(r)) = 0 AND COUNT { (c)--() } = 1
    DELETE r, c RETURN count(*) AS n`, { uids, turn: turnUid, scope });
  requireThat(Number(deleted.records[0].get('n')) === uids.length, 'repair_target_changed');
}

// Takes write locks on every target turn and the rows about to change by rewriting a property to its own value: no property
// is added or altered, so no existing state is clobbered. The locks hold to the end of the transaction.
async function lock(tx, scope, turnUids, uids) {
  const turns = await tx.run('MATCH (t:SMTurn {scope:$scope}) WHERE t.uid IN $turns SET t.scope = t.scope RETURN count(t) AS n', { turns: turnUids, scope });
  requireThat(Number(turns.records[0].get('n')) === turnUids.length, 'repair_target_changed');
  // Rows that are absent are not locked; the classification that follows decides whether the state is the expected one.
  await tx.run('MATCH (c:SMChunk {scope:$scope}) WHERE c.uid IN $uids SET c.scope = c.scope', { uids, scope });
}

// The plan may run only under the same verified token policy and vector key it was staged with.
function requireTreatment(plan, config, verified) {
  const { policy, key } = repairTreatment(config, verified);
  requireThat(policy.digest === plan.policy_digest && key === plan.embedding_key && key === plan.frozen.embedding_key, 'repair_treatment_mismatch');
}

const same = (a, b) => canonical(a) === canonical(b);

function verifyPlan(plan) {
  requireThat(plan?.contract === REPAIR_CONTRACT, 'invalid_input');
  const { plan_digest: planDigest, ...body } = plan;
  requireThat(digest(canonical(body)) === planDigest, 'repair_plan_invalid');
  const { frozen_digest: frozenDigest, ...frozen } = plan.frozen;
  requireThat(digest(canonical(frozen)) === frozenDigest && frozenDigest === plan.frozen_digest, 'repair_plan_invalid');
  return planDigest;
}

const createdOf = (plan, turnUid) => plan.postimage.turns.find(turn => turn.turn_uid === turnUid).chunks.map(chunk => chunk.uid);

/** Classifies the live state against the plan, in the caller's transaction: other_store, preimage, postimage or neither. */
export async function classify(tx, plan) {
  const { scope, embedding_key: key } = plan.frozen;
  // The store is checked first, so another store's content is never read.
  if (!same(await storeIdentity(tx), plan.frozen.store)) return 'other_store';
  let preimage = true;
  let postimage = true;
  for (const turn of plan.frozen.turns) {
    const snapshot = await readTurn(tx, scope, turn.turn_uid);
    const targetUids = turn.targets.map(target => target.uid);
    const createdUids = createdOf(plan, turn.turn_uid);
    const present = uids => snapshot.chunks.some(chunk => uids.includes(chunk.uid));
    preimage &&= same(turnBinding(snapshot, targetUids), turn.preimage) && !present(createdUids);
    const after = turnBinding(snapshot, createdUids);
    const expected = plan.postimage.turns.find(item => item.turn_uid === turn.turn_uid);
    postimage &&= same({ turn_uid: turn.turn_uid, turn_digest: after.turn_digest, siblings_digest: after.siblings_digest, chunks: after.chunks }, expected)
      && !present(targetUids);
    if (!preimage && !postimage) return 'neither';
  }
  const fingerprint = await scopeFingerprint(tx, scope, key);
  if (preimage && same(fingerprint, plan.frozen.fingerprint)) return 'preimage';
  if (postimage && same(fingerprint, plan.postimage.fingerprint)) return 'postimage';
  return 'neither';
}

async function requireState(tx, plan, expected, changed) {
  const state = await classify(tx, plan);
  requireThat(state !== 'other_store', 'repair_store_mismatch');
  requireThat(state === expected, changed);
}

const turnUids = plan => plan.frozen.turns.map(turn => turn.turn_uid);

/**
 * Swaps every target for its replacements in one transaction, if and only if the same physical store is still exactly the
 * frozen preimage. Detecting a change is not stopping writers: the owner's writer exclusion must hold throughout.
 */
export async function apply({ driver, database, plan, config, verified }) {
  const planDigest = verifyPlan(plan);
  requireTreatment(plan, config, verified);
  const { scope } = plan.frozen;
  const result = await writeOnce(driver, database, async tx => {
    await requireStore(tx, plan.frozen.store);
    await lock(tx, scope, turnUids(plan), frozenTargets(plan.frozen).map(target => target.uid));
    await requireState(tx, plan, 'preimage', 'repair_preimage_changed');
    for (const turn of plan.frozen.turns) {
      await deleteVerified(tx, scope, turn.turn_uid, turn.targets.map(target => target.uid));
      for (const item of plan.replacements.filter(entry => entry.turn_uid === turn.turn_uid)) {
        for (const node of item.nodes) await createNode(tx, scope, turn.turn_uid, node.state);
      }
    }
    await requireState(tx, plan, 'postimage', 'repair_postimage_mismatch');
  });
  return { contract: REPAIR_CONTRACT, step: 'apply', plan_digest: planDigest, ...result };
}

/** Restores the exact frozen preimage, if and only if the same physical store is still exactly the plan's postimage. */
export async function inverse({ driver, database, plan, config, verified }) {
  const planDigest = verifyPlan(plan);
  requireTreatment(plan, config, verified);
  const { scope } = plan.frozen;
  const result = await writeOnce(driver, database, async tx => {
    await requireStore(tx, plan.frozen.store);
    await lock(tx, scope, turnUids(plan), plan.postimage.turns.flatMap(turn => turn.chunks.map(chunk => chunk.uid)));
    await requireState(tx, plan, 'postimage', 'repair_postimage_changed');
    for (const turn of plan.frozen.turns) {
      await deleteVerified(tx, scope, turn.turn_uid, createdOf(plan, turn.turn_uid));
      for (const target of turn.targets) await createNode(tx, scope, turn.turn_uid, target.state);
    }
    await requireState(tx, plan, 'preimage', 'repair_preimage_mismatch');
  });
  return { contract: REPAIR_CONTRACT, step: 'inverse', plan_digest: planDigest, ...result };
}

/**
 * Read-only observation of which side of the plan the store is on, in one transaction that also names the physical store.
 * It is evidence for the owner's settlement of an unknown outcome, not authority to retry.
 */
export async function reconcile({ driver, database, plan }) {
  const planDigest = verifyPlan(plan);
  const state = await readOnly(driver, database, tx => classify(tx, plan), WRITE_TIMEOUT_MS);
  return { contract: REPAIR_CONTRACT, step: 'reconcile', plan_digest: planDigest, state };
}
