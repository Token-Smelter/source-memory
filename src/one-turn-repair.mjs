import neo4j from 'neo4j-driver';
import { canonical, CHUNK_MAX_BYTES, digest, identity, MemoryError, normalizeTurn, requireThat, validateVector } from './core.mjs';
import { chunkPolicy, deriveChunks, TOKEN_POLICY } from './chunk-policy.mjs';
import { embeddingIdentity, localEndpoint, localJson } from './models.mjs';

// Names this repair's file and receipt formats. One owner-run repair of the byte-oversized, vectorless derived chunks of one
// retained turn: freeze the exact preimage, stage token-capped replacements with full-input vectors, swap them in one
// guarded transaction, and keep the exact inverse. The turn, its entries, spans, records and relations are not touched.
export const REPAIR_CONTRACT = 'source-memory.one-turn-repair/1';
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROPERTY_TYPES = ['STRING', 'BOOLEAN', 'INTEGER', 'FLOAT', 'ZONED DATETIME', 'LIST<FLOAT>', 'LIST<INTEGER>', 'LIST<STRING>'];

// The property's type with nullability annotations removed, e.g. `LIST<FLOAT NOT NULL> NOT NULL` -> `LIST<FLOAT>`.
const baseType = type => String(type).replaceAll(' NOT NULL', '');

/** One node's exact stored state: labels and typed properties, in a canonical, digestible form. */
function nodeState(labels, typed) {
  const properties = {};
  for (const { k, t, v } of typed) {
    const type = baseType(t);
    requireThat(SAFE_NAME.test(k) && PROPERTY_TYPES.includes(type), 'repair_unsupported_property');
    properties[k] = { type, value: v };
  }
  requireThat(labels.every(label => SAFE_NAME.test(label)), 'repair_unsupported_label');
  return { labels: [...labels].sort(), properties };
}
const stateDigest = state => digest(canonical(state));
const value = (state, key) => state.properties[key]?.value;

const TYPED = node => `[k IN keys(${node}) | {k: k, t: valueType(${node}[k]),
  v: CASE WHEN valueType(${node}[k]) STARTS WITH 'ZONED DATETIME' THEN toString(${node}[k]) ELSE ${node}[k] END}]`;

/**
 * Everything the repair binds, read in one transaction: the turn, every derived chunk linked to it with its exact state and
 * relationship count, and a scope fingerprint that changes with any retain, enrichment or vector write in the scope.
 */
