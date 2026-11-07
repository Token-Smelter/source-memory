import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const zoned = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value));

/** Validate the pinned source, active ancestry and the real Pi builder without returning source content. */
export function verifyChronologicalCheckpoint({ bytes, proof, availability, pi }) {
  if (!Buffer.isBuffer(bytes) || !proof || !Array.isArray(availability) || typeof pi?.buildContextEntries !== 'function'
    || typeof pi?.buildSessionContext !== 'function' || sha(bytes) !== proof.source_sha256
    || !Number.isSafeInteger(proof.snapshot_prefix_length_bytes) || proof.snapshot_prefix_length_bytes < 1
    || proof.snapshot_prefix_length_bytes > bytes.length || proof.checkpoint_line_byte_end_exclusive !== proof.snapshot_prefix_length_bytes
    || !Number.isSafeInteger(proof.checkpoint_line_byte_start) || proof.checkpoint_line_byte_start < 0
    || proof.checkpoint_line_byte_start >= proof.snapshot_prefix_length_bytes || !zoned(proof.query_time)
    || !zoned(proof.through_availability_time) || Date.parse(proof.through_availability_time) > Date.parse(proof.query_time)) throw fail('checkpoint_invalid');
  const end = proof.snapshot_prefix_length_bytes;
  if (bytes[end - 1] !== 10 || (proof.checkpoint_line_byte_start > 0 && bytes[proof.checkpoint_line_byte_start - 1] !== 10)
    || sha(bytes.subarray(0, end)) !== proof.snapshot_prefix_sha256) throw fail('checkpoint_prefix_mismatch');
  let full, prefix, last;
  try {
    const parse = data => data.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    full = parse(bytes);
    prefix = parse(bytes.subarray(0, end));
    last = JSON.parse(bytes.subarray(proof.checkpoint_line_byte_start, end).toString('utf8'));
  } catch { throw fail('source_invalid'); }
  if (full[0]?.type !== 'session' || prefix[0]?.type !== 'session' || last?.id !== proof.through_entry_id
    || prefix.at(-1)?.id !== proof.through_entry_id || !Array.isArray(proof.context_entry_ids)) throw fail('checkpoint_invalid');
  const rows = prefix.slice(1), all = full.slice(1);
  const byId = new Map();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || byId.has(row.id) || !Object.hasOwn(row, 'parentId')) throw fail('source_invalid');
    byId.set(row.id, row);
  }
  const ancestry = [];
  const seen = new Set();
  for (let id = proof.through_entry_id; id;) {
    const row = byId.get(id);
    if (!row || seen.has(id)) throw fail('ancestry_invalid');
    if (['compaction', 'branch_summary'].includes(row.type)) throw fail('source_boundary_unresolved');
    seen.add(id); ancestry.unshift(row); id = row.parentId;
  }
  if (ancestry.length !== proof.ancestry_entry_count || proof.compaction_status !== 'none_in_context') throw fail('ancestry_invalid');
  const metadata = new Map();
  for (const row of availability) {
    if (row.source_key !== proof.source_key) continue;
    if (metadata.has(row.entry_id)) throw fail('availability_invalid');
    metadata.set(row.entry_id, row);
  }
  let previousTime = -Infinity;
  for (const entry of ancestry) {
    const row = metadata.get(entry.id);
    if (!row || row.parent_entry_id !== entry.parentId || row.availability_status !== 'known_eligible_own_source_actor'
      || row.context_status !== 'provisionally_eligible_own_actor' || !zoned(entry.timestamp) || !zoned(row.event_time)
      || !zoned(row.availability_time) || Date.parse(entry.timestamp) !== Date.parse(row.event_time)
      || Date.parse(row.availability_time) < Date.parse(row.event_time) || Date.parse(row.availability_time) < previousTime
      || Date.parse(row.availability_time) > Date.parse(proof.through_availability_time)) throw fail('availability_unproven');
    previousTime = Date.parse(row.availability_time);
  }
  if (previousTime !== Date.parse(proof.through_availability_time)) throw fail('availability_unproven');
  if (metadata.get(proof.through_entry_id)?.context_ancestry_sha256 !== proof.ancestry_sha256) throw fail('ancestry_invalid');
  const contextIds = source => pi.buildContextEntries(source, proof.through_entry_id).filter(entry => entry.id).map(entry => entry.id);
  const prefixIds = contextIds(rows), fullIds = contextIds(all);
  const prefixMessages = pi.buildSessionContext(rows, proof.through_entry_id).messages;
  const fullMessages = pi.buildSessionContext(all, proof.through_entry_id).messages;
  if (!Array.isArray(prefixMessages) || !Array.isArray(fullMessages) || prefixMessages.length !== proof.pi_context_message_count
    || sha(JSON.stringify(prefixIds)) !== proof.context_entry_ids_sha256 || sha(JSON.stringify(prefixMessages)) !== proof.context_messages_sha256
    || JSON.stringify(prefixIds) !== JSON.stringify(proof.context_entry_ids) || JSON.stringify(prefixIds) !== JSON.stringify(fullIds)
    || sha(JSON.stringify(fullMessages)) !== proof.context_messages_sha256) throw fail('pi_context_mismatch');
  return { source_key: proof.source_key, through_entry_id: proof.through_entry_id, source_sha256: proof.source_sha256,
    prefix_sha256: proof.snapshot_prefix_sha256, context_entry_ids_sha256: proof.context_entry_ids_sha256,
    context_messages_sha256: proof.context_messages_sha256, ancestry_sha256: proof.ancestry_sha256,
    query_time: proof.query_time, through_availability_time: proof.through_availability_time, context_count: prefixIds.length };
}
