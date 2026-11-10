import {
  authorize, authorizeSelection, authorizeTarget, chunkEntries, farEndpoint, granted, cosine, fuse, fuseGroups, identity, isNested, isScopeSet, scopePath, SCOPE_SET_MAX, integer, markStage, MemoryError,
  digest, normalizeEnrichment, normalizeTurn, RECORD_CONTRACT, RECORD_KINDS, RECORD_STATUSES, requireThat, sourceExcerpt, text,
} from './core.mjs';
import { POOL_MAX_CHARS, isPoolRequest } from './envelope.mjs';
import { embed, embeddingIdentity, rerank } from './models.mjs';
import { passthrough, scoped, tracer } from './phase-diagnostic.mjs';
import { Neo4jStore, recordDigest, selection, TREE_SCAN_LIMIT } from './store.mjs';

const MODE_CONTRACTS = {
  evidence_advice: 'Evidence advice: prioritizes extracted claims that cite user spans; a cited user span may be a question, so this is not user assertion or authority. May return no relevant history. Omitted material may correct shown claims. Disclosures describe retrieval and selection bounds, not detected corrections. No currentness or completeness guarantee.',
  history_search: 'History search: retained conversations in search rank order. Not an answer to what is current. Omitted or later material may correct shown items. Disclosures describe retrieval and selection bounds, not detected corrections. No currentness or completeness guarantee.',
};

// Retained turn/record identities are immutable. Reuse only successful reads inside one grouped request.
async function immutableRead(reads, scope, kind, id, load) {
  if (!reads) return load();
  const key = JSON.stringify([scope, kind, id]);
  if (reads.has(key)) return structuredClone(reads.get(key));
  const value = await load();
  if (!value) return value;
  const snapshot = structuredClone(value);
  reads.set(key, snapshot);
  return structuredClone(snapshot);
}

export class Memory {
  constructor(config, store = null) {
    this.config = config;
    this.store = store ?? new Neo4jStore(config.neo4j);
    // Largest tree selection scored by exact scan rather than its root's ANN index; tests lower it.
    this.treeScanLimit = TREE_SCAN_LIMIT;
  }

  async close() { await this.store.close(); }

  // A subtree selector prepares the shared tree and labels the subtree's older nodes, so it needs a write grant on the subtree.
  async init(scope) {
    const target = authorizeTarget(this.config, scope, 'write');
    const dimensions = this.config.embedding ? integer(this.config.embedding.dimensions, undefined, 1, 4096) : null;
    return this.store.init(target, dimensions);
  }

  async ingest(scope, input) {
    const { turn, chunks } = beforeWrite(() => {
      authorize(this.config, scope, 'write');
      const turn = normalizeTurn(input);
      const size = integer(this.config.chunking?.words, 256, 8, 4096);
      const overlap = integer(this.config.chunking?.overlap, Math.min(32, size - 1), 0, size - 1);
      return { turn, chunks: chunkEntries(turn, size, overlap) };
    });
    const result = await this.store.ingest(scope, turn, chunks);
    return { ...result, indexing: await this.indexAfterWrite(scope) };
  }

  /**
   * A relation may name its earlier record in another scope as `to: {scope, id, expected_digest?}`. It is still written to
   * this scope only, and needs read on the far scope, checked here against the same configuration before any storage call,
   * so a writer without it learns nothing about the far scope. The far record's existence, kind and digest are checked in
   * the write transaction.
   */
  async enrich(scope, input) {
    const { payload, expected } = beforeWrite(() => {
      authorize(this.config, scope, 'write');
      const payload = normalizeEnrichment(input);
      const expected = {};
      for (const [index, edge] of payload.relations.entries()) {
        if (edge.to_scope === undefined) continue;
        requireThat(edge.to_scope !== scope, 'invalid_relation');
        requireThat(granted(this.config, edge.to_scope, 'read'), 'cross_scope_denied');
        const precondition = farEndpoint(input.relations[index].to).expected_digest;
        if (precondition !== undefined) expected[edge.id] = precondition;
      }
      return { payload, expected };
    });
    const result = await this.store.enrich(scope, payload, ...(Object.keys(expected).length ? [{ expected }] : []));
    return { ...result, indexing: await this.indexAfterWrite(scope) };
  }

  // Runs after the write committed, so it reports every failure in `indexing` and never throws: a throw here would make a
  // committed write look unwritten. The write already authorized this scope against the same configuration.
  // Callers on a latency-sensitive path set index_on_write:false and run `index` separately.
  async indexAfterWrite(scope) {
    try {
      if (this.config.embedding && this.config.index_on_write === false) return { status: 'deferred', indexed: 0 };
      return await this.#indexPending(scope);
    } catch (error) {
      return { status: 'unavailable', reason: safeCode(error), source_retained: true };
    }
  }

  async index(scope, input = {}) {
    authorize(this.config, scope, 'write');
    return this.#indexPending(scope, input);
  }

  async #indexPending(scope, input = {}) {
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

  // `{capabilities: true}` adds the optional features this build supports; without it the reply is unchanged.
  async status(scope, input = {}) {
    const target = authorizeTarget(this.config, scope);
    const key = embeddingIdentity(this.config.embedding);
    const dimensions = this.config.embedding?.dimensions ?? null;
    const catalog = await vectorCatalog(this.store, target, dimensions);
    const errors = Object.fromEntries(catalog.filter(entry => entry.reason).map(entry => [entry.kind, entry.reason]));
    const tree = !selection(target).tree ? {} : { scope_tree: { pending: await this.store.treePending(target), indexes: await this.store.treeIndexStates(target) },
      ...(await this.store.legacyFlatIndex(target) ? { legacy_flat_index: true } : {}) };
    return { scope, ...(await this.store.status(target, key)), ...tree,
      // A changed database_id is another store, a changed record_contract another record contract: each needs a new binding.
      store: await this.storeIdentity(),
      embedding: key ? { configured: true, model: this.config.embedding.model, key } : { configured: false },
      reranker: { configured: Boolean(this.config.reranker) },
      vector_indexes: Object.fromEntries(catalog.map(entry => [entry.kind, entry.vector_index])),
      ...(Object.keys(errors).length ? { vector_index_errors: errors } : {}),
      ...(input?.capabilities === true ? { capabilities: { ...CAPABILITIES, link_uid_lock: await this.store.linkUidLock() } } : {}) };
  }

  // A record digest is meaningful only for this store and record contract, so an opted-in read names both.
  async storeIdentity() {
    return { ...(await this.store.identity()), record_contract: RECORD_CONTRACT };
  }

  async sourceChunks(scope, turn) {
    authorize(this.config, scope);
    text(turn, 256);
    return this.store.sourceChunks(scope, turn);
  }

  async turnVectorStatus(scope, turn) {
    authorize(this.config, scope);
    text(turn, 256);
    const key = embeddingIdentity(this.config.embedding);
    requireThat(key, 'embedding_unconfigured');
    return { visible: await this.store.turnVectorsVisible(scope, key, turn) };
  }