export async function readSnapshot(tx, scope, turnUid, embeddingKey) {
  const turns = await tx.run(`MATCH (t:SMTurn {uid:$turn, scope:$scope}) RETURN labels(t) AS labels, ${TYPED('t')} AS typed`, { scope, turn: turnUid });
  requireThat(turns.records.length === 1, 'repair_target_changed');
  const turn = nodeState(turns.records[0].get('labels'), turns.records[0].get('typed'));
  const rows = await tx.run(`MATCH (t:SMTurn {uid:$turn, scope:$scope})-[:SM_HAS_CHUNK]->(c:SMChunk)
    RETURN c.uid AS uid, labels(c) AS labels, ${TYPED('c')} AS typed, COUNT { (c)--() } AS links ORDER BY c.uid`, { scope, turn: turnUid });
  const chunks = rows.records.map(record => ({ uid: record.get('uid'), links: Number(record.get('links')),
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
  return { turn, chunks, fingerprint };
}

const isCurrent = (state, key) => value(state, 'embedding_key') === key && Array.isArray(value(state, 'embedding'));

function bindings(snapshot, targetUids) {
  const targets = snapshot.chunks.filter(chunk => targetUids.includes(chunk.uid));
  const siblings = snapshot.chunks.filter(chunk => !targetUids.includes(chunk.uid));
  return {
    turn_digest: stateDigest(snapshot.turn),
    targets: targets.map(chunk => ({ uid: chunk.uid, links: chunk.links, digest: stateDigest(chunk.state) })),
    siblings_digest: digest(canonical(siblings.map(chunk => [chunk.uid, chunk.links, stateDigest(chunk.state)]))),
    fingerprint: snapshot.fingerprint,
  };
}

/**
 * Freezes the exact preimage of one turn's repair. The target is every derived chunk of the turn without a current-key
 * vector; there must be exactly `expectedTargets`, each over CHUNK_MAX_BYTES, linked only to the turn, and equal to its source
 * span. They must also be every chunk of the scope without a current-key vector. Returns the private frozen record.
 */
export async function freeze({ driver, database, store, scope, turnUid, embeddingKey, expectedTargets }) {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const tx = session.beginTransaction({ timeout: 60_000 });
    try {
      const snapshot = await readSnapshot(tx, scope, turnUid, embeddingKey);
      const body = JSON.parse(value(snapshot.turn, 'body'));
      const entries = new Map(body.entries.map(entry => [entry.id, entry]));
      const targets = snapshot.chunks.filter(chunk => !isCurrent(chunk.state, embeddingKey));
      requireThat(targets.length === expectedTargets, 'repair_target_changed');
      requireThat(snapshot.fingerprint.chunks_without_current_vector === expectedTargets, 'repair_target_changed');
      for (const chunk of targets) {
        const text = value(chunk.state, 'text');
        const entry = entries.get(value(chunk.state, 'entry_id'));
        requireThat(chunk.links === 1 && value(chunk.state, 'embedding') === undefined, 'repair_target_changed');
        requireThat(typeof text === 'string' && Buffer.byteLength(text) > CHUNK_MAX_BYTES, 'repair_target_changed');
        requireThat(entry && entry.role === value(chunk.state, 'role')
          && entry.text.slice(value(chunk.state, 'start'), value(chunk.state, 'end')) === text, 'repair_target_changed');
      }
      const frozen = { contract: REPAIR_CONTRACT, store: await store.identity(), scope, turn_uid: turnUid, embedding_key: embeddingKey,
        preimage: bindings(snapshot, targets.map(chunk => chunk.uid)), targets: targets.map(chunk => ({ uid: chunk.uid, state: chunk.state })) };
      return { ...frozen, frozen_digest: digest(canonical(frozen)) };
    } finally {
      if (tx.isOpen()) await tx.rollback().catch(() => {});
    }
  } finally { await session.close(); }
}

const nativeEndpoint = embedding => {
  requireThat(embedding?.ollama_transport === 'native_no_truncate' && embedding.allow_remote !== true, 'repair_transport_required');
  const url = new URL(localEndpoint(embedding.url));
  requireThat(url.protocol === 'http:' && url.pathname === '/v1/embeddings', 'repair_transport_required');
  url.pathname = '/api/embed';
  return url.toString();
};

/**
 * Stages the replacements: each target's exact text is re-derived under the verified token policy, and each piece is embedded
 * alone through the native no-truncate transport. The served count must equal the local count, with no retry. Replacement
 * IDs are new and collision-free; the old ordinal is kept with a `repair_part` index so no sibling is renumbered.
 */
export async function stage({ frozen, config, verified, request = localJson }) {
  requireThat(frozen?.contract === REPAIR_CONTRACT, 'invalid_input');
  const { frozen_digest: frozenDigest, ...body } = frozen;
  requireThat(digest(canonical(body)) === frozenDigest, 'repair_frozen_invalid');
  const embedding = config.embedding;
  requireThat(embeddingIdentity(embedding) === frozen.embedding_key, 'repair_key_mismatch');
  const policy = verified ? chunkPolicy(config, verified) : chunkPolicy(config);
  requireThat(policy.descriptor.policy === TOKEN_POLICY && policy.descriptor.context !== null, 'repair_tokenizer_unverified');
  const endpoint = nativeEndpoint(embedding);
  const replacements = [];
  for (const target of frozen.targets) {
    const text = value(target.state, 'text');
    const start = value(target.state, 'start');
    const turn = normalizeTurn({ source: 'repair', conversation_id: 'repair', turn_id: 'repair',
      entries: [{ id: value(target.state, 'entry_id'), role: value(target.state, 'role'), text }] });
    const derived = await deriveChunks(turn, policy);
    requireThat(derived.gaps.length === 0 && derived.chunks.length > 0, 'repair_derivation_gap');
    const nodes = [];
    for (const [part, piece] of derived.chunks.entries()) {
      requireThat(Buffer.byteLength(piece.text) <= CHUNK_MAX_BYTES && piece.token_count <= policy.descriptor.token_cap, 'repair_derivation_gap');
      const result = await request(endpoint, { model: embedding.model, input: piece.text, truncate: false }, embedding.timeout_ms ?? 30_000);
      requireThat(result?.model === embedding.model && Array.isArray(result.embeddings) && result.embeddings.length === 1, 'invalid_embedding_response');
      // The served input must be exactly what was counted locally; a different count means the contract does not hold.
      requireThat(result.prompt_eval_count === piece.token_count, 'repair_count_mismatch');
      const vector = validateVector(result.embeddings[0], embedding.dimensions);
      const uid = identity('chunk', frozen.scope, frozen.turn_uid, `${REPAIR_CONTRACT}:${frozenDigest}:${target.uid}:${part}`);
      const properties = { ...Object.fromEntries(Object.entries(target.state.properties)
        .filter(([key]) => ['entry_id', 'role', 'turn_uid', 'scope', 'scope_terms', 'ordinal'].includes(key))),
      uid: { type: 'STRING', value: uid }, start: { type: 'FLOAT', value: start + piece.start }, end: { type: 'FLOAT', value: start + piece.end },
      text: { type: 'STRING', value: piece.text }, repair_part: { type: 'FLOAT', value: part },
      repair_of: { type: 'STRING', value: target.uid }, repair_contract: { type: 'STRING', value: REPAIR_CONTRACT },
      embedding: { type: 'LIST<FLOAT>', value: vector }, embedding_key: { type: 'STRING', value: frozen.embedding_key } };
      nodes.push({ uid, state: { labels: target.state.labels, properties } });
    }
    // The pieces cover the target's text exactly as derived; nothing outside its span changes.
    requireThat(nodes[0].state.properties.start.value >= start && nodes.at(-1).state.properties.end.value <= value(target.state, 'end'), 'repair_derivation_gap');
    replacements.push({ old_uid: target.uid, nodes });
  }
  const created = replacements.flatMap(item => item.nodes);
  const fingerprint = { ...frozen.preimage.fingerprint, chunks: frozen.preimage.fingerprint.chunks - frozen.targets.length + created.length,
    chunks_without_current_vector: frozen.preimage.fingerprint.chunks_without_current_vector - frozen.targets.length };
  const postimage = { turn_digest: frozen.preimage.turn_digest, siblings_digest: frozen.preimage.siblings_digest, fingerprint,
    created: created.map(node => ({ uid: node.uid, links: 1, digest: stateDigest(node.state) })).sort((a, b) => a.uid.localeCompare(b.uid)) };
  const plan = { contract: REPAIR_CONTRACT, frozen_digest: frozenDigest, frozen, policy_digest: policy.digest, replacements, postimage };
  return { ...plan, plan_digest: digest(canonical(plan)) };
}

// One explicit write transaction, never retried. A refusal before commit rolled back; a commit error leaves the outcome
// unknown, which only `reconcile` can settle.
async function writeOnce(driver, database, work) {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.WRITE });
  const tx = session.beginTransaction({ timeout: 60_000 });
  try {
    try { await work(tx); } catch (error) {
      await tx.rollback().catch(() => {});
      return { outcome: 'rolled_back', error: error instanceof MemoryError ? error.code : 'repair_failed' };
    }
    try { await tx.commit(); } catch { return { outcome: 'unknown' }; }
    return { outcome: 'committed' };
  } finally { await session.close(); }
}

