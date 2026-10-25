import neo4j from 'neo4j-driver';
import { digest, identity, indexNames, namespace, requireThat, sourceExcerpt, lexicalQuery } from './core.mjs';

const unwrap = node => node?.properties ?? null;
const decodeTurn = props => props ? { id: props.uid, scope: props.scope, ...JSON.parse(props.body) } : null;
const decodeRecord = props => props ? { uid: props.uid, scope: props.scope, ...JSON.parse(props.body) } : null;
const decodeRelation = props => props ? { uid: props.uid, ...JSON.parse(props.body) } : null;

/**
 * Cypher predicate over `$exclude` ([{source, conversation_id}]): false for a turn of an excluded conversation, a chunk of
 * such a turn, and a record whose every evidence turn is in one. A record with any other evidence stays, so a mixed bundle
 * still reaches the caller. Turns stored before lineage properties existed carry no conversation and are never excluded.
 */
const excludedTurn = turn => `any(x IN $exclude WHERE x.source = ${turn}.source AND x.conversation_id = ${turn}.conversation_id)`;
const eligible = n => `(size($exclude) = 0
  OR (${n}:SMTurn AND NOT ${excludedTurn(n)})
  OR (${n}:SMChunk AND EXISTS { MATCH (t:SMTurn)-[:SM_HAS_CHUNK]->(${n}) WHERE NOT ${excludedTurn('t')} })
  OR (${n}:SMRecord AND (NOT EXISTS { MATCH (${n})-[:SM_EVIDENCE]->(:SMTurn) }
    OR EXISTS { MATCH (${n})-[:SM_EVIDENCE]->(t:SMTurn) WHERE NOT ${excludedTurn('t')} })))`;

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
  }

  async close() { await this.driver.close(); }

  async transaction(mode, action) {
    const session = this.driver.session({ database: this.database });
    try { return await session[mode === 'write' ? 'executeWrite' : 'executeRead'](action, { timeout: 15000 }); }
    finally { await session.close(); }
  }

  async init(scope) {
    for (const label of ['SMTurn', 'SMChunk', 'SMRecord', 'SMRelation']) {
      await this.transaction('write', tx => tx.run(`CREATE CONSTRAINT ${label.toLowerCase()}_uid IF NOT EXISTS FOR (n:${label}) REQUIRE n.uid IS UNIQUE`));
    }
    await this.transaction('write', tx => tx.run('CREATE INDEX smturn_lineage IF NOT EXISTS FOR (n:SMTurn) ON (n.scope, n.source, n.conversation_id, n.parent_turn_id)'));
    const ns = namespace(scope);
    const names = indexNames(scope);
    await this.transaction('write', tx => tx.run(`CREATE FULLTEXT INDEX ${names.turns} IF NOT EXISTS FOR (n:${ns}Turn) ON EACH [n.text]`));
    await this.transaction('write', tx => tx.run(`CREATE FULLTEXT INDEX ${names.records} IF NOT EXISTS FOR (n:${ns}Record) ON EACH [n.text]`));
    await this.transaction('read', tx => tx.run('CALL db.awaitIndexes(30)'));
    return { initialized: true, scope };
  }

  async ingest(scope, turn, chunks) {
    const uid = identity('turn', scope, turn.source, turn.conversation_id, turn.turn_id);
    // Lineage places a turn; it is not its content. A retry that now names a parent replays the turn first stored without one,
    // and the first stored placement stays (no backfill). Hashes written before this rule covered the whole envelope.
    const { lineage_root: _root, ...placed } = turn;
    const hash = digest({ ...placed, parent_turn_id: null });
    const accepted = [hash, digest(turn)];
    const ns = namespace(scope);
    return this.transaction('write', async tx => {
      // Lineage properties exist only on turns ingested with them; older turns are never backfilled.
      const result = await tx.run(`MERGE (t:SMTurn {uid:$uid})
        ON CREATE SET t:${ns}Turn, t.scope=$scope, t.hash=$hash, t.body=$body, t.text=$text, t.created_at=datetime(),
          t.lineage=true, t.source=$source, t.conversation_id=$conversation, t.turn_key=$turnKey, t.parent_turn_id=$parent, t.lineage_root=$root
        RETURN t.hash AS hash, t.body AS body`, {
        uid, scope, hash, body: JSON.stringify(turn),
        text: turn.entries.map(entry => `[${entry.role}] ${entry.text}`).join('\n'),
        source: turn.source, conversation: turn.conversation_id, turnKey: turn.turn_id, parent: turn.parent_turn_id, root: turn.lineage_root === true,
      });
      requireThat(accepted.includes(result.records[0].get('hash')), 'source_identity_conflict');
      // Chunk identity is stable for the first ingestion. Replays never add a second chunking scheme.
      const existing = await tx.run('MATCH (t:SMTurn {uid:$uid}) RETURN t.chunked AS chunked', { uid });
      const replayed = existing.records[0].get('chunked') === true;
      if (!replayed) {
        const rows = chunks.map(chunk => ({ ...chunk, uid: identity('chunk', scope, uid, chunk.ordinal), turn_uid: uid, scope }));
        await tx.run(`MATCH (t:SMTurn {uid:$uid}) UNWIND $rows AS row
          CREATE (c:SMChunk:${ns}Chunk) SET c = row CREATE (t)-[:SM_HAS_CHUNK]->(c)`, { uid, rows });
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

  async enrich(scope, payload) {
    return this.transaction('write', async tx => {
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
        requireThat(endpoints.get(edge.from).kind === 'outcome' && endpoints.get(edge.to).kind === 'action', 'invalid_outcome_relation');
      }
      for (const record of payload.records.filter(row => row.kind === 'outcome')) {
        const supplied = payload.relations.some(edge => edge.from === record.id && edge.type === 'outcome_of');
        if (!supplied) {
          const result = await tx.run(`MATCH (e:SMRelation {scope:$scope, from_uid:$uid, type:"outcome_of"})
            MATCH (target:SMRecord {uid:e.to_uid, scope:$scope}) RETURN target`, { scope, uid: identity('record', scope, record.id) });
          requireThat(result.records.length > 0 && result.records.every(row => decodeRecord(unwrap(row.get('target'))).kind === 'action'), 'outcome_referent_required');
        }
      }
      const ns = namespace(scope);
      for (const record of payload.records) {
        const uid = identity('record', scope, record.id);
        const hash = digest(record);
        const result = await tx.run(`MERGE (r:SMRecord {uid:$uid})
          ON CREATE SET r:${ns}Record, r.scope=$scope, r.record_id=$id, r.hash=$hash, r.body=$body, r.text=$text, r.created_at=datetime()
          RETURN r.hash AS hash`, { uid, scope, id: record.id, hash, body: JSON.stringify(record), text: record.text });
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
    const index = indexNames(scope)[kind === 'turn' ? 'turns' : 'records'];
    return this.transaction('read', async tx => {
      const result = await tx.run(`CALL db.index.fulltext.queryNodes($index,$query) YIELD node,score WHERE ${eligible('node')}
        RETURN node,score ORDER BY score DESC,node.uid LIMIT $limit`, {
        index, query: lucene, limit: neo4j.int(limit), exclude,
      });
      return result.records.map(row => {
        const node = unwrap(row.get('node'));
        requireThat(node.scope === scope, 'index_scope_mismatch');
        return { kind, id: kind === 'turn' ? node.uid : node.record_id, text: node.text };
      });
    });
  }

  async vectors(scope, model, limit, exclude = []) {
    return this.transaction('read', async tx => {
      const result = await tx.run(`MATCH (n) WHERE (n:SMChunk OR n:SMRecord) AND n.scope=$scope AND n.embedding_key=$model AND ${eligible('n')}
        RETURN n ORDER BY n.uid LIMIT $limit`, { scope, model, limit: neo4j.int(limit), exclude });
      return result.records.map(row => unwrap(row.get('n')));
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
    return this.transaction('read', async tx => {
      const result = await tx.run(`MATCH (n) WHERE n.scope=$scope AND (n:SMTurn OR n:SMChunk OR n:SMRecord OR n:SMRelation)
        RETURN count(CASE WHEN n:SMTurn THEN 1 END) AS turns,
          count(CASE WHEN n:SMChunk THEN 1 END) AS chunks,
          count(CASE WHEN n:SMRecord THEN 1 END) AS records,
          count(CASE WHEN n:SMRelation THEN 1 END) AS relations,
          count(CASE WHEN (n:SMChunk OR n:SMRecord) AND ($model IS NULL OR n.embedding_key IS NULL OR n.embedding_key <> $model) AND ${eligible('n')} THEN 1 END) AS unindexed`,
        { scope, model: embeddingKey, exclude });
      return result.records[0].toObject();
    });
  }
}
