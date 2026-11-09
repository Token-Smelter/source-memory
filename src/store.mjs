import neo4j from 'neo4j-driver';
import { passthrough } from './phase-diagnostic.mjs';
import {
  digest, identity, indexNames, integer, isNested, markStage, MemoryError, namespace, OUTCOME_REFERENT_KINDS, requireThat, scopePath, scopeTerm,
  scopeTerms, sourceExcerpt, lexicalQuery, treeLayout,
} from './core.mjs';

const unwrap = node => node?.properties ?? null;
const decodeTurn = props => props ? { id: props.uid, scope: props.scope, ...JSON.parse(props.body) } : null;
const decodeRecord = props => props ? { uid: props.uid, scope: props.scope, ...JSON.parse(props.body) } : null;
const decodeRelation = props => props ? { uid: props.uid, ...JSON.parse(props.body) } : null;

/**
 * Cypher predicate over `$exclude` ([{source, conversation_id}]): false for a turn of an excluded conversation, a chunk of
 * such a turn, and a record whose every evidence turn is in one. A record with any other evidence stays, so a mixed bundle
 * still reaches the caller. Turns stored before lineage properties existed carry no conversation and are never excluded.
 */
// A turn missing these properties compares as null; coalesce makes it explicitly not excluded rather than silently dropped.
const excludedTurn = turn => `coalesce(any(x IN $exclude WHERE x.source = ${turn}.source AND x.conversation_id = ${turn}.conversation_id), false)`;
const eligible = n => `(size($exclude) = 0
  OR (${n}:SMTurn AND NOT ${excludedTurn(n)})
  OR (${n}:SMChunk AND EXISTS { MATCH (t:SMTurn)-[:SM_HAS_CHUNK]->(${n}) WHERE NOT ${excludedTurn('t')} })
  OR (${n}:SMRecord AND (NOT EXISTS { MATCH (${n})-[:SM_EVIDENCE]->(:SMTurn) }
    OR EXISTS { MATCH (${n})-[:SM_EVIDENCE]->(t:SMTurn) WHERE NOT ${excludedTurn('t')} })))`;

// Above this many eligible tree vectors a read uses the shared ANN index; at or below it, an exact cosine scan.
export const TREE_SCAN_LIMIT = 4096;
const TREE_BACKFILL = { batch: 1000, batches: 50 };
// `list` orders a node written without `created_at` (by a writer other than this store) as this instant.
export const LIST_EPOCH = '0001-01-01T00:00:00Z';

/**
 * Where a read looks. A flat scope (depth 1 or a non-path name) keeps its own labels and indexes and the exact `scope`
 * predicate, so its queries see the same documents as before nested scopes existed. A nested scope or a subtree reads its
 * root's tree indexes, filtered by its scope term inside Lucene and by `where` everywhere else. Subtree membership is one
 * rule: a path equal to the root or starting with `root/`, so a non-path name such as `S/a b` is never a member.
 */
export function selection(target) {
  const subtree = typeof target === 'object' && target !== null && target.subtree === true;
  const scope = subtree ? target.scope : target;
  if (!subtree && !isNested(scope)) {
    const ns = namespace(scope);
    return { scope, subtree: false, tree: false, names: indexNames(scope), labels: { turn: `${ns}Turn`, chunk: `${ns}Chunk`, record: `${ns}Record` },
      params: { scope }, where: n => `${n}.scope=$scope`, owns: value => value === scope, lucene: query => query };
  }
  requireThat(scopePath(scope) !== null, 'scope_denied');
  const term = scopeTerm(scope, !subtree);
  const path = scopePath(scope);
  const depth = path.length;
  const layout = treeLayout(path[0]);
  return { scope, subtree, tree: true, names: layout.indexes, labels: layout.labels,
    members: { turn: `SMTurn:${layout.labels.turn}`, chunk: `SMChunk:${layout.labels.chunk}`, record: `SMRecord:${layout.labels.record}` },
    params: subtree ? { scope, scopePrefix: `${scope}/`, scopeRegex: depth < 8 ? `${scope}(/[A-Za-z0-9_-]{1,64}){1,${8 - depth}}` : '(?!)' } : { scope },
    where: subtree ? n => `(${n}.scope=$scope OR (${n}.scope STARTS WITH $scopePrefix AND size(${n}.scope) <= 256 AND ${n}.scope =~ $scopeRegex))`
      : n => `${n}.scope=$scope`,
    owns: subtree ? value => value === scope || (typeof value === 'string' && value.startsWith(`${scope}/`) && scopePath(value) !== null)
      : value => value === scope,
    lucene: query => `text:(${query}) AND scope_terms:${term}^0` };
}

/**
 * Labels and filter terms a write sets. A non-path name keeps its own label only, a nested scope gets its root's tree label
 * only, and a depth-1 root keeps its own label and joins its tree only once `init 'root/**'` has written the opt-in marker,
 * so a flat scope's stored nodes stay as they were until an operator opts it in. Read inside the write transaction.
 */
async function writeLabels(tx, scope, kinds) {
  const path = scopePath(scope);
  const own = kind => `${namespace(scope)}${kind}`;
  const flat = Object.fromEntries(kinds.map(kind => [kind, { labels: own(kind), terms: null }]));
  if (path === null) return flat;
  if (path.length === 1) {
    const marker = await tx.run('MATCH (m:SMScopeTree {root:$root}) RETURN count(m) AS count', { root: scope });
    if (marker.records[0].get('count') === 0) return flat;
  }
  const tree = treeLayout(path[0]).labels;
  const terms = scopeTerms(scope);
  return Object.fromEntries(kinds.map(kind => [kind, { labels: path.length === 1 ? `${own(kind)}:${tree[kind.toLowerCase()]}` : tree[kind.toLowerCase()], terms }]));
}

export class Neo4jStore {
  constructor(config) {
    requireThat(config && typeof config.uri === 'string', 'database_config_required');
    const uri = new URL(config.uri);
    requireThat(['bolt:', 'neo4j:', 'bolt+s:', 'neo4j+s:'].includes(uri.protocol)
      && !uri.username && !uri.password && !uri.search && !uri.hash, 'invalid_database_uri');
    // A non-loopback server (another host, or a container network name) is an explicit operator choice.
    requireThat(config.allow_remote === true || ['127.0.0.1', '[::1]', 'localhost'].includes(uri.hostname), 'database_must_be_loopback');
    const password = config.password_env ? process.env[config.password_env] : undefined;
    requireThat(config.auth === 'none' || (typeof password === 'string' && password.length > 0), 'database_credentials_unavailable');
    this.driver = neo4j.driver(config.uri, config.auth === 'none' ? undefined : neo4j.auth.basic(config.user ?? 'neo4j', password), {
      disableLosslessIntegers: true, connectionAcquisitionTimeout: 10000,
      connectionTimeout: 10000, maxTransactionRetryTime: 10000,
    });
    this.database = config.database ?? 'neo4j';
    // Batch size and batches per `init` call when labelling a selection for its tree; tests lower them.
    this.backfill = { ...TREE_BACKFILL };
  }