  // Record IDs are content-addressed, so presence after the writing process ended settles an unknown write outcome.
  async recordPresence(scope, ids) {
    authorize(this.config, scope);
    requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= 64 && new Set(ids).size === ids.length, 'invalid_input');
    ids.forEach(id => text(id, 512));
    const found = new Set((await this.store.getRecords(scope, ids)).filter(row => row?.scope === scope).map(row => row.id));
    return { present: ids.filter(id => found.has(id)), absent: ids.filter(id => !found.has(id)) };
  }

  async recordVectorStatus(scope, ids) {
    authorize(this.config, scope);
    requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= 16 && new Set(ids).size === ids.length, 'invalid_input');
    ids.forEach(id => text(id, 256));
    const key = embeddingIdentity(this.config.embedding);
    requireThat(key, 'embedding_unconfigured');
    return { visible: await this.store.recordVectorsVisible(scope, key, ids) };
  }

  // `bundle`, `units` and `following` also read a set of exact scopes; every other kind takes one exact scope.
  async show(scope, input) {
    // Any array, even of one element, is a set, and only these kinds read one.
    if (Array.isArray(scope)) requireThat(SET_SHOW_KINDS.includes(input?.kind), 'scope_denied');
    const target = Array.isArray(scope) ? authorizeSelection(this.config, scope) : authorize(this.config, scope);
    if (Array.isArray(scope) && !isScopeSet(target)) return this.show(target, input);
    const digests = digestsOption(input);
    const reply = await this.showKind(target, input, digests);
    return digests ? { ...reply, store_identity: await this.storeIdentity() } : reply;
  }

  async showKind(scope, input, digests = false) {
    if (isScopeSet(scope)) requireThat(SET_SHOW_KINDS.includes(input.kind), 'scope_denied');
    else authorize(this.config, scope);
    if (input.kind === 'bundle') return this.showBundle(scope, input);
    if (input.kind === 'units') return this.showUnits(scope, input);
    if (input.kind === 'following') return this.showFollowing(scope, input);
    if (input.kind === 'turn_by_key') return this.showTurnByKey(scope, input);
    const id = text(input.id, 256);
    requireThat(['turn', 'record'].includes(input.kind), 'invalid_kind');
    if (input.kind === 'turn') {
      const turn = await this.store.getTurn(scope, id);
      requireThat(turn, 'not_found');
      return { kind: 'turn', turn };
    }
    const record = await this.store.getRecord(scope, id, ...digestArgs(digests));
    requireThat(record, 'not_found');
    return { kind: 'record', record, evidence: await this.evidence(scope, record.evidence) };
  }

  /**
   * Exact enumeration of turns and records over one scope or a subtree, newest first by write time, keyset-paged: one
   * filtered store query per page. A full walk returns every item committed before its first page exactly once. Turns are
   * bounded headers; an item too large for `max_bytes` by itself is named by a stub and the walk moves past it. With
   * `relations: true` the reply also carries the relations touching the page's records, from one more query, bounded and
   * never silently cut; the items and cursor are the ones the same request without it returns.
   */
  async list(scope, input = {}) {
    const target = authorizeSelection(this.config, scope);
    if (Array.isArray(scope) && !isScopeSet(target)) return this.list(target, input);
    // A set binds its cursor to the canonical array, which never canonicalizes like one scope's string.
    const named = isScopeSet(target) ? target.scopes : scope;
    requireThat(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).every(key => LIST_KEYS.includes(key)), 'invalid_input');
    const kind = input.kind === undefined ? null : text(input.kind, 32);
    requireThat(kind === null || kind === 'turn' || RECORD_KINDS.includes(kind), 'invalid_kind');
    const status = input.status === undefined ? null : text(input.status, 32);
    requireThat(status === null || RECORD_STATUSES.includes(status), 'invalid_status');
    requireThat(status === null || kind !== 'turn', 'invalid_input');
    requireThat(input.relations === undefined || typeof input.relations === 'boolean', 'invalid_input');
    const withRelations = input.relations === true;
    requireThat(!withRelations || kind !== 'turn', 'invalid_input');
    const digests = digestsOption(input);
    const source = input.source === undefined ? null : text(input.source, 256);
    const conversation = input.conversation_id === undefined ? null : text(input.conversation_id, 256);
    const limit = integer(input.limit, 16, 1, 64);
    const maxBytes = integer(input.max_bytes, 65536, 4096, 1_000_000);
    const binding = digest(['source-memory.list/1', named, kind, status, source, conversation]).slice(0, 32);
    const after = input.cursor === undefined ? null : decodeCursor(input.cursor, binding);
    // A status filter names a record field, so it selects records only.
    const rows = await this.store.listPage(target, { turns: kind === 'turn' || (kind === null && status === null), records: kind !== 'turn',
      kind: kind === 'turn' ? null : kind, status, source, conversation, after, limit, ...(digests ? { digests } : {}) });
    const items = [];
    const uids = [];
    let bytes = 2;
    let last = null;
    let full = rows.length === limit;
    for (const row of rows) {
      const item = listItem(row, digests);
      const size = Buffer.byteLength(JSON.stringify(item));
      const added = size + (items.length ? 1 : 0);
      if (bytes + added > maxBytes) {
        if (items.length) {
          full = true;
          break;
        }
        items.push({ kind: item.kind, scope: item.scope, id: item.id, stored_at: item.stored_at, bytes: size, content_omitted: 'max_bytes',
          ...(item.record_digest === undefined ? {} : { record_digest: item.record_digest }) });
        bytes += Buffer.byteLength(JSON.stringify(items[0]));
      } else {
        items.push(item);
        bytes += added;
      }
      if (row.type === 'record') uids.push(row.uid);
      last = { at: row.at, uid: row.uid };
    }
    const page = listPage(named, items, full ? last : null, binding);
    const reply = withRelations ? { ...page, ...await pageRelations(this.store, target, uids) } : page;
    return digests ? { ...reply, store_identity: await this.storeIdentity() } : reply;
  }

  // Which of a caller's candidate keys already names a stored turn. More than one is reported, never resolved here.
  async showTurnByKey(scope, input) {
    authorize(this.config, scope);
    const source = text(input.source, 256);
    const conversation = text(input.conversation_id, 256);
    requireThat(Array.isArray(input.turn_ids) && input.turn_ids.length > 0 && input.turn_ids.length <= 16);
    const found = [];
    for (const turnId of new Set(input.turn_ids.map(id => text(id, 256)))) {
      const turn = await this.store.getTurn(scope, identity('turn', scope, source, conversation, turnId));
      if (turn) found.push({ id: turn.id, turn_id: turn.turn_id });
    }
    return { kind: 'turn_by_key', found };
  }

  // Later turns of one conversation, by exact parent links only. Nothing here says a later turn replaces an earlier one.
  // Over a set, `scope` names the element to walk; the walk itself never leaves one scope.
  async showFollowing(target, input) {
    const scope = elementOf(setScopes(this.config, target), target, input.scope);
    const start = await this.store.getTurn(scope, text(input.turn, 256));
    requireThat(start, 'not_found');
    const limit = integer(input.limit, 2, 1, 16);
    const { turns, end, unlinked } = await this.walkFollowing(scope, start, limit);
    return {
      // recorded_end is the last turn this store holds, not proof that the conversation ended there.
      kind: 'following', turn: start.id, turns, has_more: end === 'limit', end,
      lineage: end === 'branched' || end === 'cycle' ? end : unlinked ? 'unknown' : 'linked',
      unlinked_turns: unlinked,
    };
  }

  async walkFollowing(scope, start, limit, maxBytes = null) {
    authorize(this.config, scope);
    integer(limit, undefined, 1, 16);
    if (maxBytes !== null) integer(maxBytes, undefined, 1, 65536);
    const turns = [];
    const seen = new Set([start.id]);
    let current = start;
    let end = 'recorded_end';
    let bound = null;
    let bytes = 0;
    while (true) {
      const children = await this.store.childTurns(scope, current, 2);
      if (children.length === 0) break;
      if (children.length > 1) { end = 'branched'; break; }
      const [child] = children;
      if (seen.has(child.id)) { end = 'cycle'; break; }
      seen.add(child.id);
      if (turns.length === limit) { end = 'limit'; bound = 'turns'; break; }
      const size = maxBytes === null ? 0 : Buffer.byteLength(JSON.stringify(followingTurn(child)));
      if (maxBytes !== null && bytes + size > maxBytes) { end = 'limit'; bound = 'bytes'; break; }
      turns.push(child);
      bytes += size;
      current = child;
    }
    const unlinked = await this.store.unlinkedTurns(scope, start);
    return { turns, end, bound, unlinked };
  }

  // Each root is walked in the scope of the span that names it (its record's, or the bundle's), not in the unit's: lineage
  // never crosses scopes. An entry names its scope only when that differs from the unit's.
  async followingForBundles(scope, seeds, follow, cache, reads = null) {
    authorize(this.config, scope);
    const roots = new Map();
    const add = (owner, turn) => { if (turn) roots.set(JSON.stringify([turn, owner]), { owner, turn }); };
    for (const bundle of seeds) {
      const home = bundle.scope ?? scope;
      add(home, bundle.source?.id);
      for (const row of [...bundle.records, ...bundle.relations]) for (const span of row.supporting_evidence) add(span.scope ?? row.scope ?? home, span.turn);
    }
    const following = [];
    const byTurn = (a, b) => a.turn < b.turn ? -1 : a.turn > b.turn ? 1 : a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0;
    for (const { owner, turn: after } of [...roots.values()].sort(byTurn)) {
      const key = JSON.stringify([after, owner]);
      authorize(this.config, owner);
      if (!cache.has(key)) cache.set(key, (async () => {
        const start = await immutableRead(reads, owner, 'turn', after, () => this.store.getTurn(owner, after));
        requireThat(start, 'source_unavailable');
        const read = await this.walkFollowing(owner, start, follow.turns, follow.bytes);
        return { after, status: read.end === 'limit' ? 'has_more' : ['branched', 'cycle'].includes(read.end)
          ? read.end : read.unlinked ? 'unknown' : 'recorded_end',
          bound: read.bound, turns: read.turns.map(followingTurn), unlinked_turns: read.unlinked };
      })());
      const entry = await cache.get(key);
      following.push(owner === scope ? entry : { ...entry, scope: owner });
    }
    return following;
  }

  // Over a set, each unit key names its element, and each unit is bundled and followed in that scope.
  async showUnits(scope, input) {
    const scopes = setScopes(this.config, scope);
    const follow = followingOptions(input.follow, true);
    const maxNodes = integer(input.max_nodes, 48, 1, 256);
    const maxHops = integer(input.max_hops, 4, 0, 12);
    const digests = digestsOption(input);
    requireThat(Array.isArray(input.units) && input.units.length <= 4);
    const requests = input.units.map(unit => {
      requireThat(unit && unit.key && Array.isArray(unit.seeds) && unit.seeds.length <= 20);
      const key = { scope: text(unit.key.scope, 256), source: text(unit.key.source, 256), conversation_id: text(unit.key.conversation_id, 256) };
      requireThat(scopes ? scopes.includes(key.scope) : key.scope === scope, 'scope_denied');
      const seeds = unit.seeds.map(seed => {
        requireThat(seed && ['turn', 'record'].includes(seed.kind), 'invalid_kind');
        return { kind: seed.kind, id: text(seed.id, 256) };
      });
      return { key, seeds };
    });
    const cache = new Map();
    const units = [];
    for (const request of requests) {
      const home = request.key.scope;
      const seeds = [];
      const missing = [];
      for (const seed of request.seeds) {
        const found = seed.kind === 'turn' ? await this.store.getTurn(home, seed.id) : await this.store.getRecord(home, seed.id);
        if (!found) { missing.push(seed); continue; }
        seeds.push(await this.bundle(home, { ...seed, ...(scopes ? { scope: home } : {}), score: null, channels: [] }, '', maxNodes, maxHops,
          ...(scopes ? [null, passthrough, digests, { scopes }] : bundleFlags(digests))));
      }
      units.push({ key: request.key, seeds, missing,
        ...(follow ? { following: await this.followingForBundles(home, seeds, follow, cache) } : {}) });
    }
    return { kind: 'units', units };
  }

  // Rebuilds one seed's relationship-closed bundle without a query, so a caller can detect changes since it last read it.
  // Over a set, the seed names its element as `scope`.
  async showBundle(target, input) {
    const scopes = setScopes(this.config, target);
    const seed = input.seed;
    requireThat(seed && ['turn', 'record'].includes(seed.kind), 'invalid_kind');
    const id = text(seed.id, 256);
    const scope = elementOf(scopes, target, seed.scope);
    const maxNodes = integer(input.max_nodes, 48, 1, 256);
    const maxHops = integer(input.max_hops, 4, 0, 12);
    const digests = digestsOption(input);
    if (seed.kind === 'turn') requireThat(await this.store.getTurn(scope, id), 'not_found');
    else requireThat(await this.store.getRecord(scope, id), 'not_found');
    const bundle = await this.bundle(scope, { kind: seed.kind, id, ...(scopes ? { scope } : {}), score: null, channels: [] }, '', maxNodes, maxHops,
      ...(scopes ? [null, passthrough, digests, { scopes }] : bundleFlags(digests)));
    return { kind: 'bundle', bundle };
  }

  async evidence(scope, spans, reads = null) {
    authorize(this.config, scope);
    const turns = new Map();
    const result = [];
    for (const span of spans) {
      if (!turns.has(span.turn)) turns.set(span.turn, await immutableRead(reads, scope, 'turn', span.turn, () => this.store.getTurn(scope, span.turn)));
      const turn = turns.get(span.turn);
      requireThat(turn, 'evidence_unavailable');
      result.push({ ...sourceExcerpt(turn, span), source: turn.source,
        conversation_id: turn.conversation_id, turn_id: turn.turn_id });
    }
    return result;
  }

  // `phases` is an opt-in marker sink (src/phase-diagnostic.mjs). Absent, recall makes exactly the calls it always made.
  async recall(scope, input, { phases = null, seedsOnly = false } = {}) {
    const target = authorizeSelection(this.config, scope);
    if (isScopeSet(target)) return this.recallSet(target.scopes, input, { phases, seedsOnly });
    // A one-element set is that exact scope: the same request, so the same reply.
    if (Array.isArray(scope)) return this.recall(target, input, { phases, seedsOnly });
    const tree = selection(target).tree;
    const trace = tracer(phases);
    const options = recallOptions(this.config, input);
    const { channels, availability, omitted } = await this.retrieve(target, options, trace, queryEmbedder(this.config, options.query));
    // Nodes of the selection that the tree indexes cannot see yet make every channel over that kind partial.
    const pending = tree ? await this.store.treePending(target) : null;
    if (pending) markPending(availability, pending);
    const { grouped, candidates, digests } = options;
    const ranked = await this.rerankSeeds(grouped ? fuse(channels) : fuse(channels).slice(0, candidates), options.query, availability);

    if (seedsOnly) {
      requireThat(!grouped, 'invalid_input');
      return { scope, ranked, candidate_limit: candidates, channels: Object.fromEntries(Object.entries(availability).map(([name, state]) =>
        [name, { ...state, ...(channels[name] ? { candidate_limit_reached: channels[name].length >= candidates } : {}) }])),
        ...(pending ? { scope_tree: { pending } } : {}),
        ...(digests ? { store_identity: await this.storeIdentity() } : {}) };
    }

    const { bundles, budgetOmitted, groupedOutput } = await this.renderSeeds(scope, ranked, channels, omitted, options, trace,
      typeof target === 'string' ? null : target);
    const unavailable = Object.values(availability).some(row => row.status === 'unavailable');
    return {
      scope, query: options.query,
      status: unavailable ? 'degraded' : budgetOmitted > 0 ? 'budget_limited' : bundles.length ? 'ready' : 'no_matches',
      channels: Object.fromEntries(Object.entries(availability).sort(([a], [b]) => a.localeCompare(b))),
      retrieval_complete: Object.values(availability).every(row => ['ready', 'not_needed'].includes(row.status)),
      relationship_context_complete: budgetOmitted === 0 && bundles.every(row => row.relationship_context_complete),
      budget_omitted: budgetOmitted,
      candidate_count: ranked.length,
      excluded_conversations: options.exclude.length,
      bundles,
      authority: AUTHORITY,
      ...groupedOutput,
      ...(options.mode === undefined ? {} : { mode: options.mode, mode_contract: MODE_CONTRACTS[options.mode] }),
      ...(pending ? { scope_tree: { pending } } : {}),
      ...(digests ? { store_identity: await this.storeIdentity() } : {}),
    };
  }

  /**
   * Recall over a set of 2–4 exact scopes: each index group (one root's nested elements, or one flat scope) runs exactly the
   * channel logic of an exact read of its elements, with its own status, census, pending and vector budget; ranks are
   * fused per group, and every element reports its own channel states in `by_scope`.
   */
  async recallSet(set, input, { phases = null, seedsOnly = false } = {}) {
    const scopes = setScopes(this.config, { scopes: set });
    const trace = tracer(phases);
    const options = recallOptions(this.config, input);
    const { grouped, candidates, digests } = options;
    const groups = indexGroups(scopes);
    const embedQuery = queryEmbedder(this.config, options.query);
    const results = await Promise.all(groups.map(async (group, index) => {
      // Each group is bracketed whole, so a large set does not crowd the render phase out of the bounded marker budget.
      const result = await trace(`group.${index}`, () => this.retrieve(group.target, options, passthrough, embedQuery));
      // A one-element group is read exactly as that scope alone, whose hits do not name it.
      if (typeof group.target === 'string') nameHits(result, group.target);
      const pending = !group.tree ? null : typeof group.target === 'string' ? { [group.target]: await this.store.treePending(group.target) }
        : await this.store.treePendingByScope(group.target);
      return { ...result, pending };
    }));
    const reranker = {};
    const ranked = await this.rerankSeeds(grouped ? fuseGroups(results.map(row => row.channels))
      : fuseGroups(results.map(row => row.channels)).slice(0, candidates), options.query, reranker);
    const byScope = {};
    for (const [index, group] of groups.entries()) {
      for (const scope of group.scopes) {
        const states = { ...results[index].availability };
        const pending = results[index].pending?.[scope];
        if (pending) markPending(states, pending);
        byScope[scope] = { group: group.name, channels: Object.fromEntries(Object.keys(CHANNEL_KINDS).sort().map(name => [name, { ...states[name],
          ...(seedsOnly ? { candidate_limit_reached: results[index].channels[name].length >= candidates } : {}) }])),
          ...(pending ? { scope_tree: { pending } } : {}) };
      }
    }
    const ordered = Object.fromEntries(scopes.map(scope => [scope, byScope[scope]]));
    const channels = aggregateChannels(ordered, reranker.reranker);
    const elementStates = [...Object.values(ordered).flatMap(row => Object.values(row.channels)), reranker.reranker];

    if (seedsOnly) {
      requireThat(!grouped, 'invalid_input');
      return { scopes, ranked, candidate_limit: candidates, channels, by_scope: ordered,
        ...(digests ? { store_identity: await this.storeIdentity() } : {}) };
    }

    const merged = Object.fromEntries(Object.keys(CHANNEL_KINDS).map(name => [name, results.flatMap(row => row.channels[name])]));
    const { bundles, budgetOmitted, groupedOutput } = await this.renderSeeds(scopes, ranked, merged, results.flatMap(row => row.omitted),
      options, trace, { scopes });
    const unavailable = elementStates.some(row => row.status === 'unavailable');
    return {
      scopes, query: options.query,
      status: unavailable ? 'degraded' : budgetOmitted > 0 ? 'budget_limited' : bundles.length ? 'ready' : 'no_matches',
      channels,
      retrieval_complete: elementStates.every(row => ['ready', 'not_needed'].includes(row.status)),
      relationship_context_complete: budgetOmitted === 0 && bundles.every(row => row.relationship_context_complete),
      budget_omitted: budgetOmitted,
      candidate_count: ranked.length,
      excluded_conversations: options.exclude.length,
      bundles,
      authority: AUTHORITY,
      ...groupedOutput,
      ...(options.mode === undefined ? {} : { mode: options.mode, mode_contract: MODE_CONTRACTS[options.mode] }),
      by_scope: ordered,
      ...(digests ? { store_identity: await this.storeIdentity() } : {}),
    };
  }

  /**
   * The five retrieval channels over one exact scope, one subtree or one set group: their hits, states and admission
   * omissions. Nothing here reads beyond the target; `embedQuery` embeds the query once per request.
   */
  async retrieve(target, options, trace, embedQuery) {
    authorizeRead(this.config, target);
    const sel = selection(target);
    const tree = sel.tree;
    // Only the grouped admission query has finer steps worth bracketing; it takes the trace as an extra trailing argument.
    const traced = trace === passthrough ? [] : [trace];
    const { grouped, perConversation, query, candidates, vectorLimit, exclude, digests } = options;
    const availability = {};
    const channels = {};
    const omitted = [];
    await Promise.all(['turn', 'record', 'chunk'].map(kind => trace(`lexical.${kind}`, async () => {
      const name = `${kind}_lexical`;
      try {
        if (grouped) {
          const state = await trace(`lexical.${kind}.status`, () => this.store.lexicalStatus(target, kind));
          if (state.status !== 'ready') {
            channels[name] = [];
            availability[name] = state;
            return;
          }
          const result = await trace(`lexical.${kind}.query`, () => this.store.admittedLexical(target, kind, query, candidates, perConversation, exclude, ...traced));
          channels[name] = result.hits;
          omitted.push(...result.omitted);
          availability[name] = { ...state, admitted_conversations: result.admitted_conversations, exhausted: result.exhausted };
        } else {
          // A flat scope checks only its chunk index, as it always has; the shared tree indexes are checked for every kind.
          const state = kind === 'chunk' ? await trace('lexical.chunk.status', () => this.store.chunkLexicalStatus(target))
            : tree ? await this.store.lexicalStatus(target, kind) : { status: 'ready' };
          channels[name] = state.status !== 'ready' ? [] : await trace(`lexical.${kind}.query`, () => kind === 'chunk'
            ? this.store.chunkLexical(target, query, candidates, exclude)
            : this.store.lexical(target, kind, query, candidates, exclude, ...digestArgs(digests && kind === 'record')));
          availability[name] = state;
        }
      } catch (error) {
        channels[name] = [];
        availability[name] = { status: 'unavailable', reason: safeCode(error) };
      }
    })));
    channels.chunk_vector = [];
    channels.record_vector = [];
    if (this.config.embedding) {
      try {
        const key = embeddingIdentity(this.config.embedding);
        const [queryVector] = await embedQuery();
        const catalog = await vectorCatalog(this.store, target, queryVector.length);
        const missing = catalog.filter(entry => entry.vector_index === 'missing');
        const prepareFallback = async kind => {
          const vectors = await this.store.vectors(target, key, vectorLimit + 1, exclude, kind);
          const selected = vectors.slice(0, vectorLimit);
          return { scanned: selected.map(row => row.uid), scan_truncated: vectors.length > vectorLimit,
            ranked: grouped ? [] : selected.map(row => ({ ...row, similarity: cosine(queryVector, row.embedding) }))
              .filter(row => Number.isFinite(row.similarity)).sort((a, b) => b.similarity - a.similarity || a.uid.localeCompare(b.uid)) };
        };
        let sharedFallback;
        const budget = { remaining: 14 };
        const results = await Promise.all(catalog.map(async ({ kind, vector_index, reason }) => {
          if (reason) return { hits: [], omitted: [], state: { status: 'unavailable', reason } };
          if (vector_index === 'populating') return { hits: [], omitted: [], state: { status: 'partial', reason: 'vector_index_populating' } };
          if (vector_index === 'failed') return { hits: [], omitted: [], state: { status: 'unavailable', reason: 'vector_index_failed' } };
          try {
            let result;
            let unindexed;
            let scan_truncated = false;
            // A root's ANN index is filtered after its top-k, so a small selection is scored exactly, inside the database.
            const census = tree && vector_index === 'online' ? await this.store.vectorCounts(target, kind, key, exclude) : null;
            if (census && census.total <= Math.min(this.treeScanLimit, vectorLimit)) {
              const scan = await this.store.treeVectorScan(target, kind, key, queryVector, grouped ? 0 : candidates, exclude,
                ...digestArgs(digests && kind === 'record'));
              unindexed = census.unindexed;
              result = grouped ? await this.store.admittedVectors(target, kind, key, queryVector, scan.uids, candidates, perConversation, exclude)
                : { hits: vectorHits(kind, scan.nodes, sel.named, digests) };
            } else if (vector_index === 'online') {
              result = await this.store.indexedVectors(target, kind, key, queryVector, candidates, grouped ? perConversation : null, exclude, budget,
                ...(census ? [census] : []));
              unindexed = result.unindexed;
              if (!grouped) result.hits = vectorHits(kind, result.nodes, sel.named, digests);
            } else {
              // Share only a truly combined missing-index scan. One kind's failure never blocks an online sibling.
              const fallback = missing.length === 2 ? sharedFallback ??= prepareFallback(null) : prepareFallback(kind);
              const [data, counts] = await Promise.all([fallback, this.store.vectorCounts(target, kind, key, exclude)]);
              unindexed = counts.unindexed;
              scan_truncated = data.scan_truncated;
              result = grouped ? await this.store.admittedVectors(target, kind, key, queryVector, data.scanned, candidates, perConversation, exclude)
                : { hits: vectorHits(kind, data.ranked.filter(row => kind === 'chunk' ? row.turn_uid : row.record_id).slice(0, candidates), sel.named, digests) };
            }
            const state = { status: result.partial || scan_truncated || unindexed > 0 ? 'partial' : 'ready',
              scan_truncated, unindexed, embedding_key: key,
              ...(result.reason ? { reason: result.reason } : {}),
              ...(grouped && result.ran !== false ? { admitted_conversations: result.admitted_conversations, exhausted: result.exhausted } : {}) };
            return { hits: result.hits, omitted: result.omitted ?? [], state };
          } catch (error) {
            return { hits: [], omitted: [], state: { status: 'unavailable', reason: safeCode(error) } };
          }
        }));
        for (const [index, kind] of ['chunk', 'record'].entries()) {
          channels[`${kind}_vector`] = results[index].hits;
          omitted.push(...results[index].omitted);
          availability[`${kind}_vector`] = results[index].state;
        }
      } catch (error) {
        availability.chunk_vector = { status: 'unavailable', reason: safeCode(error) };
        availability.record_vector = { ...availability.chunk_vector };
      }
    } else {
      availability.chunk_vector = { status: 'unconfigured' };
      availability.record_vector = { status: 'unconfigured' };
    }
    return { channels, availability, omitted };
  }

  // One rerank call over the fused list; its state is written to `availability.reranker`.
  async rerankSeeds(ranked, query, availability) {
    if (this.config.reranker && ranked.length) {
      try {
        // This cut affects ranking only. Evidence is read independently from the retained source.
        const cut = ranked.some(item => item.text.length > 16000);
        const reordered = await rerank(this.config.reranker, query, ranked.map(item => ({ ...item, text: item.text.slice(0, 16000) })));
        availability.reranker = { status: 'ready', ranking_text_truncated: cut };
        return reordered;
      } catch (error) { availability.reranker = { status: 'unavailable', reason: safeCode(error) }; }
    } else availability.reranker = { status: this.config.reranker ? 'not_needed' : 'unconfigured' };
    return ranked;
  }

  // Bundles of the ranked seeds within the byte budget, or grouped conversation units. A seed without a scope is in `scope`.
  // `selection` is the subtree or set the read covers, for following relations across it; null for one exact scope.
  async renderSeeds(scope, ranked, channels, omitted, options, trace, selection = null) {
    const { query, limit, maxChars, maxNodes, maxHops, follow, digests } = options;
    if (options.grouped) {
      const result = await this.conversationUnits(scope, ranked, channels, omitted, query, limit, maxChars, maxNodes, maxHops, follow, trace,
        ...(selection ? [digests, selection] : flag(digests)));
      return { bundles: result.units.flatMap(unit => unit.seeds), budgetOmitted: result.budget_omitted,
        groupedOutput: { units: result.units, pool_truncated: result.pool_truncated, budget_unit: 'utf8_bytes' } };
    }
    const bundles = [];
    let chars = 0;
    let budgetOmitted = 0;
    for (const [index, seed] of ranked.slice(0, limit).entries()) {
      const label = `bundle.${index}`;
      const bundle = await trace(label, () => this.bundle(seed.scope ?? scope, seed, query, maxNodes, maxHops, null, scoped(trace, label),
        ...(selection ? [digests, selection] : flag(digests))));
      const size = JSON.stringify(bundle).length;
      if (chars + size > maxChars) { budgetOmitted += 1; continue; }
      bundles.push(bundle);
      chars += size;
    }
    return { bundles, budgetOmitted, groupedOutput: {} };
  }

  // In a subtree read every seed names its own scope, and so does the unit key it is packaged under.
  async conversationUnits(scope, ranked, channels, omitted, query, limit, maxBytes, maxNodes, maxHops, follow = null, trace = passthrough,
    digests = false, selection = null) {
    authorizeSelection(this.config, scope);
    const reads = new Map();
    const priority = new Map();
    for (const [rank, seed] of ranked.entries()) for (const context of seed.conversations) {
      const token = conversationToken(context.key);
      if (!priority.has(token)) priority.set(token, rank);
    }
    const admitted = new Set(Object.values(channels).flatMap(hits => hits.map(seedToken)));
    const truncated = new Map();
    for (const seed of omitted) {
      if (admitted.has(seedToken(seed))) continue;
      for (const key of seed.keys) {
        const token = conversationToken(key);
        if (!truncated.has(token)) truncated.set(token, new Set());
        truncated.get(token).add(seedToken(seed));
      }
    }
    const pool = new Map();
    for (const seed of ranked) {
      const contexts = [...seed.conversations].sort((a, b) => priority.get(conversationToken(a.key)) - priority.get(conversationToken(b.key))
        || compareConversationKeys(a.key, b.key));
      const owner = contexts[0];
      const token = conversationToken(owner.key);
      if (!pool.has(token)) pool.set(token, { key: owner.key, legacy: false, candidates: [], also: new Map() });
      const unit = pool.get(token);
      unit.legacy ||= owner.legacy === true;
      unit.candidates.push(seed);
      for (const context of contexts.slice(1)) unit.also.set(conversationToken(context.key), context.key);
    }
    const units = [];
    const followingCache = new Map();
    let bytes = 0;
    let budgetOmitted = 0;
    let ordinal = 0;
    for (const unit of [...pool.values()].slice(0, limit)) {
      const seeds = [];
      for (const candidate of unit.candidates) {
        const label = `bundle.${ordinal++}`;
        const bundle = await trace(label, () => this.bundle(candidate.scope ?? scope, candidate, query, maxNodes, maxHops, reads, scoped(trace, label),
          ...(selection ? [digests, selection] : flag(digests))));
        seeds.push(bundle);
        const evidence = [bundle.source, ...[...bundle.records, ...bundle.relations].flatMap(row => row.supporting_evidence)].filter(Boolean);
        for (const span of evidence) {
          // A span names its scope when it is not the bundle's: a far record's evidence is in the far scope.
          const key = { scope: span.scope ?? bundle.scope ?? unit.key.scope, source: span.source, conversation_id: span.conversation_id };
          if (conversationToken(key) !== conversationToken(unit.key)) unit.also.set(conversationToken(key), key);
        }
      }
      const rendered = { key: unit.key, ...(unit.legacy ? { legacy: true } : {}), seeds,
        seeds_truncated: truncated.get(conversationToken(unit.key))?.size ?? 0, also_cites: [...unit.also.values()].sort(compareConversationKeys),
        ...(follow ? { following: await this.followingForBundles(unit.key.scope, seeds, follow, followingCache, reads) } : {}) };
      const size = Buffer.byteLength(JSON.stringify(rendered));
      // Admission limits seeds; rendering budgets may only skip an entire unit, never a seed or part of its evidence.
      if (bytes + size > maxBytes) { budgetOmitted += 1; continue; }
      units.push(rendered);
      bytes += size;
    }
    return { units, pool_truncated: Math.max(0, pool.size - limit), budget_omitted: budgetOmitted };
  }

  // `digests` adds each record's stored digest; the reads cache is per request, so one value of it per cache. `selection`
  // is what the read covers when it is more than this scope (a subtree or a set): relations whose own scope is in it are
  // followed, and a link's far end outside it is an opaque omission (`to: null, to_hidden: true`, gap `cross_scope_hidden`)
  // past which expansion does not continue. A record or span of another scope than the bundle's names its scope.
  async bundle(scope, seed, query, maxNodes, maxHops, reads = null, trace = passthrough, digests = false, selection = null) {
    const options = digestArgs(digests);
    authorize(this.config, scope);
    const wide = selection !== null && selection !== scope;
    if (wide) authorizeSelection(this.config, isScopeSet(selection) ? selection.scopes : selection.subtree ? `${selection.scope}/**` : selection);
    // Records and relations are keyed by (scope, id): an id is unique only within its scope.
    const key = (owner, id) => JSON.stringify([owner, id]);
    const records = new Map();
    const relations = new Map();
    const gaps = new Set();
    let source = null;
    const addRecord = record => {
      if (!record) { gaps.add('record_unavailable'); return; }
      const at = key(record.scope ?? scope, record.id);
      if (records.has(at)) return;
      if (records.size >= maxNodes) { gaps.add('node_limit'); return; }
      records.set(at, record);
    };
    const readRecord = (owner, id) => immutableRead(reads, owner, 'record', id, () => this.store.getRecord(owner, id, ...options));
    if (seed.kind === 'turn') {
      const turn = await immutableRead(reads, scope, 'turn', seed.id, () => this.store.getTurn(scope, seed.id));
      requireThat(turn, 'source_unavailable');
      source = sourceView(turn, seed.matches ?? [], query);
      const linked = await this.store.recordsForTurn(scope, seed.id, maxNodes + 1, ...options);
      for (const record of linked) addRecord(record);
    } else addRecord(await readRecord(scope, seed.id));
    let frontier = [...records.values()];
    const visited = new Set();
    for (let hop = 0; hop <= maxHops && frontier.length; hop++) {
      // A one-scope read keeps its relation query; endpoints of its relations are in this scope, and a link's far end is hidden.
      const rows = wide
        ? await this.store.relationsIn(selection, frontier.map(record => identity('record', record.scope ?? scope, record.id)), maxNodes * 4 + 1)
        : (await this.store.neighbors(scope, frontier.map(record => record.id), maxNodes * 4 + 1))
          .map(edge => ({ edge, scope, to_scope: edge.to_hidden ? null : scope }));
      if (rows.length > maxNodes * 4) gaps.add('edge_limit');
      for (const record of frontier) visited.add(key(record.scope ?? scope, record.id));
      const next = new Map();
      for (const row of rows.slice(0, maxNodes * 4)) {
        const { edge } = row;
        const at = key(row.scope, edge.id);
        if (!relations.has(at) && relations.size >= maxNodes * 4) { gaps.add('edge_limit'); continue; }
        const ends = [[row.scope, edge.from], ...(row.to_scope === null ? [] : [[row.to_scope, edge.to]])];
        const newEndpoints = ends.filter(([owner, id]) => !records.has(key(owner, id)));
        if (newEndpoints.length && hop === maxHops) { gaps.add('hop_limit'); continue; }
        if (records.size + newEndpoints.length > maxNodes) { gaps.add('node_limit'); continue; }
        for (const [owner, id] of newEndpoints) addRecord(await readRecord(owner, id));
        if (!ends.every(([owner, id]) => records.has(key(owner, id)))) continue;
        relations.set(at, row);
        if (row.to_scope === null) gaps.add('cross_scope_hidden');
        for (const [owner, id] of ends) if (!visited.has(key(owner, id))) next.set(key(owner, id), records.get(key(owner, id)));
      }
      frontier = [...next.values()];
    }
    const named = (spans, owner) => owner === scope ? spans : spans.map(span => ({ ...span, scope: owner }));
    const withEvidence = [];
    const edges = [];
    await trace('evidence', async () => {
      for (const record of records.values()) {
        const owner = record.scope ?? scope;
        withEvidence.push({ ...record, supporting_evidence: named(await this.evidence(owner, record.evidence, reads), owner) });
      }
      for (const { edge, scope: owner } of relations.values()) {
        edges.push({ ...edge, ...(owner === scope ? {} : { scope: owner }),
          supporting_evidence: named(await this.evidence(owner, edge.evidence, reads), owner) });
      }
    });
    return {
      match: { kind: seed.kind, id: seed.id, rank_score: seed.score,
        channels: [...seed.channels].sort((a, b) => a.channel.localeCompare(b.channel)),
        ...(seed.rerank_score === undefined ? {} : { rerank_score: seed.rerank_score }) },
      ...(seed.scope === undefined ? {} : { scope: seed.scope }),
      source, records: withEvidence, relations: edges,
      relationship_context_complete: gaps.size === 0, gaps: [...gaps],
    };
  }
}

