import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyChronologicalCheckpoint } from '../pi-extension/chronology.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const rows = [{ type: 'session', id: 'fiction' },
  { type: 'message', id: 'u', parentId: null, timestamp: '2030-01-01T00:00:01Z', message: { role: 'user', content: 'fictional input' } },
  { type: 'message', id: 'a', parentId: 'u', timestamp: '2030-01-01T00:00:02Z', message: { role: 'assistant', content: 'fictional result' } },
  { type: 'message', id: 'future', parentId: 'a', timestamp: '2030-01-01T00:00:04Z', message: { role: 'user', content: 'future fiction' } }];
const sdk = { buildContextEntries(entries, leaf) {
  const map = new Map(entries.map(row => [row.id, row])); const result = [];
  for (let row = map.get(leaf); row; row = map.get(row.parentId)) result.unshift(row);
  return result;
}, buildSessionContext(entries, leaf) { return { messages: this.buildContextEntries(entries, leaf).map(row => row.message) }; } };
function fixture() {
  const lines = rows.map(row => JSON.stringify(row) + '\n');
  const bytes = Buffer.from(lines.join(''));
  const start = Buffer.byteLength(lines.slice(0, 2).join(''));
  const prefix = Buffer.from(lines.slice(0, 3).join(''));
  const entries = rows.slice(1, 3);
  const proof = { source_key: 'fiction', source_sha256: sha(bytes), snapshot_prefix_length_bytes: prefix.length,
    snapshot_prefix_sha256: sha(prefix), checkpoint_line_byte_start: start, checkpoint_line_byte_end_exclusive: prefix.length,
    through_entry_id: 'a', through_availability_time: '2030-01-01T00:00:02Z', query_time: '2030-01-01T00:00:03Z',
    context_entry_ids: ['u', 'a'], context_entry_ids_sha256: sha(JSON.stringify(['u', 'a'])),
    context_messages_sha256: sha(JSON.stringify(entries.map(row => row.message))), ancestry_entry_count: 2,
    pi_context_message_count: 2, ancestry_sha256: 'a'.repeat(64), compaction_status: 'none_in_context' };
  const availability = entries.map((row, index) => ({ source_key: 'fiction', entry_id: row.id, parent_entry_id: row.parentId,
    availability_status: 'known_eligible_own_source_actor', context_status: 'provisionally_eligible_own_actor',
    event_time: row.timestamp, availability_time: `2030-01-01T00:00:0${index + 1}Z`, context_ancestry_sha256: 'a'.repeat(64) }));
  return { bytes, proof, availability, pi: sdk };
}

test('pinned prefix and full Pi context agree without admitting future entries', () => {
  const result = verifyChronologicalCheckpoint(fixture());
  assert.deepEqual([result.through_entry_id, result.context_count], ['a', 2]);
});

test('unknown ordering is excluded even with a populated availability timestamp', () => {
  const data = fixture();
  data.availability[0].availability_status = 'unknown_order_excluded_primary';
  assert.throws(() => verifyChronologicalCheckpoint(data), /availability_unproven/);
});

test('a future-contaminated Pi context fails before any model call', () => {
  const data = fixture();
  data.pi = { ...sdk, buildSessionContext(entries, leaf) {
    return { messages: entries.length > 2 ? entries.map(row => row.message) : sdk.buildSessionContext(entries, leaf).messages };
  } };
  assert.throws(() => verifyChronologicalCheckpoint(data), /pi_context_mismatch/);
});