  async close() { await this.driver.close(); }

  async transaction(mode, action) {
    const session = this.driver.session({ database: this.database });
    try { return await session[mode === 'write' ? 'executeWrite' : 'executeRead'](action, { timeout: 15000 }); }
    finally { await session.close(); }
  }

  // One write transaction. A refusal it raises on its first attempt rolled back with nothing committed. The driver may
  // retry after a commit whose reply was lost, so a refusal from a later attempt stays unmarked (outcome unknown).
  async atomicWrite(action) {
    let attempts = 0;
    try { return await this.transaction('write', tx => { attempts += 1; return action(tx); }); }
    catch (error) {
      if (error instanceof MemoryError && attempts === 1) markStage(error, 'rolled_back');
      throw error;
    }
  }

  // The database's own store id changes when the database is recreated, so it names this physical store.
  async identity() {
    return this.transaction('read', async tx => {
      const row = (await tx.run('CALL db.info() YIELD id, name RETURN id, name')).records[0];
      return { system: 'neo4j', database_id: row.get('id'), database: row.get('name') };
    });
  }

  async init(target, dimensions = null) {
    if (typeof target !== 'string' || isNested(target)) return this.initTree(target, dimensions);
    const scope = target;
    if (dimensions !== null) integer(dimensions, undefined, 1, 4096);
    for (const label of ['SMTurn', 'SMChunk', 'SMRecord', 'SMRelation']) {
      await this.transaction('write', tx => tx.run(`CREATE CONSTRAINT ${label.toLowerCase()}_uid IF NOT EXISTS FOR (n:${label}) REQUIRE n.uid IS UNIQUE`));
    }
    await this.transaction('write', tx => tx.run('CREATE INDEX smturn_lineage IF NOT EXISTS FOR (n:SMTurn) ON (n.scope, n.source, n.conversation_id, n.parent_turn_id)'));
    const ns = namespace(scope);
    const names = indexNames(scope);
    await this.transaction('write', tx => tx.run(`CREATE FULLTEXT INDEX ${names.turns} IF NOT EXISTS FOR (n:${ns}Turn) ON EACH [n.text]`));
    await this.transaction('write', tx => tx.run(`CREATE FULLTEXT INDEX ${names.records} IF NOT EXISTS FOR (n:${ns}Record) ON EACH [n.text]`));
    await this.transaction('write', tx => tx.run(`CREATE FULLTEXT INDEX ${names.chunks} IF NOT EXISTS FOR (n:${ns}Chunk) ON EACH [n.text]`));
    for (const index of [names.turns, names.records, names.chunks]) {
      await this.transaction('read', tx => tx.run('CALL db.awaitIndex($index,30)', { index }));
    }
    if (dimensions !== null) {
      for (const kind of ['chunk', 'record']) {
        await this.vectorIndexStatus(scope, kind, dimensions);
        const index = names[kind === 'chunk' ? 'vectorChunks' : 'vectorRecords'];
        const label = `${ns}${kind === 'chunk' ? 'Chunk' : 'Record'}`;
        await this.transaction('write', tx => tx.run(`CREATE VECTOR INDEX ${index} IF NOT EXISTS FOR (n:${label}) ON (n.embedding)
          OPTIONS {indexConfig:{\`vector.dimensions\`:$dimensions,\`vector.similarity_function\`:'cosine',\`vector.quantization.enabled\`:false}}`, { dimensions: neo4j.int(dimensions) }));
        requireThat(await this.vectorIndexStatus(scope, kind, dimensions) !== 'missing', 'vector_index_schema_mismatch');
      }
    }
    const states = dimensions === null ? null : await Promise.all(['chunk', 'record'].map(kind => this.vectorIndexStatus(scope, kind, dimensions)));
    return { initialized: true, scope, ...(states ? { vector_indexes: { chunk: states[0], record: states[1] } } : {}) };
  }

  /**
   * Schema for a nested scope or a subtree: its root's tree indexes and the scope range indexes, created without waiting for
   * population, and labels and terms on every path-scope node of the selection written without them, in bounded batches.
   * `init 'root/**'` also writes the opt-in marker, so the depth-1 root's own nodes join the tree from then on.
   */
  async initTree(target, dimensions = null) {
    if (dimensions !== null) integer(dimensions, undefined, 1, 4096);
    const sel = selection(target);
    const base = { turn: 'SMTurn', chunk: 'SMChunk', record: 'SMRecord' };
    for (const label of ['SMTurn', 'SMChunk', 'SMRecord', 'SMRelation']) {
      await this.transaction('write', tx => tx.run(`CREATE CONSTRAINT ${label.toLowerCase()}_uid IF NOT EXISTS FOR (n:${label}) REQUIRE n.uid IS UNIQUE`));
    }
    await this.transaction('write', tx => tx.run('CREATE CONSTRAINT smscopetree_root IF NOT EXISTS FOR (n:SMScopeTree) REQUIRE n.root IS UNIQUE'));
    await this.transaction('write', tx => tx.run('CREATE INDEX smturn_lineage IF NOT EXISTS FOR (n:SMTurn) ON (n.scope, n.source, n.conversation_id, n.parent_turn_id)'));
    for (const label of [...Object.values(base), 'SMRelation']) {
      await this.transaction('write', tx => tx.run(`CREATE INDEX ${label.toLowerCase()}_scope IF NOT EXISTS FOR (n:${label}) ON (n.scope)`));
    }
    for (const [kind, index] of [['turn', sel.names.turns], ['record', sel.names.records], ['chunk', sel.names.chunks]]) {
      await this.transaction('write', tx => tx.run(`CREATE FULLTEXT INDEX ${index} IF NOT EXISTS FOR (n:${sel.labels[kind]}) ON EACH [n.text, n.scope_terms]`));
    }
    if (dimensions !== null) {
      for (const kind of ['chunk', 'record']) {
        await this.vectorIndexStatus(target, kind, dimensions);
        const index = sel.names[kind === 'chunk' ? 'vectorChunks' : 'vectorRecords'];
        await this.transaction('write', tx => tx.run(`CREATE VECTOR INDEX ${index} IF NOT EXISTS FOR (n:${sel.labels[kind]}) ON (n.embedding)
          OPTIONS {indexConfig:{\`vector.dimensions\`:$dimensions,\`vector.similarity_function\`:'cosine',\`vector.quantization.enabled\`:false}}`, { dimensions: neo4j.int(dimensions) }));
        requireThat(await this.vectorIndexStatus(target, kind, dimensions) !== 'missing', 'vector_index_schema_mismatch');
      }
    }
    if (sel.subtree && scopePath(sel.scope).length === 1) {
      await this.transaction('write', tx => tx.run('MERGE (m:SMScopeTree {root:$root}) ON CREATE SET m.created_at=datetime()', { root: sel.scope }));
    }
    let labelled = 0;
    for (const kind of ['turn', 'chunk', 'record']) {
      for (let batch = 0; batch < this.backfill.batches; batch += 1) {
        const count = await this.transaction('write', async tx => {
          const rows = (await tx.run(`MATCH (n:${base[kind]}) WHERE ${sel.where('n')} AND NOT n:${sel.labels[kind]}
            RETURN n.uid AS uid, n.scope AS scope LIMIT $limit`, { ...sel.params, limit: neo4j.int(this.backfill.batch) })).records
            .map(row => ({ uid: row.get('uid'), terms: scopeTerms(row.get('scope')) }));
          if (rows.length) await tx.run(`UNWIND $rows AS row MATCH (n:${base[kind]} {uid:row.uid}) SET n:${sel.labels[kind]}, n.scope_terms=row.terms`, { rows });
          return rows.length;
        });
        labelled += count;
        if (count < this.backfill.batch) break;
      }
    }
    const states = dimensions === null ? null : await Promise.all(['chunk', 'record'].map(kind => this.vectorIndexStatus(target, kind, dimensions)));
    return { initialized: true, scope: sel.subtree ? `${sel.scope}/**` : sel.scope,
      ...(states ? { vector_indexes: { chunk: states[0], record: states[1] } } : {}),
      scope_tree: { labelled, pending: await this.treePending(target), indexes: await this.treeIndexStates(target) },
      ...(await this.legacyFlatIndex(target) ? { legacy_flat_index: true } : {}) };
  }

