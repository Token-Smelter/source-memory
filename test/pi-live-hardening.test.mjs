import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createCursorStore, writeDurableFile } from '../pi-extension/cursor-store.mjs';
import { admitAll, createLiveController } from '../pi-extension/live.mjs';
import { acquireOwnerLock, ownerGone, ownerRecord } from '../pi-extension/owner-lock.mjs';
import { createDailyInputBudget, createLiveGate, createUsageLedger } from '../pi-extension/live-gate.mjs';

const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, message: { role, content, ...(role === 'assistant' ? { stopReason: 'stop' } : {}) } });
const tree = [message('u', null, 'user', 'Shared fictional root.'), message('a', 'u', 'assistant', 'Shared reply.'),
  message('ux', 'a', 'user', 'Branch X.'), message('x', 'ux', 'assistant', 'X.'),
  message('uy', 'a', 'user', 'Branch Y.'), message('y', 'uy', 'assistant', 'Y.')];

async function privateDir(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-hardening-'));
  chmodSync(directory, 0o700);
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function harness(directory, { sessionId = null, distill, conversation = 'fiction' } = {}) {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction', effectIds: true, pidLock: true });
  const seen = { ingests: [], opened: 0, closed: 0 };
  const controller = createLiveController({ journal, cursorStore: createCursorStore({ directory, sessionKey: 'fiction' }), conversationId: 'fiction',
    gate: admitAll, sessionId, open: async () => {
      seen.opened++;
      const memory = journal.track({ async ingest(_scope, turn) { seen.ingests.push(turn.entries.map(row => row.id)); return { id: 'turn' }; } });
      return { conversation_id: conversation, scopes: ['private'], memory, close() { seen.closed++; },
        distiller: { memory, run: distill ?? (async () => ({ status: 'complete', disposition: 'abstained' })) } };
    } });
  return { journal, controller, seen };
}

test('a branch-only view of the session is refused rather than re-ingesting shared source', () => privateDir(async directory => {
  const live = harness(directory);
  await live.controller.settle({ leafId: 'x', entries: tree });
  const branchOnly = await live.controller.settle({ leafId: 'y', entries: tree.filter(row => !['ux', 'x'].includes(row.id)) });
  assert.deepEqual([branchOnly.status, branchOnly.code, live.seen.ingests], ['skipped', 'source_incomplete', [['u', 'a', 'ux', 'x']]]);
  live.journal.close();
}));

test('a controller bound to one Pi session refuses another session\'s snapshot', () => privateDir(async directory => {
  const live = harness(directory, { sessionId: 'pi-session-a' });
  const foreign = await live.controller.settle({ sessionId: 'pi-session-b', leafId: 'x', entries: tree });
  const own = await live.controller.settle({ sessionId: 'pi-session-a', leafId: 'x', entries: tree });
  assert.deepEqual([foreign.code, own.status, live.seen.ingests.length], ['session_mismatch', 'covered', 1]);
  live.journal.close();
}));

test('a session that names another conversation is closed and refused', () => privateDir(async directory => {
  const live = harness(directory, { conversation: 'other' });
  await assert.rejects(live.controller.settle({ leafId: 'x', entries: tree }), /session_identity_changed/);
  assert.deepEqual([live.seen.opened, live.seen.closed, live.seen.ingests.length], [1, 1, 0]);
  live.journal.close();
}));

test('confirmed link application is never retried automatically', () => privateDir(async directory => {
  const first = createCoverageJournal({ directory, sessionKey: 'fiction', effectIds: true, pidLock: true });
  first.begin({ cursor: null, through: 'x' });
  const memory = first.track({ async applyLinks() { return { applied: 1 }; } });
  await memory.applyLinks('token', {});
  first.finish('failed', 'provider_unavailable');
  first.close();
  const live = harness(directory);
  const blocked = await live.controller.settle({ leafId: 'x', entries: tree });
  assert.deepEqual([blocked.status, blocked.code, live.seen.ingests.length], ['blocked', 'reconciliation_required', 0]);
  live.journal.close();
}));

test('evidence names an ingest that never started, and a conflicting evidence file is refused', () => privateDir(async directory => {
  const first = createCoverageJournal({ directory, sessionKey: 'fiction', effectIds: true, pidLock: true });
  first.begin({ cursor: null, through: 'x' });
  first.close();
  const live = harness(directory);
  const resumed = await live.controller.settle({ leafId: 'x', entries: tree });
  assert.deepEqual([resumed.reconciled.ingest, resumed.status, resumed.results.map(row => row.disposition)], ['not_started', 'current', ['abstained']]);
  live.journal.close();
  writeDurableFile(directory, 'evidence.json', Buffer.from('one'));
  writeDurableFile(directory, 'evidence.json', Buffer.from('one'));
  assert.throws(() => writeDurableFile(directory, 'evidence.json', Buffer.from('two')), /durable_file_conflict/);
}));

test('a reconcile the journal would reject is refused without writing, and the journal still opens', () => privateDir(async directory => {
  let journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const memory = journal.track({ async enrich() { return { records: ['r'] }; } });
  const id = journal.begin({ cursor: null, through: 'a' });
  await memory.enrich('private', { records: [{ id: 'r' }] }, { trigger: 't' });
  journal.finish('unresolved_scope', 'scope_unresolved');
  const before = readFileSync(journal.path, 'utf8');
  assert.throws(() => journal.reconcile({ id, disposition: 'failed', evidenceRef: 'fiction' }), /reconciliation_invalid/);
  journal.close();
  journal = createCoverageJournal({ directory, sessionKey: 'fiction-2' });
  const memory2 = journal.track({ async enrich() { return { records: ['r'] }; } });
  const id2 = journal.begin({ cursor: null, through: 'a' });
  await memory2.enrich('private', { records: [{ id: 'r' }] }, { trigger: 't' });
  journal.finish('failed', 'provider_unavailable');
  assert.throws(() => journal.reconcile({ id: id2, disposition: 'committed', evidenceRef: 'fiction' }), /reconciliation_invalid/);
  journal.close();
  const reopened = createCoverageJournal({ directory, sessionKey: 'fiction' });
  assert.equal(readFileSync(reopened.path, 'utf8'), before);
  reopened.close();
}));

test('an owner on another machine with the same hostname is never taken over', () => {
  const self = ownerRecord();
  assert.deepEqual([ownerGone({ ...self, pid: 999999999 }, self), ownerGone({ ...self, pid: 999999999, machine: 'another-machine' }, self),
    ownerGone({ ...self, pid: process.ppid, machine: 'another-machine', boot: 'another-boot' }, self)], [Boolean(self.machine), false, false]);
});

test('this process\'s own in-flight call is recognized even where /proc proves nothing', () => privateDir(async directory => {
  const ledger = createUsageLedger({ directory });
  ledger.callStart();
  const own = readFileSync(ledger.path, 'utf8').trim().split('\n').map(JSON.parse).at(-1).owner;
  const bare = { v: 1, host: own.host, machine: null, boot: null, pidns: null, pid: process.pid, start: null };
  ledger.append({ kind: 'usage', call: readFileSync(ledger.path, 'utf8').trim().split('\n').map(JSON.parse).at(-1).id, input: 0, cacheRead: 0, cacheWrite: 0 });
  ledger.append({ kind: 'call', id: 'own-macos', owner: { ...bare, instance: own.instance } });
  const ownInFlight = ledger.unknown();
  ledger.append({ kind: 'call', id: 'foreign-macos', owner: { ...bare, instance: 'another-process' } });
  assert.deepEqual([ownInFlight, ledger.unknown()], [false, true]);
  ledger.close();
}));

test('a contended admission waits without blocking the host and then refuses ledger_busy', () => privateDir(async directory => {
  const ledger = createUsageLedger({ directory });
  const budget = createDailyInputBudget({ ledger, limit: 1000 });
  const gate = createLiveGate({ scope: 'private', grants: { read: ['private'], write: ['private'] }, budget, ledger });
  const held = acquireOwnerLock(join(directory, 'usage.lock'));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  await assert.rejects(gate({}), { code: 'ledger_busy', refused: true });
  clearInterval(timer);
  held.release();
  assert.deepEqual([ticks > 20, await gate({})], [true, { admitted: true }]);
  ledger.close();
}));

test('an ungated controller marks every result as ungated', () => privateDir(async directory => {
  const live = harness(directory);
  const results = [await live.controller.settle({ leafId: 'missing', entries: tree }), await live.controller.settle({ leafId: 'x', entries: tree }),
    await live.controller.settle({ leafId: 'x', entries: tree })];
  assert.deepEqual(results.map(row => [row.status, row.ungated]), [['skipped', true], ['covered', true], ['current', true]]);
  live.journal.close();
}));

test('a second opener arriving inside the takeover window never also holds the lock', { skip: !ownerRecord().machine }, () => privateDir(async directory => {
  const lockPath = join(directory, 'fiction.lock');
  writeFileSync(lockPath, JSON.stringify({ ...ownerRecord(), pid: 999999999 }), { mode: 0o600 });
  const contender = new URL('./helpers/lock-contender.mjs', import.meta.url).pathname;
  const run = pause => {
    const child = spawn(process.execPath, [contender, directory, 'fiction', '600', lockPath, String(pause)]);
    let output = '';
    const breaking = new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('breaking')) resolve(); }));
    const done = new Promise(resolve => child.on('exit', () => resolve(output.trim().split('\n').at(-1))));
    return { breaking, done };
  };
  const first = run(800);
  await first.breaking;
  const second = run(0);
  assert.deepEqual([await first.done, await second.done], ['held', 'journal_locked']);
}));
