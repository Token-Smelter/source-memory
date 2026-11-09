import assert from 'node:assert/strict';
import test from 'node:test';
import { Memory } from '../src/memory.mjs';
import { selection } from '../src/store.mjs';

// A fake listBatch with the store's contract: the selection's rows, newest first by (at, uid), strictly after `after`.
function fakeStore(rows) {
  const calls = [];
  return { calls, async listBatch(target, { turns, records, after, limit }) {
    calls.push({ target, turns, records, after, limit });
    const sel = selection(target);
    return rows.filter(row => sel.owns(row.scope) && (row.type === 'turn' ? turns : records))
      .filter(row => !after || row.at < after.at || (row.at === after.at && row.uid < after.uid))
      .sort((a, b) => b.at.localeCompare(a.at) || b.uid.localeCompare(a.uid)).slice(0, limit);
  } };
}

const turnRow = (scope, uid, at, source, conversation, extra = {}) => ({ type: 'turn', scope, uid, at, untimed: false, entry_count: 2,
  header: JSON.stringify({ source, conversation_id: conversation, turn_id: uid, parent_turn_id: null, occurred_at: null }), body: null, evidence: null, ...extra });
const recordRow = (scope, uid, at, record, evidence = [{ source: 'fiction', conversation_id: 'c1', header: null }]) => ({ type: 'record', scope, uid, at,
  untimed: false, header: null, entry_count: null, body: JSON.stringify({ id: uid, kind: 'decision', status: 'proposed', text: 't', attribution: 'a',
    evidence: [{ turn: 'turn_x', entry_id: 'e', start: 0, end: 1 }], ...record }), evidence });

const rows = [
  turnRow('acme', 'turn_a', '2026-01-01T00:00:01Z', 'fiction', 'c1'),
  turnRow('acme/x', 'turn_b', '2026-01-01T00:00:02Z', 'fiction', 'c2'),
  recordRow('acme/x', 'r1', '2026-01-01T00:00:03Z', {}),
  recordRow('acme/x', 'r2', '2026-01-01T00:00:03Z', { kind: 'episode', status: 'accepted' }, [{ source: 'fiction', conversation_id: 'c2', header: null }]),
  recordRow('acme/y', 'r3', '2026-01-01T00:00:04Z', { text: 'x'.repeat(6000) }),
  turnRow('acme/x y', 'turn_opaque', '2026-01-01T00:00:05Z', 'fiction', 'c1'),
  turnRow('other', 'turn_other', '2026-01-01T00:00:06Z', 'fiction', 'c1'),
  turnRow('acme', 'turn_old', '0001-01-01T00:00Z', 'fiction', 'c1', { untimed: true }),
];
const memory = (store = fakeStore(rows)) => new Memory({ scopes: { read: ['acme/**', 'acme'], write: [] } }, store);

