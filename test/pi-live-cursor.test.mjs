import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createCursorStore } from '../pi-extension/cursor-store.mjs';
import { createLiveController, registerLiveMemory } from '../pi-extension/live.mjs';

const rows = readFileSync(new URL('./fixtures/pi-extension-steer.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse).slice(1);
const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, message: { role, content, ...(role === 'assistant' ? { stopReason: 'stop' } : {}) } });

async function privateDir(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-'));
  chmodSync(directory, 0o700);
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** A fictional persistent store with the real store's identity rules: a turn ID or record ID written twice is a replay. */
function fictionalStore() {
  const turns = new Map(), records = new Map();
  return { turns, records, ingests: [] };
}

function harness(directory, store, { distill = 'record', sessionKey = 'fiction-session', journalOptions = {} } = {}) {
  const journal = createCoverageJournal({ directory, sessionKey, effectIds: true, pidLock: true, ...journalOptions });
  const cursorStore = createCursorStore({ directory, sessionKey });
  const opened = [];
  const open = async () => {
    const memory = journal.track({
      async ingest(_scope, turn) {
        store.ingests.push({ turn_id: turn.turn_id, entries: turn.entries.map(row => row.id) });
        const replayed = store.turns.has(turn.turn_id);
        if (!replayed) store.turns.set(turn.turn_id, turn);
        return { id: `turn-${turn.turn_id}`, replayed };
      },
      async enrich(_scope, payload) {
        for (const row of payload.records) store.records.set(row.id, row);
        if (store.hangEnrich) return new Promise(() => {});
        return { records: payload.records.map(row => row.id) };
      },
      async recordPresence(_scope, ids) { return { present: ids.filter(id => store.records.has(id)), absent: ids.filter(id => !store.records.has(id)) }; },
    });
    const handle = { closed: false };
    opened.push(handle);
    return { conversation_id: 'fiction', scopes: ['private'], memory, close() { handle.closed = true; },
      distiller: { memory, async run({ turn, receipt }) {
        if (distill === 'abstain') return { status: 'complete', disposition: 'abstained' };
        if (typeof distill === 'function') return distill({ turn, receipt, memory });
        await memory.enrich('private', { records: [{ id: `record-${turn.turn_id}`, kind: 'observation' }] }, { trigger: receipt.id });
        return { status: 'complete', disposition: 'committed' };
      } } };
  };
  const controller = createLiveController({ journal, cursorStore, conversationId: 'fiction', open });
  return { journal, cursorStore, controller, opened, close: () => journal.close() };
}

test('a cursor save is atomic, private and leaves the previous cursor when the rename fails', () => privateDir(async directory => {
  let failRename = false;
  const store = createCursorStore({ directory, sessionKey: 'fiction', hooks: { beforeRename() { if (failRename) throw new Error('fictional crash'); } } });
  assert.equal(store.load(), null);
  store.save('a2', { intervalId: 'interval-1' });
  failRename = true;
  assert.throws(() => store.save('a3'), /cursor_save_failed/);
  writeFileSync(join(directory, `.cursor-left-${Date.now()}.tmp`), '{"partial":', { mode: 0o600 });
  assert.deepEqual([store.load().cursor, store.load().interval_id, statSync(store.path).mode & 0o777,
    readdirSync(directory).filter(name => name.startsWith('.cursor-') && !name.startsWith('.cursor-left')).length], ['a2', 'interval-1', 0o600, 0]);
}));

test('a tampered or foreign cursor file is refused rather than trusted', () => privateDir(async directory => {
  const store = createCursorStore({ directory, sessionKey: 'fiction' });
  store.save('a2');
  const value = JSON.parse(readFileSync(store.path, 'utf8'));
  writeFileSync(store.path, JSON.stringify({ ...value, cursor: 'a3' }), { mode: 0o600 });
  assert.throws(() => store.load(), /cursor_store_invalid/);
}));

test('consecutive settles cover disjoint suffixes and a restart resumes from the committed cursor', () => privateDir(async directory => {
  const store = fictionalStore();
  let live = harness(directory, store);
  const first = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  live.close();
  live = harness(directory, store);
  const second = await live.controller.settle({ leafId: 'a3', entries: rows });
  const third = await live.controller.settle({ leafId: 'a3', entries: rows });
  assert.deepEqual([first.status, second.status, third.status, store.ingests.map(row => row.entries), live.cursorStore.load().cursor],
    ['covered', 'covered', 'current', [['u1', 'a1', 't1', 'u2', 'a2'], ['u3', 'a3']], 'a3']);
  live.close();
}));

test('a failed cursor save does not widen the next interval over already covered source', () => privateDir(async directory => {
  const store = fictionalStore();
  let live = harness(directory, store);
  const save = live.cursorStore.save;
  live.cursorStore.save = () => { throw Object.assign(new Error('disk full'), { code: 'cursor_save_failed' }); };
  const first = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  live.cursorStore.save = save;
  live.close();
  live = harness(directory, store);
  assert.equal(live.cursorStore.load(), null);
  const second = await live.controller.settle({ leafId: 'a3', entries: rows });
  assert.deepEqual([first.results[0].cursor_save, second.status, store.ingests.map(row => row.entries), live.cursorStore.load().cursor],
    ['cursor_save_failed', 'covered', [['u1', 'a1', 't1', 'u2', 'a2'], ['u3', 'a3']], 'a3']);
  live.close();
}));

test('a crash mid-interval is reconciled by deterministic IDs and replayed under the same turn ID as a no-op ingest', () => privateDir(async directory => {
  const store = fictionalStore();
  store.hangEnrich = true;
  let live = harness(directory, store);
  void live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  await new Promise(resolve => setTimeout(resolve, 20));
  live.close();
  store.hangEnrich = false;
  live = harness(directory, store);
  assert.equal(live.journal.state().status, 'uncertain');
  const resumed = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  const journalRows = readFileSync(live.journal.path, 'utf8').trim().split('\n').map(JSON.parse);
  const reconcile = journalRows.find(row => row.type === 'reconcile');
  assert.deepEqual([resumed.status, resumed.reconciled.present, resumed.results.map(row => row.disposition),
    store.ingests.map(row => row.turn_id).every((id, _index, all) => id === all[0]), store.ingests.length, store.turns.size,
    reconcile.disposition, reconcile.evidence_ref.startsWith('live-reconcile/v1:'), live.cursorStore.load().cursor],
  ['current', [`record-${store.ingests[0].turn_id}`], ['committed'], true, 2, 1, 'failed', true, 'a2']);
  live.close();
}));

test('an unknown link application is never settled automatically', () => privateDir(async directory => {
  const store = fictionalStore();
  let live = harness(directory, store);
  const journal = live.journal;
  journal.begin({ cursor: null, through: 'a2' });
  const memory = journal.track({ async applyLinks() { throw new Error('timeout'); } });
  await assert.rejects(memory.applyLinks('token', {}), /write_uncertain/);
  journal.finish('failed');
  live.close();
  live = harness(directory, store);
  await assert.rejects(live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) }), /reconciliation_required/);
  assert.deepEqual([store.ingests.length, live.journal.state().status], [0, 'uncertain']);
  live.close();
}));

