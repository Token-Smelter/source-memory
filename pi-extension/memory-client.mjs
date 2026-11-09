import { createClient } from './ndjson.mjs';

const noPersistentWrite = new Set(['status', 'recordPresence', 'recordVectorStatus', 'turnVectorStatus', 'sourceChunks', 'recall', 'searchCompact', 'fetchCompact', 'releaseCompact', 'beginLinks', 'finishLinks', 'cancelLinks', 'beginOutcome', 'cancelOutcome',
  'searchDerived', 'resolveDerived', 'searchRaw']);

/** Facade for one long-lived Memory subprocess; never exposes raw relation writes. */
export function createMemoryClient({ input, output, timeoutMs, indexTimeoutMs = timeoutMs, reviewContract = 'pi-memory-review/v1', onReceipt = () => {} }) {
  const client = createClient({ input, output, timeoutMs });
  const call = async (method, args, options) => {
    try {
      const value = await client.request(method, args, options);
      onReceipt({ method, ok: true, value });
      return value;
    } catch (error) {
      if (noPersistentWrite.has(method)) error.effect = 'none';
      if (method === 'index') error.effect = 'retryable_idempotent';
      // Stage unknown cannot rule out a committed write. A frame without a stage makes no claim; the code alone decides.
      if (error.remote_rejection === true && error.stage !== 'unknown' && ((method === 'enrich' && error.code === 'outcome_referent_required')
        || (method === 'applyOutcome' && ['outcome_review_refused', 'outcome_context_changed'].includes(error.code)))) error.effect = 'refused';
      onReceipt({ method, ok: false, code: error.code ?? 'request_failed', effect: error.effect ?? 'unknown' });
      throw error;
    }
  };
  return {
    init: (scope, options) => call('init', { scope }, options),
    status: (scope, options) => call('status', { scope }, options),
    recordVectorStatus: (scope, ids, options) => call('recordVectorStatus', { scope, ids }, options),
    turnVectorStatus: (scope, turn, options) => call('turnVectorStatus', { scope, turn }, options),
    sourceChunks: (scope, turn, options) => call('sourceChunks', { scope, turn }, options),
    recordPresence: (scope, ids, options) => call('recordPresence', { scope, ids }, options),
    index: (scope, input, options = {}) => call('index', { scope, input }, { ...options, timeoutMs: indexTimeoutMs }),
    ingest: (scope, turn, options) => call('ingest', { scope, turn }, options),
    recall: (scope, input, { signal, trigger } = {}) => call('recall', { scope, input, ...(trigger ? { trigger } : {}) }, { signal }),
    searchCompact: (scope, input, trigger, options) => call('searchCompact', { scope, input, trigger }, options),
    fetchCompact: (scope, trigger, handle, options) => call('fetchCompact', { scope, trigger, handle }, options),
    releaseCompact: (scope, trigger, options) => call('releaseCompact', { scope, trigger }, options),
    beginOutcome: (scope, trigger, outcome, newAction, actionHandle, options) => call('beginOutcome',
      { scope, trigger, outcome, new_action: newAction, action_handle: actionHandle }, options),
    applyOutcome: (scope, token, review, options) => call('applyOutcome', { scope, token, review }, options),
    cancelOutcome: (token, options) => call('cancelOutcome', { token }, options),
    searchDerived: (scope, input, options) => call('searchDerived', { scope, input }, options),
    resolveDerived: (scope, input, options) => call('resolveDerived', { scope, input }, options),
    searchRaw: (scope, input, options) => call('searchRaw', { scope, input }, options),
    enrich: (scope, input, { trigger, signal } = {}) => call('enrich', { scope, input, trigger }, { signal }),
    beginLinks: (scope, turn, recordIds, { candidateHandles, signal } = {}) => call('beginLinks',
      { scope, turn, record_ids: recordIds, ...(candidateHandles ? { candidate_handles: candidateHandles } : {}), review_contract: reviewContract }, { signal }),
    finishLinks: (token, output, route, options) => call('finishLinks', { token, output, route }, options),
    applyLinks: (token, review, options) => call('applyLinks', { token, review }, options),
    cancelLinks: (token, options) => call('cancelLinks', { token }, options),
    close: client.close,
  };
}
