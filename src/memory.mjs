import {
  authorize, chunkEntries, cosine, fuse, integer, MemoryError,
  normalizeEnrichment, normalizeTurn, requireThat, sourceExcerpt, text,
} from './core.mjs';
import { embed, embeddingIdentity, rerank } from './models.mjs';
import { Neo4jStore } from './store.mjs';

export class Memory {
  constructor(config, store = null) {
    this.config = config;
    this.store = store ?? new Neo4jStore(config.neo4j);
  }

  async close() { await this.store.close(); }

  async init(scope) {
    authorize(this.config, scope, 'write');
    return this.store.init(scope);
  }

  async ingest(scope, input) {
    authorize(this.config, scope, 'write');
    const turn = normalizeTurn(input);
    const size = integer(this.config.chunking?.words, 256, 8, 4096);
    const overlap = integer(this.config.chunking?.overlap, Math.min(32, size - 1), 0, size - 1);
    const result = await this.store.ingest(scope, turn, chunkEntries(turn, size, overlap));
    return { ...result, indexing: await this.indexAfterWrite(scope) };
  }

  async enrich(scope, input) {
    authorize(this.config, scope, 'write');
    const result = await this.store.enrich(scope, normalizeEnrichment(input));
    return { ...result, indexing: await this.indexAfterWrite(scope) };
  }

  // Callers on a latency-sensitive path set index_on_write:false and run `index` separately.
  async indexAfterWrite(scope) {
    if (this.config.embedding && this.config.index_on_write === false) return { status: 'deferred', indexed: 0 };
    return this.index(scope);
  }

  async index(scope, input = {}) {
    authorize(this.config, scope, 'write');
    if (!this.config.embedding) return { status: 'unconfigured', indexed: 0 };
    try {
      const key = embeddingIdentity(this.config.embedding);
      const limit = integer(input.limit, 256, 1, 2048);
      const pending = await this.store.pendingEmbeddings(scope, key, limit + 1);
      const selected = pending.slice(0, limit);
      let indexed = 0;
      for (let offset = 0; offset < selected.length; offset += 16) {
        const batch = selected.slice(offset, offset + 16);
        const vectors = await embed(this.config.embedding, batch.map(row => row.text));
        await this.store.saveEmbeddings(scope, key, batch.map((row, index) => ({ uid: row.uid, vector: vectors[index] })));
        indexed += batch.length;
      }
      return { status: pending.length > limit ? 'pending' : 'ready', indexed, embedding_key: key };
    } catch (error) {
      return { status: 'unavailable', reason: safeCode(error), source_retained: true };
    }
  }

  async status(scope) {
    authorize(this.config, scope);
    const key = embeddingIdentity(this.config.embedding);
    return { scope, ...(await this.store.status(scope, key)),
      embedding: key ? { configured: true, model: this.config.embedding.model, key } : { configured: false },
      reranker: { configured: Boolean(this.config.reranker) } };
  }

  async show(scope, input) {
    authorize(this.config, scope);
    if (input.kind === 'bundle') return this.showBundle(scope, input);
    const id = text(input.id, 256);
    requireThat(['turn', 'record'].includes(input.kind), 'invalid_kind');
    if (input.kind === 'turn') {
      const turn = await this.store.getTurn(scope, id);
      requireThat(turn, 'not_found');
      return { kind: 'turn', turn };
    }
    const record = await this.store.getRecord(scope, id);
    requireThat(record, 'not_found');
    return { kind: 'record', record, evidence: await this.evidence(scope, record.evidence) };
  }

  // Rebuilds one seed's relationship-closed bundle without a query, so a caller can detect changes since it last read it.
  async showBundle(scope, input) {
    const seed = input.seed;
    requireThat(seed && ['turn', 'record'].includes(seed.kind), 'invalid_kind');
    const id = text(seed.id, 256);
    const maxNodes = integer(input.max_nodes, 48, 1, 256);
    const maxHops = integer(input.max_hops, 4, 0, 12);
    if (seed.kind === 'turn') requireThat(await this.store.getTurn(scope, id), 'not_found');
    else requireThat(await this.store.getRecord(scope, id), 'not_found');
    const bundle = await this.bundle(scope, { kind: seed.kind, id, score: null, channels: [] }, '', maxNodes, maxHops);
    return { kind: 'bundle', bundle };
  }

