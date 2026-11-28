import { performance } from 'node:perf_hooks';
import neo4j from 'neo4j-driver';
import { canonical, CHUNK_MAX_BYTES, digest, identity, MemoryError, normalizeTurn, requireThat, validateVector } from './core.mjs';
import { chunkPolicy, DEFAULT_CHUNK_TOKEN_CAP, deriveChunks, TOKEN_POLICY } from './chunk-policy.mjs';
import { embeddingIdentity, localEndpoint, localJson } from './models.mjs';

// Names this repair's file and receipt formats. One owner-run repair of the byte-oversized, vectorless derived chunks of one
// retained turn that predates first-retain manifests: freeze the exact preimage, stage token-capped replacements with
// full-input vectors, swap them in one guarded transaction, and keep the exact inverse. The turn, its entries, spans, records
// and relations are not touched.
export const REPAIR_CONTRACT = 'source-memory.one-turn-repair/1';
// The approved cohort: exactly three rows of one turn.
export const REPAIR_TARGETS = 3;
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

/**
 * Everything the repair binds, read in one transaction: the physical store, the turn, every derived chunk linked to it with
 * its exact state and every relationship it has (type, direction, other end, property count), and a scope count fingerprint.
 * The fingerprint detects count-changing writes in the scope; it does not detect a same-count update of another row, so
 * writer quiescence remains a hard external requirement of the owner, not something this check provides.
 */
/**
 * The one turn the repair may touch, selected by the census predicate rather than named by a person: the parent turn of every
 * chunk in the scope without a current-key vector. There must be exactly `expectedTargets` such chunks, all naming one turn,
 * before any content is read; the freeze then checks them again in full. Only turn ids are read here, and at most one row
 * past the cohort.
 */
async function selectTurn(tx, scope, embeddingKey, expectedTargets) {
  const result = await tx.run(`MATCH (c:SMChunk {scope:$scope})
    WHERE c.embedding IS NULL OR c.embedding_key IS NULL OR c.embedding_key <> $key
    WITH c LIMIT $lookahead
    RETURN collect(DISTINCT c.turn_uid) AS turns, count(c) AS chunks, count(c.turn_uid) AS bound`,
  { scope, key: embeddingKey, lookahead: neo4j.int(expectedTargets + 1) });
  const [row] = result.records;
  const turns = row.get('turns');
  requireThat(Number(row.get('chunks')) === expectedTargets && Number(row.get('bound')) === expectedTargets
    && turns.length === 1 && typeof turns[0] === 'string', 'repair_target_changed');
  return turns[0];
}

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

export async function readSnapshot(tx, scope, turnUid, embeddingKey) {
  const store = await storeIdentity(tx);
  const turns = await tx.run(`MATCH (t:SMTurn {uid:$turn, scope:$scope}) RETURN labels(t) AS labels, ${TYPED('t')} AS typed`, { scope, turn: turnUid });
  requireThat(turns.records.length === 1, 'repair_target_changed');
  const turn = nodeState(turns.records[0].get('labels'), turns.records[0].get('typed'));
  // A chunk linked from the turn but bound to another scope or turn is refused before any of its content is read.
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
  // Each count is its own ungrouped aggregate, so a zero is a row and every key is always present.
  const missing = 'n.embedding IS NULL OR n.embedding_key IS NULL OR n.embedding_key <> $key';
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
  return { store, turn, chunks, fingerprint };
}

// The only link a repaired chunk may have: the turn's property-free SM_HAS_CHUNK edge into it.
const TURN_LINK = [{ type: 'SM_HAS_CHUNK', incoming: true, from_turn: true, properties: 0 }];
const onlyTurnLink = chunk => canonical(chunk.links) === canonical(TURN_LINK);

const isCurrent = (state, key) => value(state, 'embedding_key') === key && Array.isArray(value(state, 'embedding'));