  /** Full-text states of a nested scope's or subtree's root tree. */
  async treeIndexStates(target) {
    const sel = selection(target);
    return this.transaction('read', async tx => {
      const result = await tx.run('SHOW FULLTEXT INDEXES YIELD name,state WHERE name IN $names RETURN name,state',
        { names: [sel.names.turns, sel.names.records, sel.names.chunks] });
      const states = Object.fromEntries(result.records.map(row => [row.get('name'), row.get('state')]));
      const state = name => states[name] === 'ONLINE' ? 'online' : states[name] === 'POPULATING' ? 'populating' : states[name] ? 'failed' : 'missing';
      return { turn: state(sel.names.turns), record: state(sel.names.records), chunk: state(sel.names.chunks) };
    });
  }

  /** A nested name that a pre-r1 `init` gave its own full-text index; its data predates the tree until `init` labels it. */
  async legacyFlatIndex(target) {
    const sel = selection(target);
    if (!sel.tree || sel.subtree) return false;
    return this.transaction('read', async tx => (await tx.run('SHOW FULLTEXT INDEXES YIELD name WHERE name=$name RETURN count(*) AS count',
      { name: indexNames(sel.scope).turns })).records[0].get('count') > 0);
  }

  /** Path-scope nodes of a nested scope or subtree not yet carrying the root's tree label, by kind; its indexes cannot see them. */
  async treePending(target) {
    const sel = selection(target);
    if (!sel.tree) return { turn: 0, chunk: 0, record: 0 };
    return this.transaction('read', async tx => {
      const counts = {};
      for (const [kind, base] of [['turn', 'SMTurn'], ['chunk', 'SMChunk'], ['record', 'SMRecord']]) {
        const result = await tx.run(`MATCH (n:${base}) WHERE ${sel.where('n')} AND NOT n:${sel.labels[kind]} RETURN count(n) AS count`, sel.params);
        counts[kind] = result.records[0].get('count');
      }
      return counts;
    });
  }

  async ingest(scope, turn, chunks) {
    const uid = identity('turn', scope, turn.source, turn.conversation_id, turn.turn_id);
    // Lineage places a turn; it is not its content. A retry that now names a parent replays the turn first stored without one,
    // and the first stored placement stays (no backfill). Hashes written before this rule covered the whole envelope.
    const { lineage_root: _root, ...placed } = turn;
    const hash = digest({ ...placed, parent_turn_id: null });
    const accepted = [hash, digest(turn)];
    return this.atomicWrite(async tx => {
      const { Turn: turnLabels, Chunk: chunkLabels } = await writeLabels(tx, scope, ['Turn', 'Chunk']);
      // Lineage properties exist only on turns ingested with them; older turns are never backfilled.
      const result = await tx.run(`MERGE (t:SMTurn {uid:$uid})
        ON CREATE SET t:${turnLabels.labels},${turnLabels.terms === null ? '' : ' t.scope_terms=$terms,'} t.scope=$scope, t.hash=$hash, t.body=$body, t.text=$text, t.created_at=datetime(),
          t.lineage=true, t.source=$source, t.conversation_id=$conversation, t.turn_key=$turnKey, t.parent_turn_id=$parent, t.lineage_root=$root
        RETURN t.hash AS hash, t.body AS body`, {
        uid, scope, hash, body: JSON.stringify(turn),
        text: turn.entries.map(entry => `[${entry.role}] ${entry.text}`).join('\n'),
        source: turn.source, conversation: turn.conversation_id, turnKey: turn.turn_id, parent: turn.parent_turn_id, root: turn.lineage_root === true,
        ...(turnLabels.terms === null ? {} : { terms: turnLabels.terms }),
      });
      requireThat(accepted.includes(result.records[0].get('hash')), 'source_identity_conflict');
      // Chunk identity is stable for the first ingestion. Replays never add a second chunking scheme.
      const existing = await tx.run('MATCH (t:SMTurn {uid:$uid}) RETURN t.chunked AS chunked', { uid });
      const replayed = existing.records[0].get('chunked') === true;
      if (!replayed) {
        const rows = chunks.map(chunk => ({ ...chunk, uid: identity('chunk', scope, uid, chunk.ordinal), turn_uid: uid, scope,
          ...(chunkLabels.terms === null ? {} : { scope_terms: chunkLabels.terms }) }));
        await tx.run(`MATCH (t:SMTurn {uid:$uid}) UNWIND $rows AS row
          CREATE (c:SMChunk:${chunkLabels.labels}) SET c = row CREATE (t)-[:SM_HAS_CHUNK]->(c)`, { uid, rows });
        await tx.run('MATCH (t:SMTurn {uid:$uid}) SET t.chunked=true', { uid });
      }
      return { id: uid, replayed, retained: true };
    });
  }

  async getTurn(scope, uid) {
    return this.transaction('read', async tx => {
      const result = await tx.run('MATCH (t:SMTurn {uid:$uid, scope:$scope}) RETURN t', { uid, scope });
      return decodeTurn(unwrap(result.records[0]?.get('t')));
    });
  }

