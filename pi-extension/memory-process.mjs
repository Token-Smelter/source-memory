import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeEnrichment } from '../src/core.mjs';
import * as defaultLinks from '../src/link-proposals.mjs';
import { searchDerived, resolveDerived, searchRaw } from './derived-retrieval.mjs';
import { createAtomicOutcomes } from './atomic-outcome.mjs';
import { searchCompactRecords } from './compact-retrieval.mjs';

const fail = code => Object.assign(new Error(code), { code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};

/** The process retains the original proposal object; NDJSON exposes only a token and frozen offer. */
export function createMemoryHandlers({ memory, scopes, linkModule = defaultLinks, beforeAppend, offerTimeoutMs = 30000 }) {
  if (!Array.isArray(scopes) || scopes.length !== 1 || typeof scopes[0] !== 'string' || !scopes[0]) throw fail('scope_unresolved');
  if (!Number.isSafeInteger(offerTimeoutMs) || offerTimeoutMs <= 0) throw fail('timeout_invalid');
  const allowed = scope => { if (scope !== scopes[0]) throw fail('scope_denied'); };
  const slots = new Map(), compactOffers = new Map();
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
    async index({ scope, input }) {
      allowed(scope);
      const flight = indexing ??= Promise.resolve().then(() => memory.index(scope, input));
      try { return await flight; } finally { if (indexing === flight) indexing = null; }
    },
    async ingest({ scope, turn }) {
      allowed(scope);
      if (turn?.source !== 'pi-memory') throw fail('source_invalid');
      return memory.ingest(scope, turn);
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
      const maxBytes = input?.max_bytes ?? 24000;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 24000) throw fail('invalid_input');
      const ranked = await searchCompactRecords(memory, scope, input);
      const wrapped = outcomes.offer(scope, trigger, { bundles: [{ records: ranked.records }] });
      const selected = [], offers = [];
      const result = { status: 'budget_limited', records: selected, channels: ranked.channels, ranked_count: ranked.ranked_count,
        top_k_omitted: ranked.top_k_omitted, filter_may_be_incomplete: ranked.filter_may_be_incomplete,
        budget_omitted: ranked.records.length, relationship_context: 'not_loaded', completeness_guaranteed: false };
      for (const row of wrapped.bundles[0].records) {
        const handle = `record-${randomBytes(16).toString('base64url')}`, item = { ...row, handle };
        selected.push(item);
        result.budget_omitted = ranked.records.length - selected.length;
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) { selected.pop(); result.budget_omitted++; continue; }
        offers.push({ handle, scope, trigger, id: row.id });
      }
      if (compactOffers.size + offers.length > 4096) throw fail('compact_offer_limit');
      for (const offer of offers) compactOffers.set(offer.handle, offer);
      result.status = result.budget_omitted ? 'budget_limited' : selected.length ? 'ready' : 'no_matches';
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw fail('search_budget_invalid');
      return result;
    },
    async fetchCompact({ scope, trigger, handle }) {
      allowed(scope);
      const offered = compactOffers.get(handle);
      if (!offered || offered.scope !== scope || offered.trigger !== trigger) throw fail('handle_not_offered');
      if (typeof memory.store?.neighbors !== 'function') throw fail('search_unavailable');
      const shown = await memory.show(scope, { kind: 'record', id: offered.id });
      const relations = await memory.store.neighbors(scope, [offered.id], 65);
      if (!Array.isArray(relations) || relations.length > 65
        || relations.some(row => row.from !== offered.id && row.to !== offered.id)) throw fail('search_incomplete');
      return { ...shown, relations: relations.slice(0, 64), relationship_context_complete: relations.length <= 64,
        relationship_omitted_at_least: relations.length > 64 ? 1 : 0 };
    },
    async releaseCompact({ scope, trigger }) {
      allowed(scope);
      for (const [handle, offered] of compactOffers) if (offered.scope === scope && offered.trigger === trigger) compactOffers.delete(handle);
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
      allowed(scope);
      const normalized = normalizeEnrichment(input);
      if (normalized.relations.length || normalized.records.some(record => record.status !== 'proposed')) throw fail('raw_link_refused');
      if (typeof trigger !== 'string' || !trigger || normalized.records.some(record => record.evidence.some(span => span.turn !== trigger))) throw fail('record_not_from_trigger');
      const shown = await memory.show(scope, { kind: 'turn', id: trigger });
      if (shown?.turn?.source !== 'pi-memory') throw fail('source_invalid');
      return memory.enrich(scope, normalized);
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
    close() { for (const slot of [...slots.values()]) cancel(slot); compactOffers.clear(); outcomes.close(); },
  };
}
