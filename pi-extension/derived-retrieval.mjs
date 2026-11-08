import { authorize, cosine, digest, fuse, integer, text } from '../src/core.mjs';
import { embed, embeddingIdentity } from '../src/models.mjs';

const fail = code => Object.assign(new Error(code), { code });
const evidenceId = span => digest(['derived-evidence/v1', span.turn, span.entry_id, span.start, span.end]);

function project(scope, bundle, id) {
  const record = bundle.records.find(row => row.id === id);
  if (!record || !Array.isArray(record.supporting_evidence)) throw fail('record_unavailable');
  const links = bundle.relations.filter(row => row.from === id || row.to === id)
    .map(row => ({ id: row.id, type: row.type, from: row.from, to: row.to, attribution: row.attribution }));
  const evidence = [...record.supporting_evidence, ...bundle.relations
    .filter(row => row.from === id || row.to === id).flatMap(row => row.supporting_evidence ?? [])];
  const offered = new Map(evidence.map(span => [evidenceId(span), span]));
  return { record: { id, scope, text: JSON.stringify({ kind: record.kind, text: record.text, status: record.status,
    attribution: record.attribution, links, relationship_context_complete: bundle.relationship_context_complete }),
  evidence: [...offered.keys()].map(ref => ({ id: ref, scope })) }, offered };
}

/** The product's record lexical and vector channels seed retrieval; turn and chunk channels do not. */
export async function searchDerived(memory, scope, input) {
  authorize(memory.config, scope);
  const query = text(input?.query, 4000);
  const limit = integer(input?.limit, 8, 1, 32);
  if (!memory.store || typeof memory.bundle !== 'function' || typeof memory.store.lexicalStatus !== 'function'
    || !memory.config.embedding) throw fail('search_unavailable');
  const candidates = 64;
  const state = await memory.store.lexicalStatus(scope, 'record');
  if (state?.status !== 'ready') throw fail('search_unavailable');
  const lexical = await memory.store.lexical(scope, 'record', query, candidates, []);
  if (!Array.isArray(lexical) || lexical.length > candidates || lexical.some(seed => seed.kind !== 'record')) throw fail('search_invalid');
  const key = embeddingIdentity(memory.config.embedding);
  const [vector] = await embed(memory.config.embedding, [query]);
  const index = await memory.store.vectorIndexStatus(scope, 'record', vector.length);
  let nodes;
  if (index === 'online') {
    const result = await memory.store.indexedVectors(scope, 'record', key, vector, candidates, null, [], { remaining: 14 });
    if (result.partial !== false || result.unindexed !== 0 || !Array.isArray(result.nodes)) throw fail('search_incomplete');
    nodes = result.nodes;
  } else if (index === 'missing') {
    const scanLimit = integer(memory.config.vector_scan_limit, 10000, 1, 100000);
    const scanned = await memory.store.vectors(scope, key, scanLimit + 1, [], 'record');
    const counts = await memory.store.vectorCounts(scope, 'record', key, []);
    if (!Array.isArray(scanned) || scanned.length > scanLimit || counts?.unindexed !== 0) throw fail('search_incomplete');
    nodes = scanned.map(row => ({ ...row, similarity: cosine(vector, row.embedding) })).filter(row => Number.isFinite(row.similarity))
      .sort((a, b) => b.similarity - a.similarity || a.uid.localeCompare(b.uid)).slice(0, candidates);
  } else throw fail('search_incomplete');
  if (!Array.isArray(nodes) || nodes.length > candidates || nodes.some(row => typeof row.record_id !== 'string')) throw fail('search_invalid');
  const vectorHits = nodes.map(row => ({ kind: 'record', id: row.record_id, text: row.text }));
  const seeds = fuse({ record_lexical: lexical, record_vector: vectorHits }).slice(0, limit);
  const output = [];
  for (const seed of seeds) {
    const bundle = await memory.bundle(scope, seed, query, 48, 4);
    output.push(project(scope, bundle, seed.id).record);
  }
  return output;
}

/** Diagnostic raw-only lexical retrieval; derived records and vector channels never seed it. */
export async function searchRaw(memory, scope, input) {
  authorize(memory.config, scope);
  const query = text(input?.query, 4000);
  const limit = integer(input?.limit, 8, 1, 32);
  const turnState = await memory.store.lexicalStatus(scope, 'turn');
  const chunkState = await memory.store.chunkLexicalStatus(scope);
  if (turnState?.status !== 'ready' || chunkState?.status !== 'ready') throw fail('search_unavailable');
  const turns = await memory.store.lexical(scope, 'turn', query, 64, []);
  const chunks = await memory.store.chunkLexical(scope, query, 64, []);
  if (!Array.isArray(turns) || !Array.isArray(chunks) || [...turns, ...chunks].some(seed => seed.kind !== 'turn')) throw fail('search_invalid');
  const seeds = fuse({ turn_lexical: turns, chunk_lexical: chunks }).slice(0, limit);
  const output = [];
  for (const seed of seeds) {
    const bundle = await memory.bundle(scope, seed, query, 48, 4);
    if (!bundle.source || !Array.isArray(bundle.source.excerpts)) throw fail('source_unavailable');
    const body = bundle.source.excerpts.map(row => row.text).filter(value => typeof value === 'string').join('\n');
    if (body) output.push({ id: seed.id, scope, text: body });
  }
  return output;
}

/** Re-resolve only evidence belonging to the named derived item or its displayed links. */
export async function resolveDerived(memory, scope, input) {
  authorize(memory.config, scope);
  const id = text(input?.item_id, 256);
  const ref = text(input?.evidence_id, 128);
  const shown = await memory.show(scope, { kind: 'bundle', seed: { kind: 'record', id }, max_nodes: 48, max_hops: 4 });
  const { offered } = project(scope, shown.bundle, id);
  const span = offered.get(ref);
  if (!span) throw fail('evidence_not_offered');
  return { id: ref, scope, text: span.text };
}

/** Each named store supplies its own current-snapshot verifier; no cross-scope fallback is possible. */
export function createDerivedAdapter({ stores }) {
  if (!stores || typeof stores !== 'object') throw fail('stores_invalid');
  async function select({ storeId, actor, queryTime, readScopes, evidenceScopes }) {
    const store = stores[storeId];
    if (!store || typeof store.scope !== 'string' || !readScopes?.includes(store.scope) || !evidenceScopes?.includes(store.scope)
      || typeof store.authorize !== 'function' || typeof store.verifySnapshot !== 'function' || typeof store.snapshotId !== 'string'
      || !store.snapshotId || !Number.isFinite(Date.parse(queryTime))) throw fail('scope_unresolved');
    if (await store.authorize({ actor, queryTime, readScopes, evidenceScopes }) !== true) throw fail('scope_unresolved');
    if (await store.verifySnapshot(queryTime) !== store.snapshotId) throw fail('snapshot_unverified');
    return store;
  }
  async function recheck(store, queryTime) {
    if (await store.verifySnapshot(queryTime) !== store.snapshotId) throw fail('snapshot_unverified');
  }
  return {
    async search(args) {
      const store = await select(args);
      const result = await store.client.searchDerived(store.scope, { query: args.query, limit: args.limit });
      await recheck(store, args.queryTime);
      return result;
    },
    async resolve(args) {
      const store = await select(args);
      const result = await store.client.resolveDerived(store.scope, { item_id: args.itemId, evidence_id: args.evidenceId });
      await recheck(store, args.queryTime);
      return result;
    },
  };
}