  async sourceChunks(scope, turn) {
    return this.transaction('read', async tx => {
      const exists = await tx.run('MATCH (t:SMTurn {scope:$scope,uid:$turn}) RETURN count(t) AS count', { scope, turn });
      requireThat(exists.records[0]?.get('count') === 1, 'not_found');
      const rows = await tx.run(`MATCH (t:SMTurn {scope:$scope,uid:$turn})-[:SM_HAS_CHUNK]->(c:SMChunk {scope:$scope})
        RETURN c.entry_id AS entry_id,c.start AS start,c.end AS end,c.ordinal AS ordinal ORDER BY ordinal`, { scope, turn });
      return rows.records.map(row => row.toObject());
    });
  }

  async childTurns(scope, turn, limit) {
    return this.transaction('read', async tx => {
      const result = await tx.run(`MATCH (t:SMTurn {scope:$scope, source:$source, conversation_id:$conversation, parent_turn_id:$parent})
        RETURN t ORDER BY t.uid LIMIT $limit`, { scope, source: turn.source, conversation: turn.conversation_id, parent: turn.turn_id, limit: neo4j.int(limit) });
      return result.records.map(row => decodeTurn(unwrap(row.get('t'))));
    });
  }

  /**
   * Same-conversation turns whose place in the history is unknown: stored before lineage existed, missing a parent
   * without being a declared root, or naming a parent this store does not hold (a capture gap).
   */
  async unlinkedTurns(scope, turn) {
    return this.transaction('read', async tx => {
      const linked = await tx.run(`MATCH (t:SMTurn {scope:$scope, source:$source, conversation_id:$conversation})
        RETURN t.uid AS uid, t.turn_key AS key, t.parent_turn_id AS parent, t.lineage_root AS root`,
      { scope, source: turn.source, conversation: turn.conversation_id });
      const legacy = await tx.run('MATCH (t:SMTurn {scope:$scope}) WHERE t.lineage IS NULL RETURN t.uid AS uid, t.body AS body', { scope });
      const rows = linked.records.map(row => row.toObject());
      const keys = new Set(rows.map(row => row.key));
      const unknownParent = rows.filter(row => row.uid !== turn.id && (row.parent == null ? row.root !== true : !keys.has(row.parent))).length;
      const unlinkedLegacy = legacy.records.filter(row => row.get('uid') !== turn.id).map(row => JSON.parse(row.get('body')))
        .filter(body => body.source === turn.source && body.conversation_id === turn.conversation_id).length;
      return unknownParent + unlinkedLegacy;
    });
  }

  async getRecord(scope, id) {
    const uid = identity('record', scope, id);
    return this.transaction('read', async tx => {
      const result = await tx.run('MATCH (r:SMRecord {uid:$uid, scope:$scope}) RETURN r', { uid, scope });
      return decodeRecord(unwrap(result.records[0]?.get('r')));
    });
  }

  async getRecords(scope, ids) {
    return this.transaction('read', async tx => {
      const result = await tx.run('MATCH (r:SMRecord {scope:$scope}) WHERE r.record_id IN $ids RETURN r', { scope, ids });
      return result.records.map(row => decodeRecord(unwrap(row.get('r'))));
    });
  }

  async enrich(scope, payload) {
    return this.atomicWrite(async tx => {
      const allSpans = [...payload.records, ...payload.relations].flatMap(row => row.evidence);
      const turns = new Map();
      for (const uid of new Set(allSpans.map(span => span.turn))) {
        const result = await tx.run('MATCH (t:SMTurn {uid:$uid, scope:$scope}) RETURN t', { uid, scope });
        const turn = decodeTurn(unwrap(result.records[0]?.get('t')));
        requireThat(turn, 'evidence_unavailable');
        turns.set(uid, turn);
      }
      for (const span of allSpans) sourceExcerpt(turns.get(span.turn), span);
      const endpoints = new Map(payload.records.map(row => [row.id, row]));
      for (const id of new Set(payload.relations.flatMap(edge => [edge.from, edge.to]))) {
        if (endpoints.has(id)) continue;
        const result = await tx.run('MATCH (r:SMRecord {uid:$uid, scope:$scope}) RETURN r', { uid: identity('record', scope, id), scope });
        const record = decodeRecord(unwrap(result.records[0]?.get('r')));
        requireThat(record, 'relation_endpoint_unavailable');
        endpoints.set(id, record);
      }
      for (const edge of payload.relations.filter(row => row.type === 'outcome_of')) {
        requireThat(endpoints.get(edge.from).kind === 'outcome' && OUTCOME_REFERENT_KINDS.includes(endpoints.get(edge.to).kind), 'invalid_outcome_relation');
      }
      for (const record of payload.records.filter(row => row.kind === 'outcome')) {
        const supplied = payload.relations.some(edge => edge.from === record.id && edge.type === 'outcome_of');
        if (!supplied) {
          const result = await tx.run(`MATCH (e:SMRelation {scope:$scope, from_uid:$uid, type:"outcome_of"})
            MATCH (target:SMRecord {uid:e.to_uid, scope:$scope}) RETURN target`, { scope, uid: identity('record', scope, record.id) });
          requireThat(result.records.length > 0 && result.records.every(row => OUTCOME_REFERENT_KINDS.includes(decodeRecord(unwrap(row.get('target'))).kind)), 'outcome_referent_required');
        }
      }
      const { Record: recordLabels } = await writeLabels(tx, scope, ['Record']);
      for (const record of payload.records) {
        const uid = identity('record', scope, record.id);
        const hash = digest(record);
        const result = await tx.run(`MERGE (r:SMRecord {uid:$uid})
          ON CREATE SET r:${recordLabels.labels},${recordLabels.terms === null ? '' : ' r.scope_terms=$terms,'} r.scope=$scope, r.record_id=$id, r.hash=$hash, r.body=$body, r.text=$text, r.created_at=datetime()
          RETURN r.hash AS hash`, { uid, scope, id: record.id, hash, body: JSON.stringify(record), text: record.text,
          ...(recordLabels.terms === null ? {} : { terms: recordLabels.terms }) });
        requireThat(result.records[0].get('hash') === hash, 'record_identity_conflict');
        await tx.run('MATCH (r:SMRecord {uid:$uid}) UNWIND $turns AS turn MATCH (t:SMTurn {uid:turn,scope:$scope}) MERGE (r)-[:SM_EVIDENCE]->(t)', {
          uid, scope, turns: [...new Set(record.evidence.map(span => span.turn))],
        });
      }
      for (const edge of payload.relations) {
        const uid = identity('relation', scope, edge.id);
        const hash = digest(edge);
        const from = identity('record', scope, edge.from);
        const to = identity('record', scope, edge.to);
        const result = await tx.run(`MERGE (e:SMRelation {uid:$uid})
          ON CREATE SET e.scope=$scope, e.hash=$hash, e.body=$body, e.type=$type, e.from_uid=$from, e.to_uid=$to
          WITH e MATCH (a:SMRecord {uid:$from,scope:$scope}), (b:SMRecord {uid:$to,scope:$scope})
          MERGE (e)-[:SM_FROM]->(a) MERGE (e)-[:SM_TO]->(b) RETURN e.hash AS hash`, {
          uid, scope, hash, body: JSON.stringify(edge), type: edge.type, from, to,
        });
        requireThat(result.records[0]?.get('hash') === hash, 'relation_identity_conflict');
      }
      return { records: payload.records.map(row => row.id), relations: payload.relations.map(row => row.id) };
    });
  }

