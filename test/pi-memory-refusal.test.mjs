import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMemoryClient } from '../pi-extension/memory-client.mjs';
import { serve } from '../pi-extension/ndjson.mjs';

test('an explicit pre-write server rejection is distinguished from a transport timeout', async () => {
  const inbound = new PassThrough(), outbound = new PassThrough(), stopped = new AbortController();
  const server = serve({ input: inbound, output: outbound, signal: stopped.signal, handlers: {
    async enrich() { throw Object.assign(new Error('refused'), { code: 'outcome_referent_required' }); },
    async recall() { return new Promise(() => {}); },
    async beginLinks() { throw Object.assign(new Error('incomplete'), { code: 'link_retrieval_incomplete' }); },
  } });
  const client = createMemoryClient({ input: outbound, output: inbound, timeoutMs: 20 });
  try {
    await assert.rejects(client.enrich('fiction', {}, { trigger: 'turn' }), error => error.code === 'outcome_referent_required' && error.effect === 'refused');
    await assert.rejects(client.recall('fiction', { query: 'fiction' }), error => error.code === 'request_timeout' && error.effect === 'none');
    await assert.rejects(client.beginLinks('fiction', 'turn', ['record']), error => error.code === 'link_retrieval_incomplete' && error.effect === 'none');
  } finally { client.close(); stopped.abort(); inbound.end(); outbound.end(); await server; }
});
