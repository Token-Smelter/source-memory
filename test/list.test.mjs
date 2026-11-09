import assert from 'node:assert/strict';
import test from 'node:test';
import { Memory } from '../src/memory.mjs';
import { selection } from '../src/store.mjs';

const order = (a, b) => (a < b) - (a > b);

// A fake listPage with the store's contract: the selection's matching rows, newest first by (at, uid) in code-unit order,
// strictly after `after`, at most `limit`. Filters are applied to parsed fields; the integration suite covers the Cypher.
function fakeStore(rows) {
  const calls = [];
  return { calls, async listPage(target, { turns, records, kind, status, source, conversation, after, limit }) {
    calls.push({ target, turns, records, kind, status, source, conversation, after, limit });
    const sel = selection(target);
    const keys = key => (source === null || key.source === source) && (conversation === null || key.conversation_id === conversation);
    return rows.filter(row => sel.owns(row.scope) && (row.type === 'turn' ? turns && keys(row.properties)
      : records && (kind === null || JSON.parse(row.body).kind === kind) && (status === null || JSON.parse(row.body).status === status)
        && ((source === null && conversation === null) || row.evidence.some(keys))))
      .filter(row => !after || row.at < after.at || (row.at === after.at && row.uid < after.uid))
      .sort((a, b) => order(a.at, b.at) || order(a.uid, b.uid)).slice(0, limit);
  } };
}

const turnRow = (scope, uid, at, source, conversation, extra = {}) => ({ type: 'turn', scope, uid, at, untimed: false, entry_count: 2,
  header: JSON.stringify({ source, conversation_id: conversation, turn_id: uid, parent_turn_id: null, occurred_at: null }),
  properties: { source, conversation_id: conversation, turn_id: uid, parent_turn_id: null }, body: null, ...extra });
const recordRow = (scope, uid, at, record, evidence = [{ source: 'fiction', conversation_id: 'c1' }]) => ({ type: 'record', scope, uid, at,
  untimed: false, header: null, entry_count: null, properties: null, body: JSON.stringify({ id: uid, kind: 'decision', status: 'proposed', text: 't',
    attribution: 'a', evidence: [{ turn: 'turn_x', entry_id: 'e', start: 0, end: 1 }], ...record }), evidence });

const rows = [
  turnRow('acme', 'turn_a', '2026-01-01T00:00:01Z', 'fiction', 'c1'),
  turnRow('acme/x', 'turn_b', '2026-01-01T00:00:02Z', 'fiction', 'c2'),
  recordRow('acme/x', 'r1', '2026-01-01T00:00:03Z', {}),
  recordRow('acme/x', 'r2', '2026-01-01T00:00:03Z', { kind: 'episode', status: 'accepted' }, [{ source: 'fiction', conversation_id: 'c2' }]),
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

test('a subtree walk returns every member item once, newest first, ties by uid, one store query per page', async () => {
  const store = fakeStore(rows);
  const pages = await walk(memory(store), 'acme/**', { limit: 2 });
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), ['r3', 'r2', 'r1', 'turn_b', 'turn_a', 'turn_old']);
  assert.ok(pages.every(page => page.kind === 'list' && page.scope === 'acme/**' && page.order === 'stored_desc'));
  assert.equal(store.calls.length, pages.length);
  assert.ok(store.calls.every(call => call.limit === 2));
  assert.equal(pages.flatMap(page => page.items).find(item => item.id === 'turn_old').stored_at, null, 'a node without created_at sorts oldest');
});

test('turn items are bounded headers preferring node properties, and record items carry their own fields', async () => {
  const page = await memory().list('acme', {});
  assert.deepEqual(page.items[0], { kind: 'turn', scope: 'acme', id: 'turn_a', source: 'fiction', conversation_id: 'c1', turn_id: 'turn_a',
    parent_turn_id: null, occurred_at: null, stored_at: '2026-01-01T00:00:01Z', entry_count: 2 });
  const foreign = fakeStore([turnRow('acme', 'turn_f', '2026-01-01T00:00:01Z', 'fiction', 'c1', { header: 'not json}' })]);
  assert.deepEqual((await memory(foreign).list('acme', {})).items[0].conversation_id, 'c1', 'an unparseable body falls back to properties');
  const record = (await memory().list('acme/x', { kind: 'decision' })).items[0];
  assert.deepEqual(Object.keys(record), ['kind', 'scope', 'id', 'record_kind', 'status', 'text', 'attribution', 'evidence', 'stored_at']);
});