  async turnVectorsVisible(scope, model, turn) {
    const index = selection(scope).names.vectorChunks;
    const session = this.driver.session({ database: this.database });
    try {
      return await session.executeRead(async tx => {
        const exists = await tx.run('MATCH (t:SMTurn {scope:$scope,uid:$turn}) RETURN count(t) AS count', { scope, turn });
        requireThat(exists.records[0]?.get('count') === 1, 'not_found');
        const stored = await tx.run('MATCH (c:SMChunk {scope:$scope,turn_uid:$turn}) RETURN c.uid AS uid,c.embedding AS vector,c.embedding_key AS model', { scope, turn });
        for (const row of stored.records) {
          const uid = row.get('uid'), vector = row.get('vector');
          if (row.get('model') !== model || !Array.isArray(vector) || !vector.length) return false;
          const hits = await tx.run(`CALL db.index.vector.queryNodes($index,$k,$vector) YIELD node
            WHERE node.uid=$uid AND node.scope=$scope RETURN count(node) AS hits`,
          { index, k: neo4j.int(4096), vector, uid, scope });
          if (hits.records[0]?.get('hits') !== 1) return false;
        }
        return true;
      }, { timeout: 120000 });
    } finally { await session.close(); }
  }

  async recordVectorsVisible(scope, model, ids) {
    const index = selection(scope).names.vectorRecords;
    return this.transaction('read', async tx => {
      for (const id of ids) {
        const uid = identity('record', scope, id);
        const stored = await tx.run('MATCH (r:SMRecord {uid:$uid,scope:$scope,embedding_key:$model}) RETURN r.embedding AS vector', { uid, scope, model });
        const vector = stored.records[0]?.get('vector');
        if (!Array.isArray(vector) || !vector.length) return false;
        const hits = await tx.run(`CALL db.index.vector.queryNodes($index,$k,$vector) YIELD node
          WHERE node.uid=$uid AND node.scope=$scope RETURN count(node) AS hits`,
        { index, k: neo4j.int(4096), vector, uid, scope });
        if (hits.records[0]?.get('hits') !== 1) return false;
      }
      return true;
    });
  }

  async pendingEmbeddings(scope, model, limit) {
    return this.transaction('read', async tx => {
      const result = await tx.run(`MATCH (n) WHERE (n:SMChunk OR n:SMRecord) AND n.scope=$scope
        AND (n.embedding_key IS NULL OR n.embedding_key <> $model)
        RETURN n.uid AS uid, n.text AS text ORDER BY n.uid LIMIT $limit`, { scope, model, limit: neo4j.int(limit) });
      return result.records.map(row => ({ uid: row.get('uid'), text: row.get('text') }));
    });
  }

  async saveEmbeddings(scope, model, rows) {
    return this.transaction('write', tx => tx.run(`UNWIND $rows AS row MATCH (n {uid:row.uid,scope:$scope})
      WHERE n:SMChunk OR n:SMRecord SET n.embedding=row.vector, n.embedding_key=$model`, { scope, model, rows }));
  }

  // The exclusion is applied before the limit, so excluded matches never take the place of eligible ones.
  async lexical(scope, kind, query, limit, exclude = []) {
    const lucene = lexicalQuery(query);
    if (!lucene) return [];
    const sel = selection(scope);
    const index = sel.names[kind === 'turn' ? 'turns' : 'records'];
    return this.transaction('read', async tx => {
      const result = await tx.run(`CALL db.index.fulltext.queryNodes($index,$query) YIELD node,score WHERE ${eligible('node')}
        RETURN node,score ORDER BY score DESC,node.uid LIMIT $limit`, {
        index, query: sel.lucene(lucene), limit: neo4j.int(limit), exclude,
      });
      return result.records.map(row => {
        const node = unwrap(row.get('node'));
        requireThat(sel.owns(node.scope), 'index_scope_mismatch');
        return { kind, id: kind === 'turn' ? node.uid : node.record_id, text: node.text, ...(sel.subtree ? { scope: node.scope } : {}) };
      });
    });
  }

  async chunkLexicalStatus(scope) {
    return this.transaction('read', async tx => {
      const result = await tx.run('SHOW FULLTEXT INDEXES YIELD name,state WHERE name=$name RETURN state', { name: selection(scope).names.chunks });
      const state = result.records[0]?.get('state');
      if (state === 'ONLINE') return { status: 'ready' };
      if (state === 'POPULATING') return { status: 'pending' };
      return { status: 'unavailable', reason: !state ? 'chunk_index_missing' : state === 'FAILED' ? 'chunk_index_failed' : 'chunk_index_unavailable' };
    });
  }

  async chunkLexical(scope, query, limit, exclude = []) {
    const lucene = lexicalQuery(query);
    if (!lucene) return [];
    const sel = selection(scope);
    return this.transaction('read', async tx => {
      const result = await tx.run(`CALL db.index.fulltext.queryNodes($index,$query) YIELD node,score WHERE ${eligible('node')}
        MATCH (turn:SMTurn)-[:SM_HAS_CHUNK]->(node)
        RETURN node,score,turn ORDER BY score DESC,node.uid LIMIT $limit`, {
        index: sel.names.chunks, query: sel.lucene(lucene), limit: neo4j.int(limit), exclude,
      });
      return result.records.map(row => {
        const node = unwrap(row.get('node'));
        const parent = unwrap(row.get('turn'));
        requireThat(sel.owns(node.scope) && parent.scope === node.scope, 'index_scope_mismatch');
        const body = JSON.parse(parent.body);
        const entries = body.entries.filter(entry => entry.id === node.entry_id);
        // An inexact legacy entry join must not discard an otherwise valid lexical hit.
        const role = entries.length === 1 ? node.role ?? entries[0].role : 'unknown';
        const legacy = parent.source == null || parent.conversation_id == null;
        return { kind: 'turn', id: parent.uid, text: node.text, ...(sel.subtree ? { scope: parent.scope } : {}),
          match: { turn: parent.uid, entry_id: node.entry_id, start: node.start, end: node.end, role },
          conversation: { scope: parent.scope, source: parent.source ?? body.source, conversation_id: parent.conversation_id ?? body.conversation_id,
            ...(legacy ? { legacy: true } : {}) } };
      });
    });
  }