function bindings(snapshot, targetUids) {
  const targets = snapshot.chunks.filter(chunk => targetUids.includes(chunk.uid));
  const siblings = snapshot.chunks.filter(chunk => !targetUids.includes(chunk.uid));
  return {
    store: snapshot.store,
    turn_digest: stateDigest(snapshot.turn),
    targets: targets.map(chunk => ({ uid: chunk.uid, links: chunk.links, digest: stateDigest(chunk.state) })),
    siblings_digest: digest(canonical(siblings.map(chunk => [chunk.uid, chunk.links, stateDigest(chunk.state)]))),
    fingerprint: snapshot.fingerprint,
  };
}

async function readOnly(driver, database, work) {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const tx = session.beginTransaction({ timeout: 60_000 });
    try { return await work(tx); } finally { if (tx.isOpen()) await tx.rollback().catch(() => {}); }
  } finally { await session.close(); }
}

/**
 * Freezes the exact preimage of one turn's repair, in one read transaction that also names the physical store. The turn must
 * predate first-retain manifests. Every chunk linked to it must carry this scope and turn. The target is every such chunk
 * without a current-key vector: exactly `expectedTargets`, each over CHUNK_MAX_BYTES, with only the turn's property-free
 * link, equal to its source span, and together every chunk in the scope without a current-key vector.
 */
