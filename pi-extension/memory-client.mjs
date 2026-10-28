import { createClient } from './ndjson.mjs';

/** Facade for one long-lived Memory subprocess; never exposes raw relation writes. */
export function createMemoryClient({ input, output, timeoutMs, reviewContract = 'pi-memory-review/v1' }) {
  const client = createClient({ input, output, timeoutMs });
  return {
    ingest: (scope, turn, options) => client.request('ingest', { scope, turn }, options),
    recall: (scope, input, options) => client.request('recall', { scope, input }, options),
    enrich: (scope, input, { trigger, signal } = {}) => client.request('enrich', { scope, input, trigger }, { signal }),
    beginLinks: (scope, turn, recordIds, options) => client.request('beginLinks', { scope, turn, record_ids: recordIds, review_contract: reviewContract }, options),
    finishLinks: (token, output, route, options) => client.request('finishLinks', { token, output, route }, options),
    applyLinks: (token, review, options) => client.request('applyLinks', { token, review }, options),
    cancelLinks: (token, options) => client.request('cancelLinks', { token }, options),
    close: client.close,
  };
}