async function vectorCatalog(store, scope, dimensions) {
  return Promise.all(['chunk', 'record'].map(async kind => {
    try { return { kind, vector_index: await store.vectorIndexStatus(scope, kind, dimensions) }; }
    catch (error) {
      const reason = safeCode(error);
      return { kind, vector_index: reason.startsWith('vector_index_') ? 'incompatible' : 'unavailable', reason };
    }
  }));
}

const vectorHits = (kind, nodes, withScope = false, digests = false) => nodes.map(row => kind === 'chunk' ? {
  kind: 'turn', id: row.turn_uid, text: row.text, ...(withScope ? { scope: row.scope } : {}),
  match: { turn: row.turn_uid, entry_id: row.entry_id, start: row.start, end: row.end },
} : { kind: 'record', id: row.record_id, text: row.text, ...(withScope ? { scope: row.scope } : {}),
  ...(digests ? { record_digest: recordDigest(row) } : {}) });

const LIST_KEYS = ['kind', 'status', 'source', 'conversation_id', 'limit', 'max_bytes', 'cursor', 'relations', 'digests'];

// Optional features a caller can probe with `status {capabilities: true}`; an older build returns no `capabilities`.
// `link_uid_lock` is added per store: whether its smlink_uid constraint exists, without which the relation id lock cannot serialize.
export const CAPABILITIES = Object.freeze({ scope_set_max: SCOPE_SET_MAX, record_digests: true, cross_scope_relations: true });