  async evidence(scope, spans) {
    authorize(this.config, scope);
    const turns = new Map();
    const result = [];
    for (const span of spans) {
      if (!turns.has(span.turn)) turns.set(span.turn, await this.store.getTurn(scope, span.turn));
      const turn = turns.get(span.turn);
      requireThat(turn, 'evidence_unavailable');
      result.push({ ...sourceExcerpt(turn, span), source: turn.source,
        conversation_id: turn.conversation_id, turn_id: turn.turn_id });
    }
    return result;
  }

  async recall(scope, input) {
    authorize(this.config, scope);
    const query = text(input.query, 4000);
    const candidates = integer(input.candidates, 64, 1, 256);
    const limit = integer(input.limit, 8, 1, 32);
    const maxNodes = integer(input.max_nodes, 48, 1, 256);
    const maxHops = integer(input.max_hops, 4, 0, 12);
    const maxChars = integer(input.max_chars, 24000, 256, 200000);
    const vectorLimit = integer(this.config.vector_scan_limit, 10000, 1, 100000);
    const availability = {};
    const channels = {};
    await Promise.all(['turn', 'record'].map(async kind => {
      const name = `${kind}_lexical`;
      try {
        channels[name] = await this.store.lexical(scope, kind, query, candidates);
        availability[name] = { status: 'ready' };
      } catch (error) {
        channels[name] = [];
        availability[name] = { status: 'unavailable', reason: safeCode(error) };
      }
    }));
    channels.chunk_vector = [];
    channels.record_vector = [];
    if (this.config.embedding) {
      try {
        const key = embeddingIdentity(this.config.embedding);
        const [queryVector] = await embed(this.config.embedding, [query]);
        const vectors = await this.store.vectors(scope, key, vectorLimit + 1);
        const counts = await this.store.status(scope, key);
        const ranked = vectors.slice(0, vectorLimit).map(row => ({ ...row, similarity: cosine(queryVector, row.embedding) }))
          .filter(row => Number.isFinite(row.similarity)).sort((a, b) => b.similarity - a.similarity || a.uid.localeCompare(b.uid));
        channels.chunk_vector = ranked.filter(row => row.turn_uid).slice(0, candidates).map(row => ({
          kind: 'turn', id: row.turn_uid, text: row.text,
          match: { turn: row.turn_uid, entry_id: row.entry_id, start: row.start, end: row.end },
        }));
        channels.record_vector = ranked.filter(row => row.record_id).slice(0, candidates)
          .map(row => ({ kind: 'record', id: row.record_id, text: row.text }));
        const state = { status: vectors.length > vectorLimit || counts.unindexed > 0 ? 'partial' : 'ready',
          scan_truncated: vectors.length > vectorLimit, unindexed: counts.unindexed, embedding_key: key };
        availability.chunk_vector = state;
        availability.record_vector = { ...state };
      } catch (error) {
        availability.chunk_vector = { status: 'unavailable', reason: safeCode(error) };
        availability.record_vector = { ...availability.chunk_vector };
      }
    } else {
      availability.chunk_vector = { status: 'unconfigured' };
      availability.record_vector = { status: 'unconfigured' };
    }
    let ranked = fuse(channels).slice(0, candidates);
    if (this.config.reranker && ranked.length) {
      try {
        // This cut affects ranking only. Evidence is read independently from the retained source.
        const cut = ranked.some(item => item.text.length > 16000);
        ranked = await rerank(this.config.reranker, query, ranked.map(item => ({ ...item, text: item.text.slice(0, 16000) })));
        availability.reranker = { status: 'ready', ranking_text_truncated: cut };
      } catch (error) { availability.reranker = { status: 'unavailable', reason: safeCode(error) }; }
    } else availability.reranker = { status: this.config.reranker ? 'not_needed' : 'unconfigured' };

    const bundles = [];
    let chars = 0;
    let budgetOmitted = 0;
    for (const seed of ranked.slice(0, limit)) {
      const bundle = await this.bundle(scope, seed, query, maxNodes, maxHops);
      const size = JSON.stringify(bundle).length;
      if (chars + size > maxChars) { budgetOmitted += 1; continue; }
      bundles.push(bundle);
      chars += size;
    }
    const unavailable = Object.values(availability).some(row => row.status === 'unavailable');
    return {
      scope, query,
      status: unavailable ? 'degraded' : budgetOmitted > 0 ? 'budget_limited' : bundles.length ? 'ready' : 'no_matches',
      channels: availability,
      retrieval_complete: Object.values(availability).every(row => ['ready', 'not_needed'].includes(row.status)),
      relationship_context_complete: budgetOmitted === 0 && bundles.every(row => row.relationship_context_complete),
      budget_omitted: budgetOmitted,
      candidate_count: ranked.length,
      bundles,
      authority: 'Evidence and attributed records; not execution permission or a guarantee of current state.',
    };
  }