export async function freeze({ driver, database, expectedStore, scope, embeddingKey, expectedTargets = REPAIR_TARGETS }) {
  requireThat(expectedTargets === REPAIR_TARGETS, 'repair_target_changed');
  requireThat(typeof expectedStore?.database_id === 'string' && typeof expectedStore.database === 'string', 'invalid_input');
  return readOnly(driver, database, async tx => {
    // The owner names the intended store; another one is refused before any target is read.
    await requireStore(tx, { system: 'neo4j', database_id: expectedStore.database_id, database: expectedStore.database });
    const turnUid = await selectTurn(tx, scope, embeddingKey, expectedTargets);
    const snapshot = await readSnapshot(tx, scope, turnUid, embeddingKey);
    requireThat(MANIFEST_PROPERTIES.every(key => !(key in snapshot.turn.properties)), 'repair_turn_has_manifest');
    requireThat(snapshot.fingerprint.records_without_current_vector === 0, 'repair_target_changed');
    const body = JSON.parse(value(snapshot.turn, 'body'));
    const entries = new Map(body.entries.map(entry => [entry.id, entry]));
    const targets = snapshot.chunks.filter(chunk => !isCurrent(chunk.state, embeddingKey));
    requireThat(targets.length === expectedTargets, 'repair_target_changed');
    requireThat(snapshot.fingerprint.chunks_without_current_vector === expectedTargets, 'repair_target_changed');
    for (const chunk of targets) {
      const text = value(chunk.state, 'text');
      const entry = entries.get(value(chunk.state, 'entry_id'));
      requireThat(onlyTurnLink(chunk), 'repair_unsupported_link');
      requireThat(value(chunk.state, 'embedding') === undefined, 'repair_target_changed');
      requireThat(typeof text === 'string' && Buffer.byteLength(text) > CHUNK_MAX_BYTES, 'repair_target_changed');
      requireThat(entry && entry.role === value(chunk.state, 'role'), 'repair_target_changed');
      // The stated interval itself must be valid: in bounds, the exact text length, on code-point boundaries. A slice would
      // clamp an out-of-range end instead.
      const start = numeric(chunk.state, 'start');
      const end = numeric(chunk.state, 'end');
      requireThat(start < end && end <= entry.text.length && end - start === text.length
        && boundary(entry.text, start) && boundary(entry.text, end) && entry.text.slice(start, end) === text, 'repair_target_changed');
    }
    requireThat(new Set(targets.map(chunk => chunk.uid)).size === targets.length, 'repair_target_changed');
    // Replacements take new ordinals above every existing one: unique integers, so no sibling is renumbered and the
    // evidence-span reader, which requires a unique integer ordinal per entry, stays valid.
    const ordinalCeiling = Math.max(...snapshot.chunks.map(chunk => numeric(chunk.state, 'ordinal')));
    const frozen = { contract: REPAIR_CONTRACT, store: snapshot.store, scope, turn_uid: turnUid, embedding_key: embeddingKey,
      ordinal_ceiling: ordinalCeiling, preimage: bindings(snapshot, targets.map(chunk => chunk.uid)),
      targets: targets.map(chunk => ({ uid: chunk.uid, state: chunk.state })) };
    return { ...frozen, frozen_digest: digest(canonical(frozen)) };
  });
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

/**
 * Stages the replacements for the frozen record whose digest the owner approved. Each target's exact text is re-derived under
 * the verified token policy and must be covered exactly by its pieces. One monotonic `budget` ({max_pieces, max_seconds})
 * starts at entry: the piece count, sizes and ordinal range are checked before any text is sent, each call gets at most
 * the remaining time, and a plan finished after the deadline is refused. The deadline is a completion cutoff; it does not
 * preempt local work or the model server. Each piece is embedded alone through the native no-truncate transport, and the
 * served count must equal the local count, with no retry. Replacement IDs are new and collision-free, and ordinals are new
 * integers above every existing one.
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
  const embedding = config.embedding;
  const derivations = [];
  for (const target of frozen.targets) {
    const text = value(target.state, 'text');
    const turn = normalizeTurn({ source: 'repair', conversation_id: 'repair', turn_id: 'repair',
      entries: [{ id: value(target.state, 'entry_id'), role: value(target.state, 'role'), text }] });
    const derived = await deriveChunks(turn, policy);
    requireThat(derived.gaps.length === 0 && coversExactly(derived.chunks, text.length), 'repair_coverage_incomplete');
    for (const piece of derived.chunks) {
      requireThat(Buffer.byteLength(piece.text) <= CHUNK_MAX_BYTES && piece.token_count <= policy.descriptor.token_cap, 'repair_derivation_gap');
    }
    derivations.push({ target, pieces: derived.chunks });
  }
  const total = derivations.reduce((sum, item) => sum + item.pieces.length, 0);
  requireThat(total <= budget.max_pieces, 'repair_budget_exceeded');
  requireThat(Number.isSafeInteger(frozen.ordinal_ceiling) && Number.isSafeInteger(frozen.ordinal_ceiling + total), 'repair_derivation_gap');
  let ordinal = frozen.ordinal_ceiling;
  const replacements = [];
  for (const { target, pieces } of derivations) {
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
      const uid = identity('chunk', frozen.scope, frozen.turn_uid, `${REPAIR_CONTRACT}:${frozenDigest}:${target.uid}:${part}`);
      ordinal += 1;
      const properties = { ...Object.fromEntries(Object.entries(target.state.properties)
        .filter(([name]) => ['entry_id', 'role', 'turn_uid', 'scope', 'scope_terms'].includes(name))),
      ordinal: { type: 'FLOAT', value: ordinal },
      uid: { type: 'STRING', value: uid }, start: { type: 'FLOAT', value: start + piece.start }, end: { type: 'FLOAT', value: start + piece.end },
      text: { type: 'STRING', value: piece.text }, repair_part: { type: 'FLOAT', value: part },
      repair_of: { type: 'STRING', value: target.uid }, repair_contract: { type: 'STRING', value: REPAIR_CONTRACT },
      embedding: { type: 'LIST<FLOAT>', value: vector }, embedding_key: { type: 'STRING', value: frozen.embedding_key } };
      nodes.push({ uid, state: { labels: target.state.labels, properties } });
    }
    replacements.push({ old_uid: target.uid, nodes });
  }
  const created = replacements.flatMap(item => item.nodes);
  const fingerprint = { ...frozen.preimage.fingerprint, chunks: frozen.preimage.fingerprint.chunks - frozen.targets.length + created.length,
    chunks_without_current_vector: frozen.preimage.fingerprint.chunks_without_current_vector - frozen.targets.length };
  const postimage = { store: frozen.store, turn_digest: frozen.preimage.turn_digest, siblings_digest: frozen.preimage.siblings_digest, fingerprint,
    created: created.map(node => ({ uid: node.uid, links: TURN_LINK, digest: stateDigest(node.state) })).sort((a, b) => a.uid.localeCompare(b.uid)) };
  requireThat(new Set(created.map(node => node.uid)).size === created.length, 'repair_derivation_gap');
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
    const tx = session.beginTransaction({ timeout: 60_000 });
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

// Takes write locks on the turn and the rows about to change by rewriting a property to its own value: no property is
// added or altered, so no existing state is clobbered. The locks hold to the end of the transaction.
async function lock(tx, scope, turnUid, uids) {
  const turn = await tx.run('MATCH (t:SMTurn {uid:$turn, scope:$scope}) SET t.scope = t.scope RETURN count(t) AS n', { turn: turnUid, scope });
  requireThat(Number(turn.records[0].get('n')) === 1, 'repair_target_changed');
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

/** Classifies the live state against the plan, in the caller's transaction: other_store, preimage, postimage or neither. */
export async function classify(tx, plan) {
  const { scope, turn_uid: turnUid, embedding_key: key, preimage } = plan.frozen;
  // The store is checked first, so another store's content is never read.
  if (!same(await storeIdentity(tx), plan.frozen.store)) return 'other_store';
  const snapshot = await readSnapshot(tx, scope, turnUid, key);
  const targetUids = plan.frozen.targets.map(target => target.uid);
  const createdUids = plan.postimage.created.map(node => node.uid);
  const before = bindings(snapshot, targetUids);
  if (same(before, preimage) && snapshot.chunks.every(chunk => !createdUids.includes(chunk.uid))) return 'preimage';
  const after = bindings(snapshot, createdUids);
  const postimage = { store: after.store, turn_digest: after.turn_digest, siblings_digest: after.siblings_digest,
    fingerprint: after.fingerprint, created: after.targets };
  if (same(postimage, plan.postimage) && snapshot.chunks.every(chunk => !targetUids.includes(chunk.uid))) return 'postimage';
  return 'neither';
}

async function requireState(tx, plan, expected, changed) {
  const state = await classify(tx, plan);
  requireThat(state !== 'other_store', 'repair_store_mismatch');
  requireThat(state === expected, changed);
}

/**
 * Swaps the targets for their replacements in one transaction, if and only if the same physical store is still exactly the
 * frozen preimage. Detecting a change is not stopping writers: the owner's writer quiescence must hold throughout.
 */
export async function apply({ driver, database, plan, config, verified }) {
  const planDigest = verifyPlan(plan);
  requireTreatment(plan, config, verified);
  const { scope, turn_uid: turnUid } = plan.frozen;
  const result = await writeOnce(driver, database, async tx => {
    await requireStore(tx, plan.frozen.store);
    await lock(tx, scope, turnUid, plan.frozen.targets.map(target => target.uid));
    await requireState(tx, plan, 'preimage', 'repair_preimage_changed');
    await deleteVerified(tx, scope, turnUid, plan.frozen.targets.map(target => target.uid));
    for (const node of plan.replacements.flatMap(item => item.nodes)) await createNode(tx, scope, turnUid, node.state);
    await requireState(tx, plan, 'postimage', 'repair_postimage_mismatch');
  });
  return { contract: REPAIR_CONTRACT, step: 'apply', plan_digest: planDigest, ...result };
}

/** Restores the exact frozen preimage, if and only if the same physical store is still exactly the plan's postimage. */
export async function inverse({ driver, database, plan, config, verified }) {
  const planDigest = verifyPlan(plan);
  requireTreatment(plan, config, verified);
  const { scope, turn_uid: turnUid } = plan.frozen;
  const result = await writeOnce(driver, database, async tx => {
    await requireStore(tx, plan.frozen.store);
    await lock(tx, scope, turnUid, plan.postimage.created.map(node => node.uid));
    await requireState(tx, plan, 'postimage', 'repair_postimage_changed');
    await deleteVerified(tx, scope, turnUid, plan.postimage.created.map(node => node.uid));
    for (const target of plan.frozen.targets) await createNode(tx, scope, turnUid, target.state);
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
  const state = await readOnly(driver, database, tx => classify(tx, plan));
  return { contract: REPAIR_CONTRACT, step: 'reconcile', plan_digest: planDigest, state };
}