// `digests: true` adds each record's stored digest and the store identity to a read; absent or false, nothing changes.
function digestsOption(input) {
  requireThat(input.digests === undefined || typeof input.digests === 'boolean', 'invalid_input');
  return input.digests === true;
}

// Store reads take the option only when it is set, so a read without it makes exactly the calls it always made.
const digestArgs = digests => digests ? [{ digests: true }] : [];
// Likewise internal calls take the trailing flag only when set, so their arguments are the ones they always were.
const flag = digests => digests ? [true] : [];
const bundleFlags = digests => digests ? [null, passthrough, true] : [];
// Bounds on the relations one `list` page carries. The byte cap admits any single relation: its largest normalized form,
// 16 evidence spans of maximal ids with every character JSON-escaped, is under 48 KiB.
export const LIST_RELATIONS_MAX = 256;
export const LIST_RELATIONS_MAX_BYTES = 131_072;
// The shape of Neo4j's `toString` of a zoned datetime, with in-range fields. Only a hand-made cursor can still name an
// impossible date (such as February 30) or an unknown zone; Neo4j then refuses it.
const STORED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}(:\d{2})?)(\[[A-Za-z0-9_+/-]{1,64}\])?$/u;

// Relations whose `from` or `to` is a record of the page, in that record's own scope; an endpoint off the page is an id.
async function pageRelations(store, target, uids) {
  if (!uids.length) return { relations: [], relations_truncated: false, relations_total: 0 };
  const { total, rows } = await store.listRelations(target, uids, LIST_RELATIONS_MAX);
  const { owns } = selection(target);
  const relations = [];
  let bytes = 2;
  for (const row of rows) {
    const edge = JSON.parse(row.body);
    // A link names its far end only when the read selects the far scope; otherwise the end is an opaque omission.
    const far = edge.to_scope === undefined ? { to: edge.to } : owns(edge.to_scope) ? { to: edge.to, to_scope: edge.to_scope } : { to: null, to_hidden: true };
    const relation = { scope: row.scope, id: edge.id, type: edge.type, from: edge.from, ...far, attribution: edge.attribution,
      evidence: edge.evidence, stored_at: row.untimed ? null : row.at };
    const added = Buffer.byteLength(JSON.stringify(relation)) + (relations.length ? 1 : 0);
    if (bytes + added > LIST_RELATIONS_MAX_BYTES) break;
    relations.push(relation);
    bytes += added;
  }
  return { relations, relations_truncated: relations.length < total, relations_total: total };
}

