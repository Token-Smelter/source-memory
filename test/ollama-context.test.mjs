import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Memory } from '../src/memory.mjs';
import { embeddingContextContract } from '../src/models.mjs';

const rejection = { error: { type: 'invalid_request_error', message: 'the input length exceeds the context length' } };
const malformedWire = Buffer.concat([Buffer.from('{"junk":"'), Buffer.from([0xff]),
  Buffer.from(`","error":${JSON.stringify(rejection.error)}}`)]);
const fixture = { uid: 'fixture', text: 'Fictional input', chunk: true, isolated: true, single: true };

for (const [name, rows, status, body, optIn, terminal] of [
  ['verified singleton', [fixture], 400, rejection, true, true],
  ['disabled contract', [fixture], 400, rejection, false, false],
  ['record', [{ ...fixture, chunk: false }], 400, rejection, true, false],
  ['fresh singleton', [{ ...fixture, isolated: false, single: false }], 400, rejection, true, false],
  ['batch', [fixture, { ...fixture, uid: 'other' }].map(row => ({ ...row, single: false })), 400, rejection, true, false],
  ['unexpected status', [fixture], 500, rejection, true, false],
  ['malformed UTF-8 with exact error fields', [fixture], 400, malformedWire, true, false],
  ['generic error', [fixture], 400, { error: { message: rejection.error.message } }, true, false],
  ['oversized error envelope', [fixture], 400, { ...rejection, pad: 'x'.repeat(1024) }, true, false],
]) {
  test(`Ollama context result: ${name}`, async t => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(status, { 'content-type': 'application/json' }).end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const embedding = { url: `http://127.0.0.1:${server.address().port}/v1/embeddings`, model: 'embeddinggemma', dimensions: 768,
      ...(optIn ? { ollama_context_revision: 'fixture-v1' } : {}) };
    const effects = [];
    const store = { pendingEmbeddings: async () => rows,
      markContextRejectedChunk: async (...args) => effects.push(['mark', ...args]),
      deferEmbeddings: async (...args) => effects.push(['defer', ...args]) };
    const memory = new Memory({ embedding, scopes: { write: ['test'] } }, store);
    const reply = await memory.index('test');
    if (terminal) {
      assert.equal(reply.status, 'pending');
      assert.equal(reply.indexed, 0);
      assert.deepEqual(effects, [['mark', 'test', reply.embedding_key, embeddingContextContract(embedding), { uid: fixture.uid, text: fixture.text }]]);
    } else {
      assert.deepEqual([reply.status, reply.reason, effects[0]?.[0], effects[0]?.[4]],
        ['unavailable', 'model_request_failed', 'defer', rows.length === 1 ? 300 : 60]);
    }
  });
}

test('the terminal context witness is versioned independently of the existing embedding key', () => {
  const config = { url: 'http://127.0.0.1:11434/v1/embeddings', model: 'embeddinggemma', dimensions: 768, ollama_context_revision: 'v1' };
  assert.notEqual(embeddingContextContract(config), embeddingContextContract({ ...config, ollama_context_revision: 'v2' }));
  assert.equal(embeddingContextContract({ ...config, allow_remote: true }), null);
});