  async lexicalStatus(scope, kind) {
    return this.transaction('read', async tx => {
      const index = selection(scope).names[{ turn: 'turns', record: 'records', chunk: 'chunks' }[kind]];
      const result = await tx.run('SHOW FULLTEXT INDEXES YIELD name,state WHERE name=$name RETURN state', { name: index });
      const state = result.records[0]?.get('state');
      if (state === 'ONLINE') return { status: 'ready' };
      if (state === 'POPULATING') return { status: 'pending' };
      return { status: 'unavailable', reason: `${kind}_index_${!state ? 'missing' : state === 'FAILED' ? 'failed' : 'unavailable'}` };
    });
  }

  async admittedLexical(scope, kind, query, limit, perConversation, exclude = [], trace = passthrough) {
    const lucene = lexicalQuery(query);
    if (!lucene) return { hits: [], omitted: [], admitted_conversations: 0, exhausted: false };
    const sel = selection(scope);
    const index = sel.names[{ turn: 'turns', record: 'records', chunk: 'chunks' }[kind]];
    return this.admission(scope, kind, `CALL db.index.fulltext.queryNodes($index,$query) YIELD node,score WHERE ${eligible('node')}
      WITH node,score ORDER BY score DESC,node.uid
      WITH collect({node:node,score:score}) AS matches
      WITH matches,size(matches) AS total`, { index, query: sel.lucene(lucene), limit: neo4j.int(limit), per: neo4j.int(perConversation), exclude }, false, trace);
  }

  async admittedVectors(scope, kind, model, vector, scanned, limit, perConversation, exclude = []) {
    const sel = selection(scope);
    const label = sel.tree ? sel.members[kind] : kind === 'chunk' ? 'SMChunk' : 'SMRecord';
    return this.admission(scope, kind, `CALL {
        MATCH (node:${label} {embedding_key:$model}) WHERE ${sel.where('node')} AND ${eligible('node')}
        RETURN count(node) AS total
      }
      CALL {
        UNWIND $scanned AS uid MATCH (node:${label} {uid:uid,embedding_key:$model}) WHERE ${sel.where('node')} AND ${eligible('node')}
        WITH node,vector.similarity.cosine(node.embedding,$vector) AS score ORDER BY score DESC,node.uid
        RETURN collect({node:node,score:score}) AS matches
      }`, { model, vector, scanned, limit: neo4j.int(limit), per: neo4j.int(perConversation), exclude });
  }

  async admission(scope, kind, search, params, withRawCount = false, trace = passthrough) {
    const sel = selection(scope);
    return this.transaction('read', async tx => {
      // Neo4j core cannot decode JSON. Only legacy grouping keys are decoded here; exclusion never uses this map.
      const old = await trace(`admission.${kind}.legacy`, () => tx.run(`MATCH (t:SMTurn) WHERE ${sel.where('t')} AND (t.source IS NULL OR t.conversation_id IS NULL)
        RETURN t.uid AS uid,t.body AS body`, sel.params));
      const legacy = Object.fromEntries(old.records.map(row => {
        const body = JSON.parse(row.get('body'));
        return [row.get('uid'), { source: body.source, conversation_id: body.conversation_id }];
      }));
      const parents = kind === 'turn' ? 'WITH node,score,[node] AS parents' : kind === 'chunk'
        ? 'MATCH (parent:SMTurn {scope:node.scope})-[:SM_HAS_CHUNK]->(node) WITH node,score,collect(DISTINCT parent) AS parents'
        : 'CALL { WITH node MATCH (node)-[:SM_EVIDENCE]->(parent:SMTurn {scope:node.scope}) RETURN collect(DISTINCT parent) AS parents }';
      const seed = kind === 'chunk' ? 'parents[0].uid' : 'node.uid';
      const result = await trace(`admission.${kind}.search`, () => tx.run(`${search}
        CALL {
          WITH matches UNWIND matches AS candidate WITH candidate.node AS node,candidate.score AS score
          ${parents}
          WITH node,score,parents,[parent IN parents | {scope:parent.scope,source:coalesce(parent.source,$legacy[parent.uid].source),
            conversation_id:coalesce(parent.conversation_id,$legacy[parent.uid].conversation_id)}] AS keys
          WITH {node:node,score:score,parents:parents,keys:keys,seed_id:${seed}} AS hit ORDER BY hit.score DESC,hit.node.uid
          WITH hit.seed_id AS seed_id,head(collect(hit)) AS hit
          WITH hit ORDER BY hit.score DESC,hit.node.uid
          WITH collect(hit) AS unique
          WITH unique,reduce(admitted=[],hit IN unique |
            CASE WHEN all(key IN hit.keys WHERE size([prior IN admitted WHERE key IN prior.keys]) < $per)
              THEN admitted + hit ELSE admitted END) AS admitted
          RETURN admitted,[hit IN unique WHERE NOT any(prior IN admitted WHERE prior.seed_id=hit.seed_id) |
            {kind:$seedKind,id:CASE WHEN $seedKind='record' THEN hit.node.record_id ELSE hit.seed_id END,keys:hit.keys,scope:hit.node.scope}] AS omitted
        }
        RETURN admitted[..$limit] AS rows,omitted,total > $limit AS exhausted${withRawCount ? ',raw_count,size(matches) AS considered' : ''}`,
      { ...params, ...sel.params, legacy, seedKind: kind === 'record' ? 'record' : 'turn' }));
      const row = result.records[0];
      const hits = (row?.get('rows') ?? []).map(hit => {
        const node = unwrap(hit.node);
        const parents = hit.parents.map(unwrap);
        requireThat(sel.owns(node.scope) && parents.length && parents.every(parent => parent.scope === node.scope), 'index_scope_mismatch');
        const contexts = new Map();
        for (const parent of parents) {
          const old = parent.source == null || parent.conversation_id == null;
          const body = old ? JSON.parse(parent.body) : null;
          const key = { scope: parent.scope, source: parent.source ?? body.source, conversation_id: parent.conversation_id ?? body.conversation_id };
          requireThat(typeof key.source === 'string' && typeof key.conversation_id === 'string', 'conversation_unavailable');
          const token = JSON.stringify(key);
          contexts.set(token, { key, ...(old || contexts.get(token)?.legacy ? { legacy: true } : {}) });
        }
        const conversations = [...contexts.values()];
        const own = sel.subtree ? { scope: node.scope } : {};
        if (kind !== 'chunk') return { kind, id: kind === 'turn' ? node.uid : node.record_id, text: node.text, ...own, conversations };
        const parent = parents[0];
        const entries = JSON.parse(parent.body).entries.filter(entry => entry.id === node.entry_id);
        const role = entries.length === 1 ? node.role ?? entries[0].role : 'unknown';
        return { kind: 'turn', id: parent.uid, text: node.text, ...own,
          match: { turn: parent.uid, entry_id: node.entry_id, start: node.start, end: node.end, role }, conversations };
      });
      // Omitted seeds name their scope only in a subtree read, where a record id alone is ambiguous.
      const omitted = (row?.get('omitted') ?? []).map(({ scope: owner, ...seed }) => sel.subtree ? { ...seed, scope: owner } : seed);
      return { hits, omitted, exhausted: row?.get('exhausted') ?? false,
        admitted_conversations: new Set(hits.flatMap(hit => hit.conversations.map(context => JSON.stringify(context.key)))).size,
        ...(withRawCount ? { raw_count: row?.get('raw_count') ?? 0, considered: row?.get('considered') ?? 0 } : {}) };
    });
  }