const encodeCursor = (binding, key) => Buffer.from(JSON.stringify({ v: 1, q: binding, at: key.at, uid: key.uid })).toString('base64url');

// A cursor resumes only the request that issued it: same selection and filters.
function decodeCursor(value, binding) {
  text(value, 2048);
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { cursor = null; }
  requireThat(cursor && cursor.v === 1 && cursor.q === binding && typeof cursor.at === 'string' && cursor.at.length <= 128
    && STORED_AT.test(cursor.at) && Number.isFinite(Date.parse(cursor.at.replace(/\[[^\]]*\]$/u, ''))) && typeof cursor.uid === 'string' && cursor.uid.length <= 128, 'invalid_input');
  return { at: cursor.at, uid: cursor.uid };
}

const listPage = (scope, items, last, binding) => ({ kind: 'list', ...(Array.isArray(scope) ? { scopes: scope } : { scope }), order: 'stored_desc', items,
  next_cursor: last === null ? null : encodeCursor(binding, last) });

// Turn fields come from the node's own properties first, then from its stored envelope header (a legacy turn has no properties).
function listItem(row, digests = false) {
  const stored = row.untimed ? null : row.at;
  if (row.type === 'turn') {
    let header = {};
    try { header = JSON.parse(row.header) ?? {}; } catch {}
    const own = row.properties ?? {};
    return { kind: 'turn', scope: row.scope, id: row.uid, source: own.source ?? header.source ?? null,
      conversation_id: own.conversation_id ?? header.conversation_id ?? null, turn_id: own.turn_id ?? header.turn_id ?? null,
      parent_turn_id: own.parent_turn_id ?? header.parent_turn_id ?? null, occurred_at: header.occurred_at ?? null,
      stored_at: stored, entry_count: row.entry_count };
  }
  const record = JSON.parse(row.body);
  return { kind: 'record', scope: row.scope, id: record.id, record_kind: record.kind, status: record.status, text: record.text,
    attribution: record.attribution, evidence: record.evidence, stored_at: stored, ...(digests ? { record_digest: recordDigest(row) } : {}) };
}

