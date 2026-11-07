import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createEmbeddingHandler } from '../pi-extension/bridge-harness.mjs';

async function request(handler) {
  const input = Readable.from(['{"model":"fiction","input":["text"]}']); input.method = 'POST'; input.url = '/v1/embeddings';
  const output = new EventEmitter(); output.writeHead = status => { output.status = status; }; output.end = () => {};
  await handler(input, output); return output.status;
}

test('configured relay timeout permits a slow local batch and records metadata only', async () => {
  const events = [];
  const handler = createEmbeddingHandler({ timeoutMs: 100, onEvent: row => events.push(row), fetchFn: async (_url, options) => {
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 20); options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true }); });
    return new Response('{"data":[]}');
  } });
  assert.deepEqual([await request(handler), events[0].outcome, events[0].request_bytes > 0], [200, 'complete', true]);
});

test('relay timeout is an explicit metadata event, not a silent empty embedding', async () => {
  const events = [];
  const handler = createEmbeddingHandler({ timeoutMs: 5, onEvent: row => events.push(row), fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('unexpected')), 100);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
  }) });
  assert.deepEqual([await request(handler), events[0].code], [502, 'relay_timeout']);
});
