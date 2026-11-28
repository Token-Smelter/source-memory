import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_MAX_BYTES } from '../src/core.mjs';
import { chunkPolicy } from '../src/chunk-policy.mjs';
import { readGgufTokenizer, RENDER_CONTRACT, sentencePiece } from '../src/tokenizer.mjs';
import { rechunkSpan } from '../src/span-rechunk.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

// One fictional token per word and one per space: n words are 2n + 1 tokens with BOS and EOS.
const words = (count, word = 'abcd') => Array.from({ length: count }, () => word).join(' ');

async function fixture(t, embeddingExtra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'source-memory-span-rechunk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gguf = join(dir, 'fiction.gguf');
  await writeFile(gguf, ggufTokenizerFile(fictionalVocabulary(), { context: 4096 }));
  const spec = await readGgufTokenizer(gguf);
  const blob = `sha256:${createHash('sha256').update(await readFile(gguf)).digest('hex')}`;
  const verified = { [spec.sha256]: { model: 'embeddinggemma', served_blob: blob, render: RENDER_CONTRACT, serving_revision: 'rev-1',
    context: 2048, parity_evidence_sha256: 'e'.repeat(64) } };
  const embedding = { url: 'http://127.0.0.1:9/v1/embeddings', model: 'embeddinggemma', dimensions: 2, ollama_context_revision: 'rev-1',
    tokenizer: { gguf, sha256: spec.sha256 }, ...embeddingExtra };
  return { policy: chunkPolicy({ embedding }, verified), counter: sentencePiece(spec) };
}

test('a stored over-cap span is re-derived into pieces that cover it exactly, within both limits, at offsets into the entry', async t => {
  const { policy, counter } = await fixture(t);
  // Awkward boundaries: combining marks, emoji and CJK inside the span.
  const entryText = `A short preface. ${words(1500)} e\u0301e\u0301 \u{1F469}\u200D\u{1F4BB} ${words(1400, 'cd')} \u65e5\u672c\u8a9e ${words(300)} A short postscript.`;
  const start = entryText.indexOf('abcd');
  const end = entryText.indexOf(' A short postscript.');
  const pieces = await rechunkSpan({ entryText, entryId: 'e1', role: 'assistant', start, end, policy });
  assert.ok(pieces.length >= 3);
  assert.equal(pieces[0].start, start);
  assert.equal(Math.max(...pieces.map(piece => piece.end)), end);
  let reached = start;
  for (const piece of pieces) {
    assert.ok(piece.start <= reached, 'no hole');
    reached = Math.max(reached, piece.end);
    assert.equal(entryText.slice(piece.start, piece.end), piece.text, 'the entry\'s own text at its offsets');
    assert.ok(piece.token_count <= policy.descriptor.token_cap && counter.count(piece.text) === piece.token_count);
    assert.ok(Buffer.byteLength(piece.text) <= CHUNK_MAX_BYTES);
  }
  // A span already within the cap comes back as itself.
  const small = await rechunkSpan({ entryText, entryId: 'e1', role: 'assistant', start: 0, end: 16, policy });
  assert.deepEqual(small.map(({ start: s, end: e, text }) => [s, e, text]), [[0, 16, 'A short preface.']]);
});

test('a span that is not an exact in-bounds slice on code-point boundaries, or an unverified or legacy policy, is refused', async t => {
  const { policy } = await fixture(t);
  const entryText = `before \u{1F469} after ${words(20)}`;
  const split = entryText.indexOf('\u{1F469}') + 1;
  for (const [span, why] of [[{ start: 5, end: 5 }, 'empty'], [{ start: -1, end: 4 }, 'negative'], [{ start: 0, end: entryText.length + 1 }, 'past the end'],
    [{ start: split, end: entryText.length }, 'split surrogate start'], [{ start: 0, end: split }, 'split surrogate end'], [{ start: 0.5, end: 4 }, 'fractional']]) {
    await assert.rejects(rechunkSpan({ entryText, entryId: 'e', role: 'user', policy, ...span }), { code: 'span_rechunk_invalid_span' }, why);
  }
  await assert.rejects(rechunkSpan({ entryText, entryId: 'e', role: 'user', start: 0, end: 6, policy: chunkPolicy({}) }), { code: 'span_rechunk_tokenizer_unverified' });
  const unverified = chunkPolicy({ embedding: { url: 'http://127.0.0.1:9/v1/embeddings', model: 'embeddinggemma', dimensions: 2, tokenizer: { gguf: '/nonexistent', sha256: 'f'.repeat(64) } } });
  await assert.rejects(rechunkSpan({ entryText, entryId: 'e', role: 'user', start: 0, end: 6, policy: unverified }), { code: 'span_rechunk_tokenizer_unverified' });
});

test('a span with an unsplittable unit over the cap is refused as incomplete coverage, never clipped', async t => {
  const { policy } = await fixture(t, { chunk_token_cap: 64 });
  // One 200-character word: more than 64 fictional tokens and no word boundary to split at.
  const entryText = `x ${'y'.repeat(200)} x`;
  await assert.rejects(rechunkSpan({ entryText, entryId: 'e', role: 'user', start: 0, end: entryText.length, policy }), { code: 'span_rechunk_coverage_incomplete' });
});
