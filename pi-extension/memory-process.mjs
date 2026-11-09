import { randomBytes, randomUUID } from 'node:crypto';
import { isSelector, markStage, normalizeEnrichment, OUTCOME_REFERENT_KINDS } from '../src/core.mjs';
import * as defaultLinks from '../src/link-proposals.mjs';
import { searchDerived, resolveDerived, searchRaw } from './derived-retrieval.mjs';
import { createAtomicOutcomes } from './atomic-outcome.mjs';
import { catalogCompactRecords, searchCompactRecords } from './compact-retrieval.mjs';

const fail = code => Object.assign(new Error(code), { code });
// The handlers whose failure frames carry `stage`; pass to ndjson serve.
export const STAGED_METHODS = ['ingest', 'enrich'];
// Stages a write as bin/memory.mjs does: a failed check wrote nothing; a write failure keeps its own stage, else unknown.
async function stagedWrite(check, perform) {
  try { await check(); } catch (error) { throw markStage(error, 'before_write'); }
  try { return await perform(); } catch (error) { throw markStage(error, 'unknown'); }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};

/** The process retains the original proposal object; NDJSON exposes only a token and frozen offer. */
export function createMemoryHandlers({ memory, scopes, linkModule = defaultLinks, beforeAppend, offerTimeoutMs = 30000 }) {
  // One exact scope: offers and handles are keyed by it, so a subtree selector would conflate same-id records across scopes.
  if (!Array.isArray(scopes) || scopes.length !== 1 || typeof scopes[0] !== 'string' || !scopes[0] || isSelector(scopes[0])) throw fail('scope_unresolved');
  if (!Number.isSafeInteger(offerTimeoutMs) || offerTimeoutMs <= 0) throw fail('timeout_invalid');
  const allowed = scope => { if (scope !== scopes[0]) throw fail('scope_denied'); };
  const slots = new Map(), compactOffers = new Map(), compactByIdentity = new Map();
  const compactKey = (scope, trigger, id) => JSON.stringify([scope, trigger, id]);
  const compactHandle = (scope, trigger, id) => compactByIdentity.get(compactKey(scope, trigger, id))
    ?? `record-${randomBytes(16).toString('base64url')}`;
  const registerCompact = offers => {
    const fresh = offers.filter(offer => !compactOffers.has(offer.handle));
    if (compactOffers.size + fresh.length > 4096) throw fail('compact_offer_limit');
    for (const offer of fresh) { compactOffers.set(offer.handle, offer); compactByIdentity.set(compactKey(offer.scope, offer.trigger, offer.id), offer.handle); }
  };
  let indexing = null;
  const outcomes = createAtomicOutcomes({ memory, beforeAppend });
  const cancel = slot => {
    if (!slot || slot.closed) return false;
    slot.closed = true;
    clearTimeout(slot.timer);
    slot.controller.abort();
    slot.compare?.reject(fail('request_cancelled'));
    slots.delete(slot.token);
    return true;
  };
  return {
    async init({ scope }) { allowed(scope); return memory.init(scope); },
    async status({ scope }) { allowed(scope); return memory.status(scope); },
    async recordVectorStatus({ scope, ids }) { allowed(scope); return memory.recordVectorStatus(scope, ids); },
    async turnVectorStatus({ scope, turn }) { allowed(scope); return memory.turnVectorStatus(scope, turn); },
    async sourceChunks({ scope, turn }) { allowed(scope); return memory.sourceChunks(scope, turn); },
    async recordPresence({ scope, ids }) { allowed(scope); return memory.recordPresence(scope, ids); },
    async index({ scope, input }) {
      allowed(scope);
      const flight = indexing ??= Promise.resolve().then(() => memory.index(scope, input));
      try { return await flight; } finally { if (indexing === flight) indexing = null; }
    },
    async ingest({ scope, turn }) {
      return stagedWrite(() => {
        allowed(scope);
        if (turn?.source !== 'pi-memory') throw fail('source_invalid');
      }, () => memory.ingest(scope, turn));
    },
    async recall({ scope, input, trigger }) {
      allowed(scope);
      const result = await memory.recall(scope, input);
      return outcomes.offer(scope, trigger, result);
    },
    async searchCompact({ scope, input, trigger }) {
      allowed(scope);
      if (typeof trigger !== 'string' || !trigger) throw fail('source_invalid');
      const shown = await memory.show(scope, { kind: 'turn', id: trigger });
      if (shown?.turn?.source !== 'pi-memory') throw fail('source_invalid');
      const catalog = input?.catalog === true, maxBytes = input?.max_bytes ?? 24000;
      if (input?.catalog !== undefined && !catalog) throw fail('invalid_input');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > (catalog ? 120000 : 24000)) throw fail('invalid_input');
      const ranked = catalog ? await catalogCompactRecords(memory, scope) : await searchCompactRecords(memory, scope, input);
      const selected = [], edges = [], offers = [], indexes = new Map();
      const result = { status: 'budget_limited', records: selected, relations: edges, channels: ranked.channels,
        ranked_count: ranked.ranked_count, seed_count: ranked.seed_count, declared_seed_limit: ranked.declared_seed_limit,
        candidate_pool_limit: ranked.candidate_pool_limit,
        filtered_record_count: ranked.filtered_record_count, filtered_edge_count: ranked.filtered_edge_count,
        collapsed_edge_count: ranked.collapsed_edge_count, related_kind_count: ranked.related_kind_count, graph_edge_count: ranked.edges.length,
        graph_gaps: ranked.graph_gaps, relationship_context_complete: false,
        budget_omitted: ranked.records.length, edge_budget_omitted: ranked.edges.length, completeness_guaranteed: false };
      for (const row of ranked.records) {
        const handle = compactHandle(scope, trigger, row.id);
        const item = { id: handle, kind: row.kind, score: row.score, text: row.text, text_truncated: row.text_truncated,
          ...(OUTCOME_REFERENT_KINDS.includes(row.kind) ? { action_handle: `action-${'0'.repeat(36)}` } : {}) };
        selected.push(item);
        result.budget_omitted = ranked.records.length - selected.length;
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) { selected.pop(); result.budget_omitted++; continue; }
        offers.push({ handle, scope, trigger, id: row.id });
        indexes.set(row.id, selected.length - 1);
      }
      for (const edge of ranked.edges) {
        if (!indexes.has(edge.from) || !indexes.has(edge.to)) continue;
        edges.push({ endpoints: [indexes.get(edge.from), indexes.get(edge.to)].sort((a, b) => a - b) });
        result.edge_budget_omitted = ranked.edges.length - edges.length;
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) { edges.pop(); result.edge_budget_omitted++; }
      }
      const fresh = offers.filter(offer => !compactOffers.has(offer.handle));
      if (compactOffers.size + fresh.length > 4096) throw fail('compact_offer_limit');
      const actionRows = outcomes.offer(scope, trigger, { bundles: [{ records: selected.map((row, index) => ({ ...row, id: offers[index].id })) }] }).bundles[0].records;
      for (let i = 0; i < selected.length; i++) if (actionRows[i].action_handle) selected[i].action_handle = actionRows[i].action_handle;
      result.relationship_context_complete = !ranked.graph_gaps.length && !result.budget_omitted && !result.edge_budget_omitted;
      result.status = result.budget_omitted || result.edge_budget_omitted ? 'budget_limited' : selected.length ? 'ready' : 'no_matches';
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw fail('search_budget_invalid');
      registerCompact(offers);
      return { surface: result, bindings: offers.map(({ handle, id }) => ({ handle, id })) };
    },
    async fetchCompact({ scope, trigger, handle }) {
      allowed(scope);
      const offered = compactOffers.get(handle);
      if (!offered || offered.scope !== scope || offered.trigger !== trigger) throw fail('handle_not_offered');
      if (typeof memory.store?.neighbors !== 'function') throw fail('search_unavailable');
      const shown = await memory.show(scope, { kind: 'record', id: offered.id });
      if (shown?.kind !== 'record' || shown.record?.scope !== scope || shown.record.id !== offered.id || !Array.isArray(shown.evidence)
        || !shown.evidence.length || shown.evidence.some(row => typeof row?.role !== 'string' || typeof row.text !== 'string' || !row.text)) throw fail('search_incomplete');
      const relations = await memory.store.neighbors(scope, [offered.id], 65);
      if (!Array.isArray(relations) || relations.length > 65
        || relations.some(row => row.from !== offered.id && row.to !== offered.id)) throw fail('search_incomplete');
      const ids = [...new Set(relations.slice(0, 64).flatMap(row => [row.from, row.to]))];
      const endpoints = await memory.store.getRecords(scope, ids);
      if (!Array.isArray(endpoints) || endpoints.length !== ids.length || new Set(endpoints.map(row => row.id)).size !== ids.length
        || endpoints.some(row => row.scope !== scope || !ids.includes(row.id))) throw fail('search_incomplete');
      const offers = ids.map(id => ({ handle: compactHandle(scope, trigger, id), scope, trigger, id }));
      const handles = new Map(offers.map(row => [row.id, row.handle]));
      const result = { kind: 'record', record: { id: shown.record.id, kind: shown.record.kind, text: shown.record.text },
        evidence: shown.evidence.map(row => ({ role: row.role, text: row.text })),
        relations: relations.slice(0, 64).map(row => ({ type: row.type, from_id: row.from, to_id: row.to,
          from_handle: handles.get(row.from), to_handle: handles.get(row.to) })),
        immediate_relations_complete: relations.length <= 64, relationship_omitted_at_least: relations.length > 64 ? 1 : 0 };
      if (Buffer.byteLength(JSON.stringify(result)) > 120000) throw fail('fetch_budget_exceeded');
      registerCompact(offers);
      return result;
    },
    async releaseCompact({ scope, trigger }) {
      allowed(scope);
      for (const [handle, offered] of compactOffers) if (offered.scope === scope && offered.trigger === trigger) {
        compactOffers.delete(handle); compactByIdentity.delete(compactKey(scope, trigger, offered.id));
      }
      outcomes.release(scope, trigger);
      return { released: true };
    },
    async beginOutcome({ scope, trigger, outcome, new_action, action_handle }) {
      allowed(scope);
      return outcomes.begin({ scope, trigger, outcome, new_action, action_handle });
    },
    async applyOutcome({ scope, token, review }) { allowed(scope); return outcomes.apply({ scope, token, review }); },
    async cancelOutcome({ token }) { return outcomes.cancel(token); },
    async searchDerived({ scope, input }) { allowed(scope); return searchDerived(memory, scope, input); },
    async resolveDerived({ scope, input }) { allowed(scope); return resolveDerived(memory, scope, input); },
    async searchRaw({ scope, input }) { allowed(scope); return searchRaw(memory, scope, input); },
    async enrich({ scope, input, trigger }) {
      let normalized;
      return stagedWrite(async () => {
        allowed(scope);
        normalized = normalizeEnrichment(input);
        if (normalized.relations.length || normalized.records.some(record => record.status !== 'proposed')) throw fail('raw_link_refused');
        if (typeof trigger !== 'string' || !trigger || normalized.records.some(record => record.evidence.some(span => span.turn !== trigger))) throw fail('record_not_from_trigger');
        const shown = await memory.show(scope, { kind: 'turn', id: trigger });
        if (shown?.turn?.source !== 'pi-memory') throw fail('source_invalid');
      }, () => memory.enrich(scope, normalized));
    },
    async beginLinks({ scope, turn, record_ids, candidate_handles, review_contract }, { signal } = {}) {
      allowed(scope);
      if (signal?.aborted) throw fail('request_cancelled');
      let candidateRecordIds = null;
      if (candidate_handles !== undefined) {
        if (!Array.isArray(candidate_handles) || candidate_handles.length > 32 || new Set(candidate_handles).size !== candidate_handles.length) throw fail('invalid_input');
        candidateRecordIds = candidate_handles.map(handle => {
          const offered = compactOffers.get(handle);
          if (!offered || offered.scope !== scope || offered.trigger !== turn) throw fail('handle_not_offered');
          return offered.id;
        });
        if (new Set(candidateRecordIds).size !== candidateRecordIds.length) throw fail('invalid_input');
      }
      const token = randomUUID();
      const controller = new AbortController();
      const offered = deferred();
      const compare = deferred();
      compare.promise.catch(() => {});
      const slot = { token, scope, controller, compare, closed: false, result: null };
      slots.set(token, slot);
      const abort = () => { offered.reject(fail('request_cancelled')); cancel(slot); };
      signal?.addEventListener('abort', abort, { once: true });
      slot.timer = setTimeout(abort, offerTimeoutMs);
      slot.work = Promise.resolve().then(() => linkModule.proposeMemoryLinks({ memory, scope, turn, record_ids,
        candidate_record_ids: candidateRecordIds, review_contract,
        signal: controller.signal, compare: async input => {
          offered.resolve({ token, packet: input.packet });
          return compare.promise;
        } }));
      slot.work.catch(problem => offered.reject(problem));
      try { return await offered.promise; }
      catch (problem) { cancel(slot); throw problem; }
      finally { signal?.removeEventListener('abort', abort); }
    },
    async finishLinks({ token, output, route }) {
      const slot = slots.get(token);
      if (!slot || slot.closed || slot.result) throw fail('offer_unavailable');
      slot.compare.resolve({ text: output, route });
      try {
        const result = await slot.work;
        if (slot.closed) throw fail('offer_unavailable');
        slot.result = result;
        return structuredClone(result);
      } catch (problem) { cancel(slot); throw problem; }
    },
    async applyLinks({ token, review }) {
      const slot = slots.get(token);
      if (!slot || slot.closed || !slot.result) throw fail('offer_unavailable');
      if (typeof beforeAppend !== 'function') throw fail('link_append_preparation_required');
      try {
        return await linkModule.applyReviewedMemoryLinks({ memory, scope: slot.scope, result: slot.result, review,
          before_append: beforeAppend, signal: slot.controller.signal });
      } finally { cancel(slot); }
    },
    async cancelLinks({ token }) { return { cancelled: cancel(slots.get(token)) }; },
    close() { for (const slot of [...slots.values()]) cancel(slot); compactOffers.clear(); compactByIdentity.clear(); outcomes.close(); },
  };
}