const CHANNEL_KINDS = { turn_lexical: 'turn', chunk_lexical: 'chunk', record_lexical: 'record', chunk_vector: 'chunk', record_vector: 'record' };

const SET_SHOW_KINDS = ['bundle', 'units', 'following'];

// Re-authorizes a target a public read method was handed directly: an exact scope, a subtree or a set.
function authorizeRead(config, target) {
  if (isScopeSet(target)) return setScopes(config, target);
  return authorizeTarget(config, typeof target === 'object' && target !== null && target.subtree === true ? `${target.scope}/**` : target);
}

// An exact scope (null) or a set, re-authorized element by element (its scopes), for show kinds a set may name.
function setScopes(config, target) {
  if (!isScopeSet(target)) { authorize(config, target); return null; }
  const checked = authorizeSelection(config, target.scopes);
  requireThat(isScopeSet(checked), 'scope_denied');
  return checked.scopes;
}

// The scope a set read names for one item: present, else invalid_input; an element, else scope_denied.
function elementOf(scopes, target, value) {
  if (!scopes) return target;
  text(value, 256);
  requireThat(scopes.includes(value), 'scope_denied');
  return value;
}

const AUTHORITY = 'Evidence and attributed records; not execution permission or a guarantee of current state.';

// Every recall input, validated before any storage call.
function recallOptions(config, input) {
  const mode = input.mode;
  requireThat(mode === undefined || (typeof mode === 'string' && Object.hasOwn(MODE_CONTRACTS, mode)), 'invalid_input');
  requireThat(input.group === undefined || input.group === 'conversation', 'invalid_input');
  const grouped = input.group === 'conversation';
  const perConversation = integer(input.per_conversation, 2, 1, 4);
  const follow = followingOptions(input.follow, grouped);
  const query = text(input.query, 4000);
  const candidates = integer(input.candidates, 64, 1, 256);
  const limit = integer(input.limit, 8, 1, 32);
  const maxNodes = integer(input.max_nodes, 48, 1, 256);
  const maxHops = integer(input.max_hops, 4, 0, 12);
  // Only grouped evidence_advice may ask for the larger pool; there max_chars counts serialized UTF-8 bytes of whole units.
  const maxChars = integer(input.max_chars, 24000, 256, isPoolRequest({ mode, group: input.group }) ? POOL_MAX_CHARS : 200000);
  const vectorLimit = integer(config.vector_scan_limit, 10000, 1, 100000);
  // A caller's own conversation is excluded inside every channel, before its candidate limit: matches from it never
  // take the place of eligible ones, and its unindexed text does not hold the others back.
  const exclude = exclusions(input.exclude_conversations);
  const digests = digestsOption(input);
  return { mode, grouped, perConversation, follow, query, candidates, limit, maxNodes, maxHops, maxChars, vectorLimit, exclude, digests };
}