  async bundle(scope, seed, query, maxNodes, maxHops) {
    authorize(this.config, scope);
    const records = new Map();
    const relations = new Map();
    const gaps = new Set();
    let source = null;
    const addRecord = record => {
      if (!record) { gaps.add('record_unavailable'); return; }
      if (records.has(record.id)) return;
      if (records.size >= maxNodes) { gaps.add('node_limit'); return; }
      records.set(record.id, record);
    };
    if (seed.kind === 'turn') {
      const turn = await this.store.getTurn(scope, seed.id);
      requireThat(turn, 'source_unavailable');
      source = sourceView(turn, seed.matches ?? [], query);
      const linked = await this.store.recordsForTurn(scope, seed.id, maxNodes + 1);
      for (const record of linked) addRecord(record);
    } else addRecord(await this.store.getRecord(scope, seed.id));
    let frontier = [...records.keys()];
    const visited = new Set();
    for (let hop = 0; hop <= maxHops && frontier.length; hop++) {
      const edges = await this.store.neighbors(scope, frontier, maxNodes * 4 + 1);
      if (edges.length > maxNodes * 4) gaps.add('edge_limit');
      for (const id of frontier) visited.add(id);
      const next = new Set();
      for (const edge of edges.slice(0, maxNodes * 4)) {
        if (!relations.has(edge.id) && relations.size >= maxNodes * 4) { gaps.add('edge_limit'); continue; }
        const newEndpoints = [edge.from, edge.to].filter(id => !records.has(id));
        if (newEndpoints.length && hop === maxHops) { gaps.add('hop_limit'); continue; }
        if (records.size + newEndpoints.length > maxNodes) { gaps.add('node_limit'); continue; }
        for (const id of newEndpoints) addRecord(await this.store.getRecord(scope, id));
        if (!records.has(edge.from) || !records.has(edge.to)) continue;
        relations.set(edge.id, edge);
        for (const id of [edge.from, edge.to]) if (!visited.has(id)) next.add(id);
      }
      frontier = [...next];
    }
    const withEvidence = [];
    for (const record of records.values()) {
      withEvidence.push({ ...record, supporting_evidence: await this.evidence(scope, record.evidence) });
    }
    const edges = [];
    for (const relation of relations.values()) {
      edges.push({ ...relation, supporting_evidence: await this.evidence(scope, relation.evidence) });
    }
    return {
      match: { kind: seed.kind, id: seed.id, rank_score: seed.score, channels: seed.channels,
        ...(seed.rerank_score === undefined ? {} : { rerank_score: seed.rerank_score }) },
      source, records: withEvidence, relations: edges,
      relationship_context_complete: gaps.size === 0, gaps: [...gaps],
    };
  }
}

function sourceView(turn, matches, query) {
  const spans = [];
  const seen = new Set();
  const add = span => {
    const key = `${span.entry_id}:${span.start}:${span.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = turn.entries.find(row => row.id === span.entry_id);
    if (!entry || span.end > entry.text.length) return;
    spans.push({ ...span, role: entry.role, text: entry.text.slice(span.start, span.end) });
  };
  for (const span of matches.slice(0, 8)) add(span);
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const entry of turn.entries) {
    if (spans.length >= 8) break;
    const lower = entry.text.toLocaleLowerCase();
    const offsets = terms.map(term => lower.indexOf(term)).filter(at => at >= 0);
    if (!offsets.length && (matches.length || spans.length)) continue;
    let start = Math.max(0, (offsets.length ? Math.min(...offsets) : 0) - 200);
    let end = Math.min(entry.text.length, start + 1600);
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(entry.text[start])) start--;
    if (end < entry.text.length && /[\uDC00-\uDFFF]/u.test(entry.text[end])) end++;
    if (end > start) add({ turn: turn.id, entry_id: entry.id, start, end });
  }
  return { id: turn.id, source: turn.source, conversation_id: turn.conversation_id, turn_id: turn.turn_id,
    parent_turn_id: turn.parent_turn_id, occurred_at: turn.occurred_at,
    excerpts: spans, full_turn_available_via_show: true,
    excerpted: turn.entries.some(entry => !spans.some(span => span.entry_id === entry.id && span.start === 0 && span.end === entry.text.length)) };
}

export function safeCode(error) {
  return error instanceof MemoryError ? error.code : 'database_unavailable';
}