test('filters reach the store and select by Memory fields only', async () => {
  const ids = async input => (await memory().list('acme/**', input)).items.map(item => item.id);
  assert.deepEqual(await ids({ kind: 'turn' }), ['turn_b', 'turn_a', 'turn_old']);
  assert.deepEqual(await ids({ kind: 'episode' }), ['r2']);
  assert.deepEqual(await ids({ status: 'proposed' }), ['r3', 'r1']);
  assert.deepEqual(await ids({ conversation_id: 'c2' }), ['r2', 'turn_b']);
  assert.deepEqual(await ids({ source: 'fiction', conversation_id: 'c1', kind: 'turn' }), ['turn_a', 'turn_old']);
  const store = fakeStore(rows);
  await memory(store).list('acme/**', { status: 'accepted', source: 's' });
  assert.deepEqual([store.calls[0].turns, store.calls[0].records, store.calls[0].status, store.calls[0].source], [false, true, 'accepted', 's']);
});

test('an item larger than max_bytes alone becomes a stub and the walk moves past it; otherwise a page stops before it', async () => {
  const pages = await walk(memory(), 'acme/**', { max_bytes: 4096, limit: 1 });
  assert.deepEqual(pages[0].items, [{ kind: 'record', scope: 'acme/y', id: 'r3', stored_at: '2026-01-01T00:00:04Z',
    bytes: pages[0].items[0].bytes, content_omitted: 'max_bytes' }]);
  assert.ok(pages[0].items[0].bytes > 4096);
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), ['r3', 'r2', 'r1', 'turn_b', 'turn_a', 'turn_old']);
  const size = pages[0].items[0].bytes;
  const exact = await memory().list('acme/**', { max_bytes: size + 2, kind: 'decision', limit: 1 });
  assert.equal(exact.items[0].content_omitted, undefined, 'an item exactly filling max_bytes with its brackets is listed whole');
  const stopped = await memory().list('acme/**', { max_bytes: size + 50, kind: 'decision' });
  assert.deepEqual([stopped.items.map(item => item.id), (await memory().list('acme/**', { max_bytes: size + 50, kind: 'decision', cursor: stopped.next_cursor }))
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
  const binding = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString()).q;
  const forged = Buffer.from(JSON.stringify({ v: 1, q: binding, at: 'not-a-datetime', uid: 'turn_a' })).toString('base64url');
  for (const input of [{ cursor: 'not-a-cursor' }, { cursor: forged }, { limit: 0 }, { limit: 65 }, { max_bytes: 4095 }, { since: 'x' },
    { kind: 'turn', status: 'accepted' }]) await assert.rejects(memory(untouched).list('acme/**', input), { code: 'invalid_input' }, JSON.stringify(input));
  await assert.rejects(memory(untouched).list('acme/**', { kind: 'task' }), { code: 'invalid_kind' });
  await assert.rejects(memory(untouched).list('acme/**', { status: 'final' }), { code: 'invalid_status' });
  await assert.rejects(memory(untouched).list('other', {}), { code: 'scope_denied' });
  await assert.rejects(new Memory({ scopes: { read: ['acme'] } }, untouched).list('acme/**', {}), { code: 'scope_denied' });
  assert.equal(untouched.calls.length, 0);
  for (const at of ['2026-11-09T21:00:00.123Z', '2026-11-09T21:00Z', '0001-01-01T00:00Z', '2026-11-09T21:00:00.123456789+01:00[Europe/Paris]']) {
    const cursor = Buffer.from(JSON.stringify({ v: 1, q: binding, at, uid: 'turn_a' })).toString('base64url');
    await memory().list('acme/**', { limit: 1, cursor });
  }
});
