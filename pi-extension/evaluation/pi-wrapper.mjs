import { modelFingerprint } from './seal.mjs';

const fail = code => Object.assign(new Error(code), { code });
export const METERED_RUNTIME = Symbol('metered-pi-runtime');

/** Share one gate across roles when a pilot permits only one SDK call in flight. */
export function createSingleFlightGate() {
  let busy = false;
  return {
    wrap(runtime) {
      if (runtime?.[METERED_RUNTIME] !== true) throw fail('metered_runtime_required');
      return new Proxy(runtime, {
        get(target, key) {
          if (key !== 'streamSimple') {
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (...args) => {
            if (busy) throw fail('model_call_in_flight');
            busy = true;
            try {
              const stream = target.streamSimple(...args);
              Promise.resolve(stream.result()).then(message => {
                const usage = message?.usage;
                if (['stop', 'length', 'toolUse'].includes(message?.stopReason)
                  && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)) busy = false;
              }, () => {});
              return stream;
            } catch (error) { throw error; }
          };
        },
      });
    },
    busy: () => busy,
  };
}

// The wrapped call remains synchronous and returns Pi's original event stream.
export function wrapPiRuntime({ runtime, ledger, planId, nextSlot, boundInput, usageEvidence = () => null, onLedgerError = () => {} }) {
  if (typeof runtime?.streamSimple !== 'function' || typeof ledger?.startSlot !== 'function'
    || typeof nextSlot !== 'function' || typeof boundInput !== 'function' || typeof usageEvidence !== 'function' || typeof onLedgerError !== 'function') throw fail('wrapper_invalid');
  return new Proxy(runtime, {
    get(target, key) {
      if (key === METERED_RUNTIME) return true;
      if (['stream', 'complete', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'cancelDeferred'].includes(key)) {
        return () => { throw fail('unmetered_api_refused'); };
      }
      if (key !== 'streamSimple') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (model, context, options) => {
        const slot = nextSlot(model, context, options);
        const bound = boundInput(model, context, options);
        if (bound?.providerBound !== true || typeof bound.proofRef !== 'string' || !bound.proofRef.trim()
          || !/^[a-f0-9]{64}$/.test(bound.contextFingerprint ?? '')) throw fail('input_bound_unverified');
        ledger.startSlot(planId, slot, { inputBoundTokens: bound.tokens, maxOutputTokens: options?.maxTokens,
          route: `${model?.provider}/${model?.id}`, modelFingerprint: modelFingerprint(model), providerBound: true,
          proofRef: bound.proofRef, contextFingerprint: bound.contextFingerprint,
          prefixFingerprint: bound.prefixFingerprint ?? null, cacheMarkers: bound.cacheMarkers ?? null, cacheTtl: bound.cacheTtl ?? null });
        const start = Date.now();
        let stream;
        try {
          stream = target.streamSimple(model, context, options);
          if (!stream || typeof stream.result !== 'function' || typeof stream[Symbol.asyncIterator] !== 'function') throw fail('pi_stream_invalid');
          const result = stream.result();
          if (!result || typeof result.then !== 'function') throw fail('pi_stream_invalid');
          Promise.resolve(result).then(message => ledger.recordResult(planId, slot, message, Date.now() - start, usageEvidence(message)),
            error => ledger.recordUnknown(planId, slot, error?.code ?? 'stream_rejected')).catch(onLedgerError);
        } catch (error) {
          try { ledger.recordUnknown(planId, slot, error?.code ?? 'dispatch_unknown'); } catch (ledgerError) { onLedgerError(ledgerError); }
          throw error;
        }
        return stream;
      };
    },
  });
}
