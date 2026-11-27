import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { embed, EmbeddingContextRejection, embeddingContextContract, embeddingIdentity } from '../src/models.mjs';

const message = 'the input length exceeds the context length';

async function fixture(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const value = { path: req.url, body: JSON.parse(body) };
    calls.push(value);
    const [status, reply] = handler(value);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const legacy = { url: `http://127.0.0.1:${server.address().port}/v1/embeddings`, model: 'embeddinggemma', dimensions: 2,
    ollama_context_revision: 'fixture' };
  return { calls, legacy, native: { ...legacy, ollama_transport: 'native_no_truncate' } };
}

test('native transport preserves the canonical embedding key and sends ordered, unclipped input', async t => {
  const { calls, legacy, native } = await fixture(t, ({ path, body }) => {
    const vectors = [[1, 0], [0, 1]];
    return [200, { model: body.model, ...(path === '/api/embed' ? { embeddings: vectors }
      : { data: vectors.map((embedding, index) => ({ index, embedding })).reverse() }) }];
  });
  assert.equal(embeddingIdentity(native), embeddingIdentity(legacy));
  assert.notEqual(embeddingContextContract(native), embeddingContextContract(legacy));
  const input = ['Fictional blue', 'Fictional amber'];
  assert.deepEqual(await embed(native, input), await embed(legacy, input));
  assert.deepEqual(calls, [
    { path: '/api/embed', body: { model: native.model, input, truncate: false } },
    { path: '/v1/embeddings', body: { model: legacy.model, input } },
  ]);
});

test('only an exact native 400 on an isolated singleton qualifies, without fallback', async t => {
  const { calls, native } = await fixture(t, ({ body }) => {
    if (body.input[0] === 'wrapped') return [400, { error: { type: 'invalid_request_error', message } }];
    if (body.input[0] === 'wrong status') return [503, { error: message }];
    if (body.input[0] === 'canceled') return [400, { error: 'context canceled' }];
    return [400, { error: message }];
  });
  await assert.rejects(() => embed(native, ['single'], { isolatedChunk: true }), EmbeddingContextRejection);
  for (const input of [['single', 'other'], ['wrapped'], ['wrong status'], ['canceled']]) {
    await assert.rejects(() => embed(native, input, { isolatedChunk: true }), { code: 'model_request_failed' });
  }
  await assert.rejects(() => embed(native, ['single']), { code: 'model_request_failed' });
  await assert.rejects(() => embed({ ...native, allow_remote: true }, ['single']), { code: 'invalid_model_endpoint' });
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.path === '/api/embed' && call.body.truncate === false));
});

test('native responses must have the requested model, vector count and dimensions', async t => {
  const { native } = await fixture(t, ({ body }) => [200, {
    model: body.input[0] === 'wrong model' ? 'other' : 'embeddinggemma',
    embeddings: body.input[0] === 'wrong count' ? [] : [[1]],
  }]);
  await assert.rejects(() => embed(native, ['wrong model']), { code: 'embedding_model_mismatch' });
  await assert.rejects(() => embed(native, ['wrong count']), { code: 'invalid_embedding_response' });
  await assert.rejects(() => embed(native, ['wrong dimensions']), { code: 'invalid_embedding' });
});
