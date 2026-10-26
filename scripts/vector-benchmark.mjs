import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import neo4j from 'neo4j-driver';
import { Memory } from '../src/memory.mjs';
import { cosine, identity, namespace } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';

const exec = promisify(execFile);
const name = `source-memory-vector-benchmark-${randomUUID()}`;
const scope = 'benchmark-768';
const dimensions = 768;
const started = new Date().toISOString();
const results = [];
let owned = false;
let stopped = false;
let removed = false;
let memory;
let failure = null;

async function stop() {
  if (!owned || stopped || removed) return;
  try { await exec('docker', ['stop', '--time', '10', name], { timeout: 30000 }); stopped = true; }
  catch (error) {
    if (String(error.stderr).includes('No such container')) removed = true;
    else throw error;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  try { await stop(); } finally { process.exit(130); }
});
const errorData = error => ({ code: error.code ?? null, message: String(error.message).slice(0, 1000) });
async function sample(action) {
  try {
    await action();
    const values = [];
    for (let index = 0; index < 5; index += 1) {
      const before = performance.now();
      await action();
      values.push(performance.now() - before);
    }
    return { median_ms: Number([...values].sort((a, b) => a - b)[2].toFixed(3)), samples_ms: values.map(value => Number(value.toFixed(3))) };
  } catch (error) { return { unavailable: errorData(error) }; }
}