  async vectorIndexStatus(scope, kind, dimensions = null) {
    const sel = selection(scope);
    const index = sel.names[kind === 'chunk' ? 'vectorChunks' : 'vectorRecords'];
    return this.transaction('read', async tx => {
      const result = await tx.run(`SHOW INDEXES YIELD name,type,state,labelsOrTypes,properties,options
        WHERE name=$index RETURN type,state,labelsOrTypes,properties,options`, { index });
      if (!result.records.length) return 'missing';
      const row = result.records[0].toObject();
      const config = row.options?.indexConfig ?? {};
      const label = sel.labels[kind];
      requireThat(row.type === 'VECTOR' && row.labelsOrTypes.length === 1 && row.labelsOrTypes[0] === label
        && row.properties.length === 1 && row.properties[0] === 'embedding'
        && String(config['vector.similarity_function']).toLowerCase() === 'cosine', 'vector_index_schema_mismatch');
      requireThat(dimensions === null || Number(config['vector.dimensions']) === dimensions, 'vector_index_dimension_mismatch');
      requireThat(config['vector.quantization.enabled'] === false, 'vector_index_quantization_mismatch');
      return row.state === 'ONLINE' ? 'online' : row.state === 'POPULATING' ? 'populating' : 'failed';
    });
  }

  async vectorCounts(scope, kind, model, exclude = []) {
    const sel = selection(scope);
    const match = sel.tree ? `(node:${sel.members[kind]}) WHERE ${sel.where('node')} AND` : `(node:${sel.labels[kind]} {scope:$scope}) WHERE`;
    // WHERE accepts only true. Full-branch CASE guards preserve OR eligibility without assuming disjoint labels.
    const eligibility = `CASE
      WHEN size($exclude) = 0 THEN true
      WHEN node:SMTurn AND NOT ${excludedTurn('node')} THEN true
      WHEN node:SMChunk AND EXISTS { MATCH (t:SMTurn)-[:SM_HAS_CHUNK]->(node) WHERE NOT ${excludedTurn('t')} } THEN true
      WHEN node:SMRecord AND (NOT EXISTS { MATCH (node)-[:SM_EVIDENCE]->(:SMTurn) }
        OR EXISTS { MATCH (node)-[:SM_EVIDENCE]->(t:SMTurn) WHERE NOT ${excludedTurn('t')} }) THEN true
      ELSE false END`;
    return this.transaction('read', async tx => {
      const result = await tx.run(`MATCH ${match} ${eligibility}
        RETURN count(CASE WHEN node.embedding_key=$model THEN 1 END) AS total,
          count(CASE WHEN node.embedding_key IS NULL OR node.embedding_key<>$model THEN 1 END) AS unindexed`, { ...sel.params, model, exclude });
      return result.records[0].toObject();
    });
  }

  // `census` lets a caller that already counted the eligible nodes pass that count in.
  async indexedVectors(scope, kind, model, vector, limit, perConversation = null, exclude = [], budget = { remaining: 7 }, census = null) {
    integer(limit, undefined, 1, 256);
    if (perConversation !== null) integer(perConversation, undefined, 1, 4);
    const sel = selection(scope);
    const index = sel.names[kind === 'chunk' ? 'vectorChunks' : 'vectorRecords'];
    // A short approximate result is not exhaustion evidence. Census both grouped and ordinary queries independently.
    const { total, unindexed } = census ?? await this.vectorCounts(scope, kind, model, exclude);
    const empty = perConversation === null ? { nodes: [] } : { hits: [], omitted: [], admitted_conversations: 0, exhausted: total > limit };
    const cap = 4096;
    let k = Math.max(limit * 4, 64);
    let rounds = 0;
    let previous = empty;
    while (true) {
      if (budget.remaining <= 0) return { ...previous, k, rounds, unindexed, partial: true, reason: 'vector_query_budget', ran: rounds > 0 };
      budget.remaining -= 1;
      rounds += 1;
      const params = { index, ...sel.params, model, vector, exclude, k: neo4j.int(k), limit: neo4j.int(limit),
        total: neo4j.int(total), per: perConversation === null ? null : neo4j.int(perConversation) };
      const search = `CALL db.index.vector.queryNodes($index,$k,$vector) YIELD node,score
        WITH collect({node:node,score:score}) AS raw
        CALL {
          WITH raw UNWIND raw AS candidate WITH candidate.node AS node,candidate.score AS score
          WHERE ${sel.where('node')} AND node.embedding_key=$model AND ${eligible('node')}
          WITH node,vector.similarity.cosine(node.embedding,$vector) AS score ORDER BY score DESC,node.uid
          RETURN collect({node:node,score:score}) AS matches
        }
        WITH matches,size(raw) AS raw_count,$total AS total`;
      const result = perConversation !== null ? await this.admission(scope, kind, search, params, true)
        : await this.transaction('read', async tx => {
          const selected = await tx.run(`${search} RETURN matches[..$limit] AS rows,raw_count,size(matches) AS considered`, params);
          const row = selected.records[0];
          const nodes = row.get('rows').map(hit => {
            const node = unwrap(hit.node);
            requireThat(sel.owns(node.scope), 'index_scope_mismatch');
            return { ...node, similarity: 2 * hit.score - 1 };
          });
          return { nodes, raw_count: row.get('raw_count'), considered: row.get('considered') };
        });
      const size = perConversation === null ? result.nodes.length : result.hits.length;
      if (size >= Math.min(limit, total) || result.considered >= total) return { ...result, k, rounds, unindexed, partial: false, ran: true };
      if (k === cap) return { ...result, k, rounds, unindexed, partial: true, reason: 'vector_overfetch_cap', ran: true };
      previous = result;
      k = Math.min(k * 2, cap);
    }
  }