// The query is embedded at most once per request, however many index groups read vectors.
function queryEmbedder(config, query) {
  let vectors;
  return () => vectors ??= embed(config.embedding, [query]);
}

// Nodes the tree indexes cannot see yet make every channel over that kind partial.
function markPending(availability, pending) {
  for (const [name, kind] of Object.entries(CHANNEL_KINDS)) {
    const state = availability[name];
    if (!pending[kind] || !['ready', 'partial'].includes(state.status)) continue;
    availability[name] = { ...state, status: 'partial', scope_tree_pending: pending[kind], ...(state.reason ? {} : { reason: 'scope_tree_pending' }) };
  }
}

/**
 * A set's index groups, in the set's order: nested elements under one root share that root's tree and one query per channel;
 * every flat element (depth 1, opted-in root included, or opaque) is its own group, read exactly as it is read alone.
 */
function indexGroups(scopes) {
  const groups = new Map();
  for (const scope of scopes) {
    const name = isNested(scope) ? scopePath(scope)[0] : scope;
    const key = JSON.stringify([isNested(scope), name]);
    if (!groups.has(key)) groups.set(key, { name, tree: isNested(scope), scopes: [] });
    groups.get(key).scopes.push(scope);
  }
  return [...groups.values()].map(group => ({ ...group, target: group.scopes.length === 1 ? group.scopes[0] : { scopes: group.scopes } }));
}

