import neo4j from 'neo4j-driver';
import { authorize, isNested, requireThat } from './core.mjs';
import { embeddingContextContract, embeddingIdentity } from './models.mjs';
import { Neo4jStore, selection } from './store.mjs';

export const CENSUS_CAP = 4096;
const health = { online: 1, populating: 2, missing: 3, failed: 4, incompatible: 5, unavailable: 6 };
const missing = '(n.embedding IS NULL OR n.embedding_key IS NULL OR n.embedding_key <> $key)';
const chunk = `MATCH (n:SMChunk {scope:$scope}) USING INDEX SEEK n:SMChunk(scope)
WITH n LIMIT $limit
WITH n, ${missing} AS missing
OPTIONAL MATCH (t:SMTurn {uid:n.turn_uid}) USING INDEX SEEK t:SMTurn(uid)
  WHERE missing AND t.scope=$scope
WITH n, missing, t, CASE
  WHEN NOT missing THEN 'indexed'
  WHEN n.embedding_oversized_key=$key AND n.embedding_oversized_cap=8192 AND n.embedding_oversized_text=n.text THEN 'byte'
  WHEN CASE WHEN n.text IS :: STRING NOT NULL THEN size(n.text)>8192 ELSE false END THEN 'byte'
  WHEN n.embedding_rejected_context=$context AND n.embedding_rejected_text=n.text THEN 'context'
  WHEN n.embedding_retry_key=$key AND n.embedding_retry_after IS :: ZONED DATETIME NOT NULL THEN 'retry'
  ELSE 'other' END AS bucket
RETURN count(*) AS chunks_total, count(CASE WHEN NOT missing THEN 1 END) AS chunks_indexed,
  count(CASE WHEN missing THEN 1 END) AS chunks_unindexed,
  count(CASE WHEN bucket='byte' THEN 1 END) AS terminal_byte,
  count(CASE WHEN bucket='context' THEN 1 END) AS terminal_context,
  count(CASE WHEN bucket='retry' THEN 1 END) AS retry_marked,
  count(CASE WHEN bucket='retry' AND n.embedding_retry_after>datetime.transaction() THEN 1 END) AS cooling,
  count(CASE WHEN bucket='other' THEN 1 END) AS other,
  count(CASE WHEN missing AND n.embedding_key=$key THEN 1 END) AS same_key_missing_chunks,
  count(DISTINCT t) AS turns_affected,
  count(CASE WHEN missing AND t IS NULL THEN 1 END) AS missing_chunk_turn_binding`;
const record = `MATCH (n:SMRecord {scope:$scope}) USING INDEX SEEK n:SMRecord(scope)
WITH n LIMIT $limit
RETURN count(*) AS records_total, count(CASE WHEN ${missing} THEN 1 END) AS missing_record_vectors,
  count(CASE WHEN n.embedding IS NULL AND n.embedding_key=$key THEN 1 END) AS same_key_missing_records`;
export const CENSUS_TIMEOUT_MS = 15000;

async function counts(tx, statement, params) {
  const result = await tx.run(statement, params);
  requireThat(result.records.length === 1 && result.summary.notifications.length === 0
    && !result.summary.counters.containsUpdates(), 'census_unverified');
  const row = result.records[0].toObject();
  requireThat(Object.values(row).every(value => Number.isSafeInteger(value) && value >= 0), 'census_unverified');
  return row;
}

async function indexHealth(tx, scope, dimensions) {
  const sel = selection(scope);
  const names = { chunk: sel.names.vectorChunks, record: sel.names.vectorRecords };
  const result = await tx.run(`SHOW INDEXES YIELD name,type,state,labelsOrTypes,properties,options
    WHERE name IN $names RETURN name,type,state,labelsOrTypes,properties,options`, { names: Object.values(names) });
  requireThat(result.records.length <= 2 && !result.summary.notifications.length
    && !result.summary.counters.containsUpdates(), 'census_unverified');
  const rows = result.records.map(row => row.toObject());
  return Object.fromEntries(Object.entries(names).map(([kind, name]) => {
    const row = rows.find(candidate => candidate.name === name);
    const index = row?.options?.indexConfig;
    const state = !row ? 'missing' : row.type !== 'VECTOR' || row.labelsOrTypes?.length !== 1
      || row.labelsOrTypes[0] !== sel.labels[kind] || row.properties?.length !== 1 || row.properties[0] !== 'embedding'
      || String(index?.['vector.similarity_function']).toLowerCase() !== 'cosine'
      || Number(index?.['vector.dimensions']) !== dimensions || index?.['vector.quantization.enabled'] !== false
      ? 'incompatible' : row.state === 'ONLINE' ? 'online' : row.state === 'POPULATING' ? 'populating' : 'failed';
    return [`${kind}_index_health`, health[state]];
  }));
}

export async function indexCensus(config, scope, suppliedStore) {
  authorize(config, scope);
  requireThat(!isNested(scope) && config.scopes.read.includes(scope), 'scope_denied');
  const key = embeddingIdentity(config.embedding);
  requireThat(key, 'embedding_unconfigured');
  const context = embeddingContextContract(config.embedding);
  const store = suppliedStore ?? new Neo4jStore(config.neo4j);
  try {
    const session = store.driver.session({ database: store.database, defaultAccessMode: neo4j.session.READ });
    try {
      const tx = session.beginTransaction({ timeout: CENSUS_TIMEOUT_MS });
      try {
        const params = { scope, key, context, limit: neo4j.int(CENSUS_CAP + 1) };
        const chunks = await counts(tx, chunk, params);
        requireThat(chunks.chunks_total <= CENSUS_CAP, 'census_over_bound');
        const records = await counts(tx, record, { ...params, limit: neo4j.int(CENSUS_CAP - chunks.chunks_total + 1) });
        requireThat(chunks.chunks_total + records.records_total <= CENSUS_CAP, 'census_over_bound');
        const health = await indexHealth(tx, scope, config.embedding.dimensions);
        await tx.commit();
        return { ...chunks, ...records, ...health };
      } finally { await tx.close(); }
    } finally { await session.close(); }
  } finally { if (!suppliedStore) await store.close(); }
}