  async vectors(scope, model, limit, exclude = [], kind = null) {
    const sel = selection(scope);
    return this.transaction('read', async tx => {
      // A tree read scans only what the tree indexes hold; unlabelled nodes are reported as pending instead.
      const base = kind === null ? '(n:SMChunk OR n:SMRecord)' : kind === 'chunk' ? 'n:SMChunk' : 'n:SMRecord';
      const labels = !sel.tree ? base : kind === null ? `(n:SMChunk:${sel.labels.chunk} OR n:SMRecord:${sel.labels.record})` : `${base}:${sel.labels[kind]}`;
      const result = await tx.run(`MATCH (n) WHERE ${labels} AND ${sel.where('n')} AND n.embedding_key=$model AND ${eligible('n')}
        RETURN n ORDER BY n.uid LIMIT $limit`, { ...sel.params, model, limit: neo4j.int(limit), exclude });
      return result.records.map(row => unwrap(row.get('n')));
    });
  }

  /**
   * Exact cosine over a nested scope's or subtree's tree-labelled vectors, scored in Cypher so no embedding leaves the
   * database: the top `limit` hits with the fields a recall hit needs, and every eligible uid for grouped admission.
   */
  async treeVectorScan(target, kind, model, vector, limit, exclude = []) {
    const sel = selection(target);
    requireThat(sel.tree, 'invalid_input');
    return this.transaction('read', async tx => {
      const result = await tx.run(`MATCH (n:${sel.members[kind]} {embedding_key:$model}) WHERE ${sel.where('n')} AND ${eligible('n')}
        WITH n, vector.similarity.cosine(n.embedding, $vector) AS score ORDER BY score DESC, n.uid
        WITH collect({uid:n.uid, scope:n.scope, turn_uid:n.turn_uid, record_id:n.record_id, entry_id:n.entry_id, start:n.start, end:n.end,
          text:n.text}) AS rows
        RETURN rows[..$limit] AS top, [row IN rows | row.uid] AS uids`, { ...sel.params, model, vector, exclude, limit: neo4j.int(limit) });
      const row = result.records[0];
      const top = row.get('top');
      requireThat(top.every(node => sel.owns(node.scope)), 'index_scope_mismatch');
      return { nodes: top, uids: row.get('uids') };
    });
  }

  /**
   * One batch of turns and records of a selection, newest first by (created_at, uid) and strictly after `after`. A node
   * written without `created_at` sorts as the oldest instant. Turns return only their envelope header (the body before its
   * entries) and entry count, never their text; records return their body and the source keys of their evidence turns.
   */
  async listBatch(target, { turns, records, after, limit }) {
    const sel = selection(target);
    return this.transaction('read', async tx => {
      const result = await tx.run(`CALL {
          MATCH (n:SMTurn) WHERE $turns AND ${sel.where('n')} RETURN n, 'turn' AS type
          UNION ALL
          MATCH (n:SMRecord) WHERE $records AND ${sel.where('n')} RETURN n, 'record' AS type
        }
        WITH n, type, coalesce(n.created_at, datetime($epoch)) AS at
        WHERE $after IS NULL OR at < datetime($after.at) OR (at = datetime($after.at) AND n.uid < $after.uid)
        WITH n, type, at ORDER BY at DESC, n.uid DESC LIMIT $limit
        RETURN n.uid AS uid, type, toString(at) AS at, n.created_at IS NULL AS untimed, n.scope AS scope,
          CASE WHEN type = 'turn' THEN split(n.body, ',"entries":')[0] + '}' END AS header,
          CASE WHEN type = 'turn' THEN size(split(n.body, '{"id":"')) - 1 END AS entry_count,
          CASE WHEN type = 'record' THEN n.body END AS body,
          CASE WHEN type = 'record' THEN [(n)-[:SM_EVIDENCE]->(t:SMTurn) | {source: t.source, conversation_id: t.conversation_id,
            header: CASE WHEN t.source IS NULL OR t.conversation_id IS NULL THEN split(t.body, ',"entries":')[0] + '}' END}] END AS evidence`,
      { ...sel.params, turns, records, after, epoch: LIST_EPOCH, limit: neo4j.int(limit) });
      return result.records.map(row => row.toObject());
    });
  }

  /** Every record in the scope, for the D0 oracle-catalog diagnostic; ordered for a stable presentation. */
  async catalogRecords(scope, limit) {
    return this.transaction('read', async tx => {
      const result = await tx.run('MATCH (r:SMRecord {scope:$scope}) RETURN r ORDER BY r.uid LIMIT $limit', { scope, limit: neo4j.int(limit) });
      return result.records.map(row => decodeRecord(unwrap(row.get('r'))));
    });
  }

  async recordsForTurn(scope, uid, limit) {
    return this.transaction('read', async tx => {
      const result = await tx.run(`MATCH (r:SMRecord {scope:$scope})-[:SM_EVIDENCE]->(t:SMTurn {uid:$uid,scope:$scope})
        RETURN DISTINCT r ORDER BY r.uid LIMIT $limit`, { scope, uid, limit: neo4j.int(limit) });
      return result.records.map(row => decodeRecord(unwrap(row.get('r'))));
    });
  }

  async neighbors(scope, ids, limit) {
    return this.transaction('read', async tx => {
      const result = await tx.run(`MATCH (e:SMRelation {scope:$scope})
        WHERE e.from_uid IN $uids OR e.to_uid IN $uids
        RETURN e ORDER BY CASE WHEN e.type='supersedes' THEN 0 ELSE 1 END,e.uid LIMIT $limit`, {
        scope, uids: ids.map(id => identity('record', scope, id)), limit: neo4j.int(limit),
      });
      return result.records.map(row => decodeRelation(unwrap(row.get('e'))));
    });
  }

  // `unindexed` counts only what a recall with this exclusion could return.
  async status(scope, embeddingKey = null, exclude = []) {
    const sel = selection(scope);
    return this.transaction('read', async tx => {
      // A tree selection seeks each label's scope index; the flat query is the one it always was.
      const nodes = sel.tree ? `CALL {
          MATCH (n:SMTurn) WHERE ${sel.where('n')} RETURN n UNION ALL MATCH (n:SMChunk) WHERE ${sel.where('n')} RETURN n
          UNION ALL MATCH (n:SMRecord) WHERE ${sel.where('n')} RETURN n UNION ALL MATCH (n:SMRelation) WHERE ${sel.where('n')} RETURN n
        } WITH n` : `MATCH (n) WHERE ${sel.where('n')} AND (n:SMTurn OR n:SMChunk OR n:SMRecord OR n:SMRelation)`;
      const result = await tx.run(`${nodes}
        RETURN count(CASE WHEN n:SMTurn THEN 1 END) AS turns,
          count(CASE WHEN n:SMChunk THEN 1 END) AS chunks,
          count(CASE WHEN n:SMRecord THEN 1 END) AS records,
          count(CASE WHEN n:SMRelation THEN 1 END) AS relations,
          count(CASE WHEN (n:SMChunk OR n:SMRecord) AND ($model IS NULL OR n.embedding_key IS NULL OR n.embedding_key <> $model) AND ${eligible('n')} THEN 1 END) AS unindexed`,
        { ...sel.params, model: embeddingKey, exclude });
      return result.records[0].toObject();
    });
  }
}