async function walk(client, scope, input) {
  const pages = [];
  let cursor;
  do {
    const page = await client.list(scope, { ...input, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor);
  return pages;
}

test('a subtree walk returns every member item once, newest first, ties by uid, and stops on a null cursor', async () => {
  const pages = await walk(memory(), 'acme/**', { limit: 2 });
  const ids = pages.flatMap(page => page.items.map(item => item.id));
  assert.deepEqual(ids, ['r3', 'r2', 'r1', 'turn_b', 'turn_a', 'turn_old']);
  assert.ok(pages.every(page => page.kind === 'list' && page.scope === 'acme/**' && page.order === 'stored_desc'));
  assert.equal(pages.at(-1).next_cursor, null);
  const old = pages.flatMap(page => page.items).find(item => item.id === 'turn_old');
  assert.equal(old.stored_at, null, 'a node without created_at sorts oldest and says so');
});

test('turn items are fixed-size headers and record items carry their own fields', async () => {
  const page = await memory().list('acme', {});
  assert.deepEqual(page.items[0], { kind: 'turn', scope: 'acme', id: 'turn_a', source: 'fiction', conversation_id: 'c1', turn_id: 'turn_a',
    parent_turn_id: null, occurred_at: null, stored_at: '2026-01-01T00:00:01Z', entry_count: 2 });
  const record = (await memory().list('acme/x', { kind: 'decision' })).items[0];
  assert.deepEqual(Object.keys(record), ['kind', 'scope', 'id', 'record_kind', 'status', 'text', 'attribution', 'evidence', 'stored_at']);
});

test('filters use Memory fields only: kind, status, and source keys of a turn or a record\'s evidence', async () => {
  const ids = async input => (await memory().list('acme/**', input)).items.map(item => item.id);
  assert.deepEqual(await ids({ kind: 'turn' }), ['turn_b', 'turn_a', 'turn_old']);
  assert.deepEqual(await ids({ kind: 'episode' }), ['r2']);
  assert.deepEqual(await ids({ status: 'proposed' }), ['r3', 'r1']);
  assert.deepEqual(await ids({ conversation_id: 'c2' }), ['r2', 'turn_b']);
  assert.deepEqual(await ids({ source: 'fiction', conversation_id: 'c1', kind: 'turn' }), ['turn_a', 'turn_old']);
});

test('an item larger than max_bytes alone becomes a stub and the walk moves past it; otherwise a page stops before it', async () => {
  const pages = await walk(memory(), 'acme/**', { max_bytes: 4096, limit: 1 });
  assert.deepEqual(pages[0].items, [{ kind: 'record', scope: 'acme/y', id: 'r3', stored_at: '2026-01-01T00:00:04Z',
    bytes: pages[0].items[0].bytes, content_omitted: 'max_bytes' }]);
  assert.ok(pages[0].items[0].bytes > 4096);
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), ['r3', 'r2', 'r1', 'turn_b', 'turn_a', 'turn_old']);
  const tight = pages[0].items[0].bytes + 50;
  const stopped = await memory().list('acme/**', { max_bytes: tight, kind: 'decision' });
  assert.deepEqual([stopped.items.map(item => item.id), (await memory().list('acme/**', { max_bytes: tight, kind: 'decision', cursor: stopped.next_cursor }))
    .items.map(item => item.id)], [['r3'], ['r1']]);
  const wide = await memory().list('acme/**', { max_bytes: 8192, kind: 'decision' });
  assert.deepEqual(wide.items.map(item => item.id), ['r3', 'r1']);
  assert.ok(Buffer.byteLength(JSON.stringify(wide.items)) <= 8192);
});

test('a cursor resumes only the request that issued it, and inputs are validated before storage', async () => {
  const page = await memory().list('acme/**', { limit: 1 });
  await assert.rejects(memory().list('acme/**', { limit: 1, kind: 'turn', cursor: page.next_cursor }), { code: 'invalid_input' });
  await assert.rejects(memory().list('acme', { cursor: page.next_cursor }), { code: 'invalid_input' });
  const untouched = fakeStore(rows);
  for (const input of [{ cursor: 'not-a-cursor' }, { limit: 0 }, { limit: 65 }, { max_bytes: 4095 }, { since: 'x' }, { kind: 'turn', status: 'accepted' },
    { status: 'final' }]) await assert.rejects(memory(untouched).list('acme/**', input), { code: 'invalid_input' }, JSON.stringify(input));
  await assert.rejects(memory(untouched).list('acme/**', { kind: 'task' }), { code: 'invalid_kind' });
  await assert.rejects(memory(untouched).list('other', {}), { code: 'scope_denied' });
  await assert.rejects(new Memory({ scopes: { read: ['acme'] } }, untouched).list('acme/**', {}), { code: 'scope_denied' });
  assert.equal(untouched.calls.length, 0);
});

test('a filter that rejects whole batches keeps scanning until the selection ends', async () => {
  const many = Array.from({ length: 300 }, (_, index) => turnRow('acme', `turn_${String(index).padStart(3, '0')}`, `2026-01-02T00:00:00.${String(index).padStart(3, '0')}Z`, 'other', 'c9'));
  const store = fakeStore([...many, turnRow('acme', 'turn_target', '2026-01-01T00:00:00Z', 'fiction', 'c1')]);
  const page = await memory(store).list('acme', { source: 'fiction' });
  assert.deepEqual([page.items.map(item => item.id), page.next_cursor, store.calls.length], [['turn_target'], null, 3]);
});
