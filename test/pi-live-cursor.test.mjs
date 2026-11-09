import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { canonical, digest } from '../src/core.mjs';
import { Memory } from '../src/memory.mjs';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createCursorStore } from '../pi-extension/cursor-store.mjs';
import { admitAll, createLiveController, registerLiveMemory } from '../pi-extension/live.mjs';
import { ownerRecord } from '../pi-extension/owner-lock.mjs';
import { defaultJournalBytes } from './helpers/default-journal-script.mjs';

const exec = promisify(execFile);
const rows = readFileSync(new URL('./fixtures/pi-extension-steer.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse).slice(1);
const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, message: { role, content, ...(role === 'assistant' ? { stopReason: 'stop' } : {}) } });
const turnId = (cursor, through) => digest(['pi-memory-turn/v1', cursor, through]);

async function privateDir(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-'));
  chmodSync(directory, 0o700);
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** A fictional persistent store with the real store's identity rules: a turn ID or record ID written twice is a replay. */
function fictionalStore() {
  return { turns: new Map(), records: new Map(), ingests: [], hang: null };
}

function harness(directory, store, { distill = 'record', sessionKey = 'fiction-session' } = {}) {
  const journal = createCoverageJournal({ directory, sessionKey, effectIds: true, pidLock: true });
  const cursorStore = createCursorStore({ directory, sessionKey });
  const opened = [];
  const held = method => store.hang?.method === method ? (store.hang.entered(), new Promise(() => {})) : null;
  const open = async () => {
    const memory = journal.track({
      async ingest(_scope, turn) {
        store.ingests.push({ turn_id: turn.turn_id, entries: turn.entries.map(row => row.id) });
        const replayed = store.turns.has(turn.turn_id);
        if (!replayed) store.turns.set(turn.turn_id, turn);
        return held('ingest') ?? { id: `turn-${turn.turn_id}`, replayed };
      },
      async enrich(_scope, payload) {
        for (const row of payload.records) store.records.set(row.id, row);
        return held('enrich') ?? { records: payload.records.map(row => row.id) };
      },
      async beginOutcome() { return { token: 'outcome-token', proposal: { requires_review: false } }; },
      async applyOutcome() { return held('applyOutcome') ?? { status: 'written', records: [] }; },
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
  const controller = createLiveController({ journal, cursorStore, conversationId: 'fiction', open, gate: admitAll });
  return { journal, cursorStore, controller, opened, close: () => journal.close() };
}

const hangOn = (store, method) => new Promise(resolve => { store.hang = { method, entered: resolve }; });
const journalRows = journal => readFileSync(journal.path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('a cursor save is atomic, private and leaves the previous cursor when the rename fails', () => privateDir(async directory => {
  let failRename = false;
  const store = createCursorStore({ directory, sessionKey: 'fiction', hooks: { beforeRename() { if (failRename) throw new Error('fictional crash'); } } });
  assert.equal(store.load(), null);
  store.save('a2', { intervalId: 'interval-1' });
  failRename = true;
  assert.throws(() => store.save('a3'), /cursor_save_failed/);
  assert.deepEqual([store.load().cursor, store.load().interval_id, statSync(store.path).mode & 0o777,
    readdirSync(directory).filter(name => name.endsWith('.tmp')).length], ['a2', 'interval-1', 0o600, 0]);
}));

test('a leftover cursor temp file is swept and a corrupted cursor file is refused', () => privateDir(async directory => {
  const store = createCursorStore({ directory, sessionKey: 'fiction' });
  store.save('a2');
  const leftover = join(directory, store.path.split('/').at(-1).replace(/^cursor-(.*)\.json$/, '.cursor-$1-crash.tmp'));
  writeFileSync(leftover, '{"partial":', { mode: 0o600 });
  createCursorStore({ directory, sessionKey: 'fiction' });
  const value = JSON.parse(readFileSync(store.path, 'utf8'));
  writeFileSync(store.path, JSON.stringify({ ...value, cursor: 'a3' }), { mode: 0o600 });
  assert.equal(existsSync(leftover), false);
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

test('a crash during a derived write is reconciled by record ID and replayed under the same turn ID as a no-op ingest', () => privateDir(async directory => {
  const store = fictionalStore();
  let live = harness(directory, store);
  const entered = hangOn(store, 'enrich');
  void live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  await entered;
  live.close();
  store.hang = null;
  live = harness(directory, store);
  assert.equal(live.journal.state().status, 'uncertain');
  const resumed = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  const reconcile = journalRows(live.journal).find(row => row.type === 'reconcile');
  const sha = reconcile.evidence_ref.split(':')[1];
  const evidence = JSON.parse(readFileSync(join(directory, `reconcile-${sha}.json`), 'utf8'));
  assert.deepEqual([resumed.status, resumed.reconciled.present, resumed.results.map(row => row.disposition), store.ingests.map(row => row.turn_id),
    store.turns.size, reconcile.disposition, digest(evidence) === sha, canonical(evidence) === readFileSync(join(directory, `reconcile-${sha}.json`), 'utf8'),
    live.cursorStore.load().cursor],
  ['current', [`record-${turnId(null, 'a2')}`], ['committed'], [turnId(null, 'a2'), turnId(null, 'a2')], 1, 'failed', true, true, 'a2']);
  live.close();
}));

test('a crash during ingest is settled by replaying the deterministic turn', () => privateDir(async directory => {
  const store = fictionalStore();
  let live = harness(directory, store);
  const entered = hangOn(store, 'ingest');
  void live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  await entered;
  live.close();
  store.hang = null;
  live = harness(directory, store);
  const resumed = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  assert.deepEqual([resumed.status, resumed.reconciled.ingest, store.turns.size, store.ingests.length], ['current', 'idempotent_replay_by_turn_id', 1, 2]);
  live.close();
}));

test('a split outcome and any link application are left to an operator', () => privateDir(async directory => {
  for (const method of ['applyOutcome', 'applyLinks']) {
    const store = fictionalStore();
    const sessionKey = `fiction-${method}`;
    let live = harness(directory, store, { sessionKey });
    const journal = live.journal;
    journal.begin({ cursor: null, through: 'a2' });
    const memory = journal.track({ async beginOutcome() { return { token: 't' }; }, async applyOutcome() { throw new Error('timeout'); },
      async applyLinks() { throw new Error('timeout'); } });
    if (method === 'applyOutcome') {
      await memory.beginOutcome('private', 'turn', { id: 'outcome-x' }, { id: 'action-x' }, null);
      store.records.set('outcome-x', {});
      await assert.rejects(memory.applyOutcome('private', 't', null), /write_uncertain/);
    } else await assert.rejects(memory.applyLinks('token', {}), /write_uncertain/);
    journal.finish('failed');
    live.close();
    live = harness(directory, store, { sessionKey });
    const blocked = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
    assert.deepEqual([method, blocked.status, blocked.code, store.ingests.length, live.journal.state().status], [method, 'blocked', 'reconciliation_required', 0, 'uncertain']);
    live.close();
  }
}));

test('a failure after confirmed records is reconciled with those records as evidence and retried', () => privateDir(async directory => {
  const store = fictionalStore();
  let calls = 0;
  const live = harness(directory, store, { distill: async ({ turn, receipt, memory }) => {
    await memory.enrich('private', { records: [{ id: `record-${turn.turn_id}-${++calls}` }] }, { trigger: receipt.id });
    if (calls === 1) throw Object.assign(new Error('provider'), { code: 'provider_unavailable' });
    return { status: 'complete', disposition: 'committed' };
  } });
  const failed = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  const resumed = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  assert.deepEqual([failed.status, resumed.status, resumed.reconciled.confirmed.find(row => row.method === 'enrich').ids, store.turns.size],
    ['stopped', 'current', [`record-${turnId(null, 'a2')}-1`], 1]);
  live.close();
}));

test('a transient distiller failure is retried for the same interval before the cursor moves on', () => privateDir(async directory => {
  const store = fictionalStore();
  let calls = 0;
  const live = harness(directory, store, { distill: async () => {
    if (++calls === 1) throw Object.assign(new Error('provider'), { code: 'provider_unavailable' });
    return { status: 'complete', disposition: 'abstained' };
  } });
  const failed = await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  const resumed = await live.controller.settle({ leafId: 'a3', entries: rows });
  assert.deepEqual([failed.status, resumed.results.map(row => [row.disposition, row.cursor]), store.ingests.map(row => row.turn_id)],
    ['stopped', [['abstained', 'a2'], ['abstained', 'a3']], [turnId(null, 'a2'), turnId(null, 'a2'), turnId('a2', 'a3')]]);
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

test('an incomplete or unknown leaf is skipped without a journal row or cursor change', () => privateDir(async directory => {
  const store = fictionalStore();
  const live = harness(directory, store);
  const incomplete = await live.controller.settle({ leafId: 'a1', entries: rows.slice(0, 2) });
  const unknown = await live.controller.settle({ leafId: 'missing', entries: rows });
  assert.deepEqual([incomplete.status, incomplete.code, unknown.code, readFileSync(live.journal.path, 'utf8'), store.ingests.length, live.cursorStore.load()],
    ['skipped', 'turn_incomplete', 'source_unavailable', '', 0, null]);
  live.close();
}));

const tree = [message('u', null, 'user', 'Shared fictional root.'), message('a', 'u', 'assistant', 'Shared reply.'),
  message('ux', 'a', 'user', 'Branch X.'), message('x', 'ux', 'assistant', 'X.'),
  message('uy', 'a', 'user', 'Branch Y.'), message('y', 'uy', 'assistant', 'Y.')];

test('after a branch switch only the new branch suffix after the shared ancestor is covered', () => privateDir(async directory => {
  const store = fictionalStore();
  const live = harness(directory, store);
  await live.controller.settle({ leafId: 'a', entries: tree });
  await live.controller.settle({ leafId: 'x', entries: tree });
  const switched = await live.controller.settle({ leafId: 'y', entries: tree });
  assert.deepEqual([switched.status, store.ingests.map(row => row.entries), live.cursorStore.load().cursor], ['covered', [['u', 'a'], ['ux', 'x'], ['uy', 'y']], 'y']);
  live.close();
}));

test('a fork inside one covered interval never ingests the shared entries again', () => privateDir(async directory => {
  const store = fictionalStore();
  const live = harness(directory, store);
  const entries = [...tree.slice(0, 4), message('ub', 'u', 'user', 'Fork after the root.'), message('b', 'ub', 'assistant', 'B.')];
  await live.controller.settle({ leafId: 'x', entries });
  const forked = await live.controller.settle({ leafId: 'b', entries });
  assert.deepEqual([forked.status, store.ingests.map(row => row.entries), store.ingests[1].turn_id], ['covered', [['u', 'a', 'ux', 'x'], ['ub', 'b']], turnId('u', 'b')]);
  live.close();
}));

test('a leaf inside the last covered interval is current and the next suffix starts after that interval', () => privateDir(async directory => {
  const store = fictionalStore();
  const live = harness(directory, store);
  await live.controller.settle({ leafId: 'a2', entries: rows.slice(0, 5) });
  const inside = await live.controller.settle({ leafId: 'a1', entries: rows });
  const next = await live.controller.settle({ leafId: 'a3', entries: rows });
  assert.deepEqual([inside.status, next.status, store.ingests.map(row => row.entries)], ['current', 'covered', [['u1', 'a1', 't1', 'u2', 'a2'], ['u3', 'a3']]]);
  live.close();
}));

test('a gap on an abandoned branch is retried where it still validates, then the new branch is covered', () => privateDir(async directory => {
  const store = fictionalStore();
  let calls = 0;
  const live = harness(directory, store, { distill: async () => {
    if (++calls === 2) throw Object.assign(new Error('provider'), { code: 'provider_unavailable' });
    return { status: 'complete', disposition: 'abstained' };
  } });
  await live.controller.settle({ leafId: 'a', entries: tree });
  await live.controller.settle({ leafId: 'x', entries: tree });
  const switched = await live.controller.settle({ leafId: 'y', entries: tree });
  assert.deepEqual([switched.status, switched.results.map(row => row.disposition), store.ingests.map(row => row.entries)],
    ['covered', ['abstained', 'abstained'], [['u', 'a'], ['ux', 'x'], ['ux', 'x'], ['uy', 'y']]]);
  assert.equal(store.ingests[1].turn_id, store.ingests[2].turn_id);
  live.close();
}));

test('a gap whose source is gone blocks every later interval', () => privateDir(async directory => {
  const store = fictionalStore();
  const live = harness(directory, store, { distill: async () => { throw Object.assign(new Error('provider'), { code: 'provider_unavailable' }); } });
  await live.controller.settle({ leafId: 'x', entries: tree });
  const blocked = await live.controller.settle({ leafId: 'y', entries: tree.filter(row => !['ux', 'x'].includes(row.id)) });
  assert.deepEqual([blocked.status, blocked.code, store.ingests.length], ['blocked', 'coverage_gap_unreachable', 1]);
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

test('the controller requires a journal opened with effect IDs and an owner lock', () => privateDir(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  assert.throws(() => createLiveController({ journal, cursorStore: createCursorStore({ directory, sessionKey: 'fiction' }), conversationId: 'fiction', gate: admitAll,
    open: async () => ({}) }), /controller_invalid/);
  journal.close();
}));

test('an owner lock is taken over only from a provably gone owner on this host', () => privateDir(async directory => {
  const first = createCoverageJournal({ directory, sessionKey: 'fiction', pidLock: true });
  const lock = first.path.replace(/\.jsonl$/, '.lock');
  first.close();
  const self = ownerRecord();
  const parent = ownerRecord(process.ppid);
  const attempt = (owner, options = { pidLock: true }) => {
    writeFileSync(lock, typeof owner === 'string' ? owner : JSON.stringify(owner), { mode: 0o600 });
    try { createCoverageJournal({ directory, sessionKey: 'fiction', ...options }).close(); return 'taken'; }
    catch (error) { return error.code; }
  };
  assert.deepEqual([attempt({ ...self, pid: 999999999 }), attempt({ ...parent }), attempt({ ...parent, start: '1' }),
    attempt({ ...self, pid: 999999999, host: 'another-host' }), attempt({ ...self, pid: 999999999, pidns: 'pid:[1]' }), attempt(''),
    attempt({ ...self, pid: 999999999 }, {})],
  ['taken', 'journal_locked', 'taken', 'journal_locked', 'journal_locked', 'journal_locked', 'journal_locked']);
}));

test('concurrent processes taking over a dead owner lock end with exactly one holder', () => privateDir(async directory => {
  const first = createCoverageJournal({ directory, sessionKey: 'fiction', pidLock: true });
  const lock = first.path.replace(/\.jsonl$/, '.lock');
  first.close();
  const contender = new URL('./helpers/lock-contender.mjs', import.meta.url).pathname;
  for (let round = 0; round < 3; round++) {
    writeFileSync(lock, JSON.stringify({ ...ownerRecord(), pid: 999999999 }), { mode: 0o600 });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, [contender, directory, 'fiction', '1500']).then(row => row.stdout.trim())));
    assert.deepEqual(outcomes.sort(), ['held', ...Array(7).fill('journal_locked')], `round ${round}`);
    assert.equal(existsSync(lock), false);
  }
}));

test('default journal bytes and lock are identical to the harness format before this change', async () => {
  const { bytes, lock } = await defaultJournalBytes(createCoverageJournal);
  assert.deepEqual([createHash('sha256').update(bytes).digest('hex'), lock.length],
    ['308123f920e3bde060c9601c96f813bb2088dd4f35ca9d7239e47698a87f9dfc', 0]);
});

test('record presence requires a read grant and reports only in-scope records', async () => {
  const store = { async getRecords(scope, ids) { return ids.filter(id => id === 'present').map(id => ({ id, scope })); } };
  const readable = new Memory({ scopes: { read: ['private'], write: ['private'] } }, store);
  const writeOnly = new Memory({ scopes: { read: [], write: ['private'] } }, store);
  const { createMemoryHandlers } = await import('../pi-extension/memory-process.mjs');
  const handlers = createMemoryHandlers({ memory: readable, scopes: ['private'] });
  assert.deepEqual(await handlers.recordPresence({ scope: 'private', ids: ['present', 'absent'] }), { present: ['present'], absent: ['absent'] });
  await assert.rejects(handlers.recordPresence({ scope: 'other', ids: ['present'] }), /scope_denied/);
  await assert.rejects(readable.recordPresence('private', []), /invalid_input/);
  await assert.rejects(writeOnly.recordPresence('private', ['present']), /scope_denied/);
  handlers.close();
});

test('the live hook never throws into Pi and reports synchronous and queued failures to onError', async () => {
  const hooks = new Map();
  const errors = [];
  registerLiveMemory({ on: (name, handler) => hooks.set(name, handler) }, {
    controllerFor: async snapshot => snapshot.leafId === 'a2' ? Promise.reject(new Error('controller failed'))
      : { settle: async () => { throw new Error('settle failed'); } },
    onError: error => errors.push(error.message) });
  const ctx = leafId => ({ sessionManager: { getSessionId: () => 's', getLeafId: () => leafId, getEntries: () => rows, getSessionFile: () => '/fiction' } });
  hooks.get('agent_settled')({}, { sessionManager: { getSessionId() { throw new Error('fictional manager failure'); } } });
  hooks.get('agent_settled')({}, ctx('a2'));
  hooks.get('agent_settled')({}, ctx('a3'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(errors, ['fictional manager failure', 'controller failed', 'settle failed']);
});