test('a transient distiller failure is retried for the same interval before the cursor moves on', () => privateDir(async directory => {
  const store = fictionalStore();
  let calls = 0;
  const live = harness(directory, store, { distill: async ({ turn, receipt, memory }) => {
    if (++calls === 1) throw Object.assign(new Error('provider'), { code: 'provider_unavailable' });
    await memory.enrich('private', { records: [{ id: `record-${turn.turn_id}` }] }, { trigger: receipt.id });
    return { status: 'complete', disposition: 'committed' };
  } });
  const failed = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  const resumed = await live.controller.settle({ leafId: 'a3', entries: rows });
  assert.deepEqual([failed.status, resumed.results.map(row => [row.disposition, row.cursor]), store.ingests.map(row => row.entries)],
    ['stopped', [['committed', 'a2'], ['committed', 'a3']], [['u1', 'a1', 't1', 'u2', 'a2'], ['u1', 'a1', 't1', 'u2', 'a2'], ['u3', 'a3']]]);
  assert.equal(new Set(store.ingests.slice(0, 2).map(row => row.turn_id)).size, 1);
  live.close();
}));

test('a gap past its retry limit blocks without another ingest', () => privateDir(async directory => {
  const store = fictionalStore();
  const live = harness(directory, store, { distill: async () => { throw Object.assign(new Error('provider'), { code: 'provider_unavailable' }); } });
  for (let i = 0; i < 4; i++) await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  const blocked = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  assert.deepEqual([blocked.status, blocked.code, store.ingests.length], ['blocked', 'retry_limit', 4]);
  live.close();
}));

test('an incomplete or already covered leaf is skipped without a journal row', () => privateDir(async directory => {
  const store = fictionalStore();
  const live = harness(directory, store);
  const skipped = await live.controller.settle({ leafId: 'a1', entries: rows.slice(0, 2) });
  assert.deepEqual([skipped.status, skipped.code, readFileSync(live.journal.path, 'utf8'), store.ingests.length], ['skipped', 'turn_incomplete', '', 0]);
  live.close();
}));

