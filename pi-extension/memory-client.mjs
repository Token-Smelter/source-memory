import { createClient } from './ndjson.mjs';

/** Facade for one long-lived Memory subprocess; never exposes raw relation writes. */
export function createMemoryClient({ input, output, timeoutMs, reviewContract = 'pi-memory-review/v1', onReceipt = () => {} }) {
  const client = createClient({ input, output, timeoutMs });
  const call = async (method, args, options) => {
    try {
      const value = await client.request(method, args, options);
      onReceipt({ method, ok: true, value });
      return value;
    } catch (error) {
      onReceipt({ method, ok: false, code: error.code ?? 'request_failed' });
      throw error;
    }
  };
  return {
    init: (scope, options) => call('init', { scope }, options),
    ingest: (scope, turn, options) => call('ingest', { scope, turn }, options),
    recall: (scope, input, options) => call('recall', { scope, input }, options),
    enrich: (scope, input, { trigger, signal } = {}) => call('enrich', { scope, input, trigger }, { signal }),
    beginLinks: (scope, turn, recordIds, options) => call('beginLinks', { scope, turn, record_ids: recordIds, review_contract: reviewContract }, options),
    finishLinks: (token, output, route, options) => call('finishLinks', { token, output, route }, options),
    applyLinks: (token, review, options) => call('applyLinks', { token, review }, options),
    cancelLinks: (token, options) => call('cancelLinks', { token }, options),
    close: client.close,
  };
}
