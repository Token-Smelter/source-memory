import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceSpansForEntry } from '../src/evidence-spans.mjs';
import { createTurnTools } from '../pi-extension/core.mjs';

test('short source entries keep a single exact whole-entry label', () => {
  const entry = { id: 'small', role: 'user', text: 'short fiction' };
  assert.deepEqual(evidenceSpansForEntry(entry), { spans: [{ entry_id: 'small', start: 0, end: entry.text.length }], omissions: [] });
});

test('long source entries use only the retained whole chunk offsets', async () => {
  const entry = { id: 'large', role: 'user', text: 'x'.repeat(20000) };
  const chunks = [{ entry_id: 'large', start: 0, end: 8000, ordinal: 0 },
    { entry_id: 'large', start: 7000, end: 15000, ordinal: 1 }, { entry_id: 'large', start: 14000, end: 20000, ordinal: 2 }];
  const payloads = [];
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 'turn', entries: [entry] }, receipt: { id: 'retained-turn' }, sourceChunks: chunks,
    memory: { async enrich(_scope, payload) { payloads.push(payload); return {}; } } });
  await tools.record('observation', 'fiction', ['ref-000002']);
  assert.deepEqual(payloads[0].records[0].evidence, [{ turn: 'retained-turn', entry_id: 'large', start: 7000, end: 15000 }]);
});

test('a long source entry without retained chunks fails rather than inventing offsets', () => {
  assert.throws(() => evidenceSpansForEntry({ id: 'large', text: 'x'.repeat(16001) }), /evidence_chunks_unavailable/);
});

test('a chunk overlapping an image placeholder is omitted as a whole', () => {
  const entry = { id: 'large', text: 'x'.repeat(17000), uncitable_ranges: [{ start: 8000, end: 8100 }] };
  const chunks = [{ entry_id: 'large', start: 0, end: 9000, ordinal: 0 }, { entry_id: 'large', start: 9000, end: 17000, ordinal: 1 }];
  const result = evidenceSpansForEntry(entry, chunks);
  assert.deepEqual([result.spans, result.omissions[0].reason], [[{ entry_id: 'large', start: 9000, end: 17000 }], 'image_overlapping_chunk_not_citable']);
});