// Hits, and seeds admission omitted, of a one-element group, named with its scope as every item of a set read is.
function nameHits(result, scope) {
  for (const name of Object.keys(result.channels)) result.channels[name] = result.channels[name].map(item => item.scope === undefined ? { ...item, scope } : item);
  result.omitted = result.omitted.map(seed => seed.scope === undefined ? { ...seed, scope } : seed);
}

const STATUS_ORDER = ['unavailable', 'pending', 'partial', 'unconfigured', 'not_needed', 'ready'];

/** A set read's `channels`: the worst element status per channel, naming those elements unless every element has it. */
function aggregateChannels(byScope, reranker) {
  const scopes = Object.keys(byScope);
  const channels = Object.fromEntries(Object.keys(CHANNEL_KINDS).map(name => {
    const statuses = scopes.map(scope => byScope[scope].channels[name].status);
    const worst = STATUS_ORDER.find(status => statuses.includes(status)) ?? statuses[0];
    const at = scopes.filter((_, index) => statuses[index] === worst);
    return [name, { status: worst, ...(at.length < scopes.length ? { scopes: at } : {}) }];
  }));
  return Object.fromEntries(Object.entries({ ...channels, reranker }).sort(([a], [b]) => a.localeCompare(b)));
}

const followingTurn = turn => ({ id: turn.id, turn_id: turn.turn_id, occurred_at: turn.occurred_at ?? null,
  entries: turn.entries.map(entry => ({ id: entry.id, role: entry.role, text: entry.text })) });

function followingOptions(input, allowed) {
  if (input === undefined) return null;
  requireThat(allowed && input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['turns', 'bytes'].includes(key)), 'invalid_input');
  return { turns: integer(input.turns, 8, 1, 16), bytes: integer(input.bytes, 16384, 1, 65536) };
}

const seedToken = seed => JSON.stringify(seed.scope === undefined ? [seed.kind, seed.id] : [seed.kind, seed.id, seed.scope]);
const conversationToken = key => JSON.stringify([key.scope, key.source, key.conversation_id]);
const compareConversationKeys = (a, b) => a.scope.localeCompare(b.scope) || a.source.localeCompare(b.source) || a.conversation_id.localeCompare(b.conversation_id);

function exclusions(value) {
  if (value === undefined) return [];
  requireThat(Array.isArray(value) && value.length <= 16, 'invalid_input');
  return value.map(row => {
    requireThat(row && typeof row === 'object' && Object.keys(row).every(key => ['source', 'conversation_id'].includes(key)), 'invalid_input');
    return { source: text(row.source, 256), conversation_id: text(row.conversation_id, 256) };
  });
}

function sourceView(turn, matches, query) {
  const spans = [];
  const seen = new Set();
  const add = span => {
    const key = `${span.entry_id}:${span.start}:${span.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Chunk lexical matches already carry exact text and an exact-or-unknown role; legacy entries may not resolve.
    if (span.text !== undefined && span.role !== undefined) { spans.push({ ...span }); return; }
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

function beforeWrite(prepare) {
  try { return prepare(); } catch (error) { throw markStage(error, 'before_write'); }
}

export function safeCode(error) {
  return error instanceof MemoryError ? error.code : 'database_unavailable';
}