try {
  await exec('docker', ['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::7687',
    '--memory', '1536m', '--cpus', '2', '--env', 'NEO4J_AUTH=none',
    '--env', 'NEO4J_server_memory_heap_initial__size=512m', '--env', 'NEO4J_server_memory_heap_max__size=512m',
    '--env', 'NEO4J_server_memory_pagecache_size=128m', 'neo4j:5.26.14-community'], { timeout: 90000 });
  owned = true;
  const mapping = (await exec('docker', ['port', name, '7687/tcp'])).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error('unexpected private port mapping');
  const uri = `bolt://${mapping}`;
  let ready = false;
  for (let index = 0; index < 90; index += 1) {
    const driver = neo4j.driver(uri, undefined, { connectionTimeout: 1000, connectionAcquisitionTimeout: 1500, maxTransactionRetryTime: 0 });
    try { await driver.verifyConnectivity(); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    finally { await driver.close(); }
  }
  if (!ready) throw new Error('private Neo4j did not become ready');
  const embedding = { url: 'http://127.0.0.1:9/unused', model: 'synthetic-768', dimensions };
  memory = new Memory({ neo4j: { uri, auth: 'none' }, embedding, scopes: { read: [scope], write: [scope] } });
  const key = embeddingIdentity(embedding);
  await memory.init(scope);
  const waitOnline = async () => {
    const deadline = performance.now() + 180000;
    while (performance.now() < deadline) {
      const states = (await memory.status(scope)).vector_indexes;
      if (Object.values(states).every(state => state === 'online')) return;
      if (Object.values(states).includes('failed')) throw new Error('private vector index failed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('private vector population deadline exceeded');
  };
  await waitOnline();
  const sin = Array.from({ length: dimensions }, (_, dim) => Math.sin(dim * 0.17));
  const cos = Array.from({ length: dimensions }, (_, dim) => Math.cos(dim * 0.17));
  const offset = Array.from({ length: dimensions }, (_, dim) => Math.cos(dim * 0.31) * 0.25);
  const vector = index => {
    const phase = index * 0.0001;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    return sin.map((value, dim) => value * c + cos[dim] * s + offset[dim]);
  };
  const query = vector(0);
  const ns = namespace(scope);
  const text = 'Synthetic source.';
  const worstCaseWidening = async () => {
    const parents = Array.from({ length: 200 }, (_, index) => ({
      uid: identity('turn', scope, 'benchmark', `dense-${index}`, 'root'), conversation: `dense-${index}`,
    }));
    const old = parents[9999 % 200].uid;
    const uid = identity('chunk', scope, old, 9999);
    const far = identity('turn', scope, 'benchmark', 'widen-eligible', 'root');
    await memory.store.transaction('write', tx => tx.run(`UNWIND $parents AS parent MATCH (t:SMTurn {uid:parent.uid})
      SET t.conversation_id='widen-dominant'`, { parents }));
    await memory.store.transaction('write', tx => tx.run(`MATCH (old:SMTurn {uid:$old})-[edge:SM_HAS_CHUNK]->(c:SMChunk {uid:$uid}) DELETE edge
      MERGE (far:SMTurn {uid:$far}) ON CREATE SET far:${ns}Turn,far.scope=$scope,far.source='benchmark',
        far.conversation_id='widen-eligible',far.turn_key='root',far.lineage=true,far.lineage_root=true,far.body=$body,far.text=$text
      SET c.turn_uid=$far,c.embedding=$vector CREATE (far)-[:SM_HAS_CHUNK]->(c)`,
    { old, uid, far, scope, text, vector: query.map(value => -value), body: JSON.stringify({ source: 'benchmark',
      conversation_id: 'widen-eligible', turn_id: 'root', entries: [{ id: 'v', role: 'user', text }] }) }));
    try {
      const exclude = [{ source: 'benchmark', conversation_id: 'widen-dominant' }];
      const action = async per => {
        const result = await memory.store.indexedVectors(scope, 'chunk', key, query, 1, per, exclude);
        if (result.rounds !== 7 || !result.partial || result.reason !== 'vector_overfetch_cap') throw new Error('worst-case widening fixture did not reach seven capped rounds');
      };
      const ordinary = await sample(() => action(null));
      const grouped = await sample(() => action(1));
      const result = { dimensions, vectors: 10000, candidates: 1, excluded_vectors: 9999, eligible_vectors: 1,
        rounds: 7, quantization: false, ordinary, grouped };
      results.at(-1).worst_case_widening = result;
      console.log(`VECTOR_768_WIDENING ${JSON.stringify(result)}`);
    } finally {
      await memory.store.transaction('write', tx => tx.run(`MATCH (far:SMTurn {uid:$far})-[edge:SM_HAS_CHUNK]->(c:SMChunk {uid:$uid}) DELETE edge
        SET c.turn_uid=$old,c.embedding=$vector WITH far,c MATCH (old:SMTurn {uid:$old}) CREATE (old)-[:SM_HAS_CHUNK]->(c) DELETE far`,
      { old, uid, far, vector: vector(9999) }));
      await memory.store.transaction('write', tx => tx.run(`UNWIND $parents AS parent MATCH (t:SMTurn {uid:parent.uid})
        SET t.conversation_id=parent.conversation`, { parents }));
    }
  };
  let loaded = 0;
  for (const count of [10000, 50000]) {
    try {
      for (let first = loaded; first < count; first += 500) {
        const rows = [];
        for (let index = first; index < Math.min(count, first + 500); index += 1) {
          const conversation = `dense-${index % 200}`;
          const uid = identity('turn', scope, 'benchmark', conversation, 'root');
          rows.push({ parent: { uid, scope, source: 'benchmark', conversation_id: conversation, turn_key: 'root', lineage: true,
            lineage_root: true, body: JSON.stringify({ source: 'benchmark', conversation_id: conversation, turn_id: 'root',
              entries: [{ id: 'v', role: 'user', text }] }), text },
          chunk: { uid: identity('chunk', scope, uid, index), scope, turn_uid: uid, entry_id: 'v', role: 'user', ordinal: index,
            start: 0, end: text.length, text, embedding: vector(index), embedding_key: key } });
        }
        await memory.store.transaction('write', tx => tx.run(`UNWIND $rows AS row
          MERGE (t:SMTurn {uid:row.parent.uid}) ON CREATE SET t:${ns}Turn,t += row.parent
          CREATE (c:SMChunk:${ns}Chunk) SET c=row.chunk CREATE (t)-[:SM_HAS_CHUNK]->(c)`, { rows }));
        loaded = first + rows.length;
      }
      await waitOnline();
      const scan = await sample(async () => (await memory.store.vectors(scope, key, count + 1, [], 'chunk'))
        .map(row => ({ ...row, similarity: cosine(query, row.embedding) }))
        .sort((a, b) => b.similarity - a.similarity || a.uid.localeCompare(b.uid)).slice(0, 64));
      const index = await sample(() => memory.store.indexedVectors(scope, 'chunk', key, query, 64));
      results.push({ dimensions, vectors: count, scan, index_quantization_off: index,
        ...(scan.median_ms && index.median_ms ? { speedup: Number((scan.median_ms / index.median_ms).toFixed(2)) } : {}) });
      console.log(`VECTOR_768_LATENCY ${JSON.stringify(results.at(-1))}`);
      if (count === 10000 && (scan.unavailable || index.unavailable)) throw new Error('required 10000-vector benchmark unavailable');
      if (count === 10000) await worstCaseWidening();
    } catch (error) {
      failure = errorData(error);
      if (count === 10000) process.exitCode = 1;
      results.push({ dimensions, requested_vectors: count, loaded_vectors: loaded, unavailable: failure });
      break;
    }
  }
} catch (error) { failure = errorData(error); process.exitCode = 1; }
finally {
  try { await memory?.close(); } catch {}
  try { await stop(); } catch (error) { failure ??= errorData(error); process.exitCode = 1; }
  await mkdir('.memory-local', { recursive: true, mode: 0o700 });
  const report = { started_at: started, finished_at: new Date().toISOString(),
    fixture: 'private Neo4j5.26.14; 1536m memory; 2 CPUs; 512m heap; 128m pagecache', candidates: 64,
    method: 'warm vector retrieval/scoring/top-k, including native eligible census; no catalog/fusion/render/model calls; one warmup and five samples; original 15s transaction bound',
    results, failure, owned_container: name, container_stopped: stopped, container_removed: removed };
  const path = `.memory-local/vector-768-benchmark-${started.replaceAll(':', '-')}.json`;
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`768-d benchmark report: ${path}`);
}