test('after a branch switch the saved cursor walks back to the shared ancestor and covers only the new branch', () => privateDir(async directory => {
  const store = fictionalStore();
  const tree = [message('u', null, 'user', 'Shared fictional root.'), message('a', 'u', 'assistant', 'Shared reply.'),
    message('ux', 'a', 'user', 'Branch X.'), message('x', 'ux', 'assistant', 'X.'),
    message('uy', 'a', 'user', 'Branch Y.'), message('y', 'uy', 'assistant', 'Y.')];
  const live = harness(directory, store);
  await live.controller.settle({ leafId: 'a', entries: tree });
  await live.controller.settle({ leafId: 'x', entries: tree });
  const switched = await live.controller.settle({ leafId: 'y', entries: tree });
  assert.deepEqual([switched.status, store.ingests.map(row => row.entries), live.cursorStore.load().cursor],
    ['covered', [['u', 'a'], ['ux', 'x'], ['uy', 'y']], 'y']);
  live.close();
}));

test('a cursor the journal never covered is refused', () => privateDir(async directory => {
  const store = fictionalStore();
  const live = harness(directory, store);
  live.cursorStore.save('a2');
  await assert.rejects(live.controller.settle({ leafId: 'a3', entries: rows }), /cursor_journal_mismatch/);
  assert.equal(store.ingests.length, 0);
  live.close();
}));

test('a dead owner lock is broken only by an opted-in pid lock', () => privateDir(async directory => {
  const first = createCoverageJournal({ directory, sessionKey: 'fiction', pidLock: true });
  const lock = first.path.replace(/\.jsonl$/, '.lock');
  first.close();
  writeFileSync(lock, '999999999\n', { mode: 0o600 });
  assert.throws(() => createCoverageJournal({ directory, sessionKey: 'fiction' }), /journal_locked/);
  writeFileSync(lock, '', { mode: 0o600 });
  assert.throws(() => createCoverageJournal({ directory, sessionKey: 'fiction', pidLock: true }), /journal_locked/);
  writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  assert.throws(() => createCoverageJournal({ directory, sessionKey: 'fiction', pidLock: true }), /journal_locked/);
  writeFileSync(lock, '999999999\n', { mode: 0o600 });
  const reopened = createCoverageJournal({ directory, sessionKey: 'fiction', pidLock: true });
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`);
  reopened.close();
}));

test('default journal rows carry no effect IDs and the default lock holds no owner', () => privateDir(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const lock = readFileSync(journal.path.replace(/\.jsonl$/, '.lock'), 'utf8');
  const memory = journal.track({ async enrich() { return { records: ['r'] }; } });
  journal.begin({ cursor: null, through: 'a' });
  await memory.enrich('private', { records: [{ id: 'r' }] }, { trigger: 't' });
  journal.finish('committed');
  const begun = readFileSync(journal.path, 'utf8').trim().split('\n').map(JSON.parse).find(row => row.type === 'effect_begin');
  assert.deepEqual([lock, Object.keys(begun).sort()], ['', ['effect', 'hash', 'id', 'method', 'previous', 'seq', 'type', 'version']]);
  journal.close();
}));

test('Memory process reports deterministic record presence only inside its scope', async () => {
  const { createMemoryHandlers } = await import('../pi-extension/memory-process.mjs');
  const memory = { store: { async getRecords(scope, ids) { return ids.filter(id => id === 'present').map(id => ({ id, scope })); } } };
  const handlers = createMemoryHandlers({ memory, scopes: ['private'] });
  assert.deepEqual(await handlers.recordPresence({ scope: 'private', ids: ['present', 'absent'] }), { present: ['present'], absent: ['absent'] });
  await assert.rejects(handlers.recordPresence({ scope: 'other', ids: ['present'] }), /scope_denied/);
  await assert.rejects(handlers.recordPresence({ scope: 'private', ids: [] }), /invalid_input/);
  handlers.close();
});

test('the live hook never throws into Pi and reports failures to onError', async () => {
  const hooks = new Map();
  const errors = [];
  registerLiveMemory({ on: (name, handler) => hooks.set(name, handler) }, { controllerFor: async () => null, onError: error => errors.push(error.message) });
  hooks.get('agent_settled')({}, { sessionManager: { getSessionId() { throw new Error('fictional manager failure'); } } });
  assert.deepEqual(errors, ['fictional manager failure']);
});
