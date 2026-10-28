import { randomUUID } from 'node:crypto';
import { normalizeEnrichment } from '../src/core.mjs';
import * as defaultLinks from '../src/link-proposals.mjs';

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
  const slots = new Map();
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
    async ingest({ scope, turn }) {
      allowed(scope);
      if (turn?.source !== 'pi-memory') throw fail('source_invalid');
      return memory.ingest(scope, turn);
    },
    async recall({ scope, input }) { allowed(scope); return memory.recall(scope, input); },
    async enrich({ scope, input, trigger }) {
      allowed(scope);
      const normalized = normalizeEnrichment(input);
      if (normalized.relations.length || normalized.records.some(record => record.status !== 'proposed')) throw fail('raw_link_refused');
      if (typeof trigger !== 'string' || !trigger || normalized.records.some(record => record.evidence.some(span => span.turn !== trigger))) throw fail('record_not_from_trigger');
      const shown = await memory.show(scope, { kind: 'turn', id: trigger });
      if (shown?.turn?.source !== 'pi-memory') throw fail('source_invalid');
      return memory.enrich(scope, normalized);
    },
    async beginLinks({ scope, turn, record_ids, review_contract }, { signal } = {}) {
      allowed(scope);
      if (signal?.aborted) throw fail('request_cancelled');
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
      slot.work = Promise.resolve().then(() => linkModule.proposeMemoryLinks({ memory, scope, turn, record_ids, review_contract,
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
    close() { for (const slot of [...slots.values()]) cancel(slot); },
  };
}