const params = state => {
  const out = {};
  for (const [key, { type, value: v }] of Object.entries(state.properties)) {
    out[key] = type === 'INTEGER' ? neo4j.int(v) : type === 'LIST<INTEGER>' ? v.map(item => neo4j.int(item)) : v;
  }
  return out;
};

// Creates one node with exactly the given labels and typed properties and links it from the turn.
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

async function lockTurn(tx, scope, turnUid) {
  const locked = await tx.run('MATCH (t:SMTurn {uid:$turn, scope:$scope}) SET t.repair_lock = true REMOVE t.repair_lock RETURN count(t) AS n',
    { turn: turnUid, scope });
  requireThat(Number(locked.records[0].get('n')) === 1, 'repair_target_changed');
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

/** Classifies the live state against the plan: exactly the preimage, exactly the postimage, or neither. */
export async function classify(tx, plan) {
  const { scope, turn_uid: turnUid, embedding_key: key, preimage } = plan.frozen;
  const snapshot = await readSnapshot(tx, scope, turnUid, key);
  const targetUids = plan.frozen.targets.map(target => target.uid);
  const createdUids = plan.postimage.created.map(node => node.uid);
  const before = bindings(snapshot, targetUids);
  if (same(before, preimage) && snapshot.chunks.every(chunk => !createdUids.includes(chunk.uid))) return 'preimage';
  const after = bindings(snapshot, createdUids);
  const postimage = { turn_digest: after.turn_digest, siblings_digest: after.siblings_digest, fingerprint: after.fingerprint, created: after.targets };
  if (same(postimage, plan.postimage) && snapshot.chunks.every(chunk => !targetUids.includes(chunk.uid))) return 'postimage';
  return 'neither';
}

/**
 * Swaps the targets for their replacements in one transaction, if and only if the store is still exactly the frozen
 * preimage, including the scope fingerprint that a concurrent retain, enrichment or vector write would change. The check
 * detects writes that the owner's quiescence should have excluded; it does not itself stop writers.
 */
export async function apply({ driver, database, store, plan }) {
  const planDigest = verifyPlan(plan);
  requireThat(same(await store.identity(), plan.frozen.store), 'repair_store_mismatch');
  const { scope, turn_uid: turnUid } = plan.frozen;
  const result = await writeOnce(driver, database, async tx => {
    await lockTurn(tx, scope, turnUid);
    requireThat(await classify(tx, plan) === 'preimage', 'repair_preimage_changed');
    const deleted = await tx.run('UNWIND $uids AS uid MATCH (c:SMChunk {uid:uid, scope:$scope}) DETACH DELETE c RETURN count(*) AS n',
      { uids: plan.frozen.targets.map(target => target.uid), scope });
    requireThat(Number(deleted.records[0].get('n')) === plan.frozen.targets.length, 'repair_preimage_changed');
    for (const node of plan.replacements.flatMap(item => item.nodes)) await createNode(tx, scope, turnUid, node.state);
    requireThat(await classify(tx, plan) === 'postimage', 'repair_postimage_mismatch');
  });
  return { contract: REPAIR_CONTRACT, step: 'apply', plan_digest: planDigest, ...result };
}

/** Restores the exact frozen preimage, if and only if the store is still exactly the plan's postimage. */
export async function inverse({ driver, database, store, plan }) {
  const planDigest = verifyPlan(plan);
  requireThat(same(await store.identity(), plan.frozen.store), 'repair_store_mismatch');
  const { scope, turn_uid: turnUid } = plan.frozen;
  const result = await writeOnce(driver, database, async tx => {
    await lockTurn(tx, scope, turnUid);
    requireThat(await classify(tx, plan) === 'postimage', 'repair_postimage_changed');
    const deleted = await tx.run('UNWIND $uids AS uid MATCH (c:SMChunk {uid:uid, scope:$scope}) DETACH DELETE c RETURN count(*) AS n',
      { uids: plan.postimage.created.map(node => node.uid), scope });
    requireThat(Number(deleted.records[0].get('n')) === plan.postimage.created.length, 'repair_postimage_changed');
    for (const target of plan.frozen.targets) await createNode(tx, scope, turnUid, target.state);
    requireThat(await classify(tx, plan) === 'preimage', 'repair_preimage_mismatch');
  });
  return { contract: REPAIR_CONTRACT, step: 'inverse', plan_digest: planDigest, ...result };
}

/** Read-only settlement of an unknown outcome: which side of the plan the store is on. */
export async function reconcile({ driver, database, plan }) {
  const planDigest = verifyPlan(plan);
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const tx = session.beginTransaction({ timeout: 60_000 });
    try { return { contract: REPAIR_CONTRACT, step: 'reconcile', plan_digest: planDigest, state: await classify(tx, plan) }; }
    finally { if (tx.isOpen()) await tx.rollback().catch(() => {}); }
  } finally { await session.close(); }
}
