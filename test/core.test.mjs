import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorize, canonical, chunkEntries, cosine, evidenceSpans, fuse, identity,
  lexicalQuery, normalizeEnrichment, normalizeTurn, sourceExcerpt, validateVector,
} from '../src/core.mjs';

const turn = () => normalizeTurn({ source: 'fixture', conversation_id: 'chat', turn_id: '1',
  entries: [{ id: 'u1', role: 'user', text: 'Keep the original words. 🪄 No paraphrasing.' }] });

test('source normalization preserves exact text and attribution', () => {
  assert.deepEqual(turn().entries[0], { id: 'u1', role: 'user', text: 'Keep the original words. 🪄 No paraphrasing.', occurred_at: null });
});

test('chunks retain entry roles, exact offsets, overlap and final short text', () => {
  const source = normalizeTurn({ source: 'fixture', conversation_id: 'chat', turn_id: '1', entries: [
    { id: 'a', role: 'assistant', text: 'zero one two three four five six seven eight nine ten' },
    { id: 'b', role: 'user', text: 'a second entry' },
  ] });
  assert.deepEqual(chunkEntries(source, 8, 2).map(chunk => [chunk.entry_id, chunk.role, chunk.start, chunk.end, chunk.text]), [
    ['a', 'assistant', 0, 38, 'zero one two three four five six seven'],
    ['a', 'assistant', 29, 53, 'six seven eight nine ten'],
    ['b', 'user', 0, 14, 'a second entry'],
  ]);
});

test('invalid overlap is rejected instead of looping', () => {
  assert.throws(() => chunkEntries(turn(), 8, 8), { code: 'invalid_input' });
});

test('source identity differs across durable owners', () => {
  assert.notEqual(identity('turn', 'a', 'source', 'chat', '1'), identity('turn', 'b', 'source', 'chat', '1'));
});

test('canonical content ignores object key order but retains array order', () => {
  assert.equal(canonical({ b: [2, 1], a: 1 }), canonical({ a: 1, b: [2, 1] }));
});

test('a denied scope never becomes readable through a selector', () => {
  assert.throws(() => authorize({ scopes: { read: ['allowed'], write: [] } }, 'foreign'), { code: 'scope_denied' });
});

test('evidence resolves from original source instead of a model quotation', () => {
  assert.equal(sourceExcerpt(turn(), { turn: 'turn1', entry_id: 'u1', start: 0, end: 24 }).text, 'Keep the original words.');
});

test('evidence cannot split a surrogate pair', () => {
  assert.throws(() => sourceExcerpt(turn(), { turn: 'turn1', entry_id: 'u1', start: 25, end: 26 }), { code: 'invalid_evidence_span' });
});

test('a derived summary is not original evidence', () => {
  const source = turn();
  source.entries[0].role = 'derived';
  assert.throws(() => sourceExcerpt(source, { turn: 'turn1', entry_id: 'u1', start: 0, end: 4 }), { code: 'derived_is_not_original_evidence' });
});

test('evidence payload size is bounded before expansion', () => {
  assert.throws(() => evidenceSpans([{ turn: 't', entry_id: 'a', start: 0, end: 20000 }]), { code: 'evidence_too_large' });
});

test('record status defaults to proposed rather than accepted', () => {
  assert.equal(normalizeEnrichment({ records: [{ id: 'r', kind: 'decision', text: 'An idea', attribution: 'assistant',
    evidence: [{ turn: 't', entry_id: 'a', start: 0, end: 4 }] }], relations: [] }).records[0].status, 'proposed');
});

test('zero vectors cannot become semantic search evidence', () => {
  assert.throws(() => validateVector([0, 0], 2), { code: 'invalid_embedding' });
});

test('cosine remains finite for very large finite vectors', () => {
  assert.equal(cosine([1e300, 0], [1e300, 0]), 1);
});

test('rank fusion deduplicates a turn within each channel', () => {
  const hit = { kind: 'turn', id: 't', text: 'hello' };
  assert.deepEqual(fuse({ lexical: [hit, hit], semantic: [hit] }).map(item => [item.id, item.channels.length, item.score]), [['t', 2, 2 / 61]]);
});

test('lexical queries treat user syntax as literal terms', () => {
  assert.equal(lexicalQuery('auth:* OR scope:secret + login'), '"auth" OR "OR" OR "scope" OR "secret" OR "login"');
});
