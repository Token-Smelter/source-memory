import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundPiRuntime, createInputBudget } from '../pi-extension/budget.mjs';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createCursorStore } from '../pi-extension/cursor-store.mjs';
import { createLiveController } from '../pi-extension/live.mjs';
import { createDailyInputBudget, createLiveGate, createUsageLedger } from '../pi-extension/live-gate.mjs';
import { ownerRecord } from '../pi-extension/owner-lock.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const entries = [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Fictional request.' } },
  { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: 'Fictional reply.', stopReason: 'stop' } }];
const grants = { read: ['private'], write: ['private'] };
const clock = iso => { let current = new Date(iso); return Object.assign(() => current, { set: next => { current = new Date(next); } }); };
const spend = (budget, input) => { budget.beforeCall(); budget.record({ input, cacheRead: 0, cacheWrite: 0, output: 1 }); };

async function privateDir(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-gate-'));
  chmodSync(directory, 0o700);
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function harness(directory, gate, { distill = async () => ({ status: 'complete', disposition: 'abstained' }), sessionScope = 'private', sessionBudget } = {}) {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction', effectIds: true, pidLock: true });
  const seen = { opened: 0, ingested: 0 };
  const controller = createLiveController({ journal, cursorStore: createCursorStore({ directory, sessionKey: 'fiction' }), conversationId: 'fiction', gate,
    open: async () => {
      seen.opened++;
      const memory = journal.track({ async ingest(_scope, turn) { seen.ingested++; return { id: `turn-${turn.turn_id}` }; } });
      return { conversation_id: 'fiction', scopes: [sessionScope], memory, budget: sessionBudget ?? gate.budget, distiller: { memory, run: distill } };
    } });
  return { journal, controller, seen };
}

function standardGate(directory, { now, limit = 1000, ...options } = {}) {
  const ledger = createUsageLedger({ directory, ...(now ? { now } : {}) });
  const budget = createDailyInputBudget({ ledger, limit });
  return { ledger, budget, gate: createLiveGate({ scope: 'private', grants, budget, ledger, ...options }) };
}

test('a refusal leaves no journal row, opens no Memory process and ingests nothing', () => privateDir(async directory => {
  for (const gate of [async () => { throw Object.assign(new Error('no'), { code: 'input_budget_exhausted', refused: true }); },
    async () => false, async () => ({ admitted: false, code: 'Not Safe!' }), async () => { throw new Error('ledger disk failure'); }]) {
    const live = harness(directory, gate);
    const result = await live.controller.settle({ leafId: 'a', entries });
    assert.deepEqual([result.status, readFileSync(live.journal.path, 'utf8'), live.seen], ['refused', '', { opened: 0, ingested: 0 }]);
    live.journal.close();
  }
  const codes = [];
  for (const gate of [async () => { throw Object.assign(new Error('no'), { code: 'input_budget_exhausted', refused: true }); }, async () => false,
    async () => { throw new Error('x'); }]) {
    const live = harness(directory, gate);
    codes.push((await live.controller.settle({ leafId: 'a', entries })).code);
    live.journal.close();
  }
  assert.deepEqual(codes, ['input_budget_exhausted', 'gate_refused', 'gate_unavailable']);
}));

test('the controller requires a gate and refuses a session that writes or spends outside it', () => privateDir(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction-required', effectIds: true, pidLock: true });
  assert.throws(() => createLiveController({ journal, cursorStore: createCursorStore({ directory, sessionKey: 'x' }), conversationId: 'fiction', open: async () => ({}) }),
    /controller_invalid/);
  journal.close();
  const { gate, ledger } = standardGate(directory);
  for (const [options, label] of [[{ sessionScope: 'other' }, 'scope'], [{ sessionBudget: createInputBudget() }, 'budget']]) {
    const live = harness(directory, gate, options);
    await assert.rejects(live.controller.settle({ leafId: 'a', entries }), /gate_binding_mismatch/, label);
    assert.equal(live.seen.ingested, 0);
    live.journal.close();
  }
  ledger.close();
}));

test('grants must be arrays naming the scope for read and write', () => privateDir(async directory => {
  const ledger = createUsageLedger({ directory });
  const budget = createDailyInputBudget({ ledger, limit: 1000 });
  assert.throws(() => createLiveGate({ scope: 'private', grants: { read: 'private-archive', write: 'private-archive' }, budget, ledger }), /gate_invalid/);
  for (const partial of [{ read: ['private'], write: [] }, { read: [], write: ['private'] }]) {
    await assert.rejects(createLiveGate({ scope: 'private', grants: partial, budget, ledger })({}), { code: 'scope_permission_denied', refused: true });
  }
  ledger.close();
}));

test('grants are checked before reconciliation, which reads Memory but spends nothing', () => privateDir(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction', effectIds: true, pidLock: true });
  journal.begin({ cursor: null, through: 'a' });
  journal.close();
  const ledger = createUsageLedger({ directory });
  const budget = createDailyInputBudget({ ledger, limit: 1000 });
  const live = harness(directory, createLiveGate({ scope: 'private', grants: { read: [], write: ['private'] }, budget, ledger }));
  const result = await live.controller.settle({ leafId: 'a', entries });
  assert.deepEqual([result.status, result.code, live.seen.opened, readFileSync(live.journal.path, 'utf8').includes('"reconcile"')],
    ['refused', 'scope_permission_denied', 0, false]);
  live.journal.close();
  ledger.close();
}));

test('model spend through the bound runtime is durable and exhausts the day for a restarted process', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  let { ledger, budget } = standardGate(directory, { now, limit: 100 });
  const runtime = boundPiRuntime({ streamSimple: () => ({ fiction: true }) }, budget);
  runtime.streamSimple({});
  budget.record({ input: 80, cacheRead: 15, cacheWrite: 10, output: 3 });
  ledger.close();
  ({ ledger, budget } = standardGate(directory, { now, limit: 100 }));
  const gate = createLiveGate({ scope: 'private', grants, budget, ledger });
  const live = harness(directory, gate);
  const result = await live.controller.settle({ leafId: 'a', entries });
  assert.deepEqual([budget.used(), result.status, result.code, live.seen.ingested], [105, 'refused', 'input_budget_exhausted', 0]);
  live.journal.close();
  ledger.close();
}));

test('a call that started but never reported usage is unknown after a restart, and only on its day', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  const ledger = createUsageLedger({ directory, now });
  ledger.append({ kind: 'call', id: 'crashed', owner: { ...ownerRecord(), pid: 999999999 } });
  ledger.close();
  let reopened = standardGate(directory, { now });
  await assert.rejects(reopened.gate({}), { code: 'input_budget_unknown' });
  reopened.ledger.close();
  now.set('2026-03-02T00:00:01Z');
  reopened = standardGate(directory, { now });
  assert.deepEqual(await reopened.gate({}), { admitted: true });
  reopened.ledger.close();
}));

test('a call in flight in another live process is neither unknown nor spend', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  const ledger = createUsageLedger({ directory, now });
  ledger.append({ kind: 'call', id: 'parent', owner: ownerRecord(process.ppid) });
  const { gate, ledger: mine } = standardGate(directory, { now });
  assert.deepEqual(await gate({}), { admitted: true });
  ledger.close();
  mine.close();
}));

test('the day total and the interval cap are shared by every ledger and budget on the directory', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  const first = standardGate(directory, { now, limit: 100, maxIntervalsPerDay: 2 });
  const second = standardGate(directory, { now, limit: 100, maxIntervalsPerDay: 2 });
  spend(first.budget, 60);
  spend(second.budget, 45);
  await assert.rejects(first.gate({}), { code: 'input_budget_exhausted' });
  await assert.rejects(second.gate({}), { code: 'input_budget_exhausted' });
  now.set('2026-03-02T09:00:00Z');
  await first.gate({});
  await second.gate({});
  await assert.rejects(first.gate({}), { code: 'interval_limit' });
  assert.deepEqual([first.ledger.used('2026-03-01'), second.ledger.intervals('2026-03-02')], [105, 2]);
  first.ledger.close();
  second.ledger.close();
}));

test('a torn line is unknown usage on the day it is found and is acknowledged once', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  createUsageLedger({ directory, now }).close();
  appendFileSync(join(directory, 'usage.jsonl'), '{"v":1,"kind":"usage","inp');
  let reopened = standardGate(directory, { now });
  await assert.rejects(reopened.gate({}), { code: 'input_budget_unknown' });
  reopened.ledger.append({ kind: 'interval', through: 'x', cursor: null, retry: false });
  reopened.ledger.close();
  now.set('2026-03-02T00:00:01Z');
  reopened = standardGate(directory, { now });
  assert.deepEqual(await reopened.gate({}), { admitted: true });
  reopened.ledger.close();
  const lines = readFileSync(join(directory, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual([lines.filter(line => line.includes('"kind":"ack"')).length, lines.filter(line => line.includes('"kind":"interval"')).length], [1, 2]);
}));

test('malformed rows are unknown usage rather than ignored', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  createUsageLedger({ directory, now }).close();
  for (const row of ['null', '{"v":1,"kind":"usage","input":5,"cacheRead":0,"cacheWrite":0}', '{"v":1,"day":"2026-03-01","kind":"Usage"}',
    '{"v":1,"day":"2026-03-01","kind":"usage","status":"ok"}']) {
    writeFileSync(join(directory, 'usage.jsonl'), `${row}\n`, { mode: 0o600 });
    const reopened = standardGate(directory, { now });
    await assert.rejects(reopened.gate({}), { code: 'input_budget_unknown' }, row);
    reopened.ledger.close();
  }
}));

test('a missing limit, an unknown reserve or a budget on another ledger fail closed', () => privateDir(async directory => {
  const ledger = createUsageLedger({ directory, now: clock('2026-03-01T10:00:00Z') });
  assert.throws(() => createDailyInputBudget({ ledger }), /input_budget_invalid/);
  const budget = createDailyInputBudget({ ledger, limit: 10_000 });
  spend(budget, 9_000);
  await assert.rejects(createLiveGate({ scope: 'private', grants, budget, ledger, minRemaining: 5_000 })({}), { code: 'input_budget_reserve' });
  assert.throws(() => createLiveGate({ scope: 'private', grants, budget: { reason: () => null, used: () => 0 }, ledger }), /gate_invalid/);
  assert.throws(() => createLiveGate({ scope: 'private', grants, budget: createInputBudget(), ledger }), /gate_invalid/);
  ledger.close();
}));

test('a call refused before dispatch is not lost spend, and the next day admits in the same process', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  const { ledger, budget, gate } = standardGate(directory, { now, limit: 10 });
  const runtime = boundPiRuntime({ streamSimple: () => ({}) }, budget);
  await gate({});
  runtime.streamSimple({});
  budget.record({ input: 10, cacheRead: 0, cacheWrite: 0, output: 1 });
  assert.throws(() => runtime.streamSimple({}), /input_budget_exhausted/);
  // Pi's run-failure path reports the prevented call with empty usage.
  budget.record({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 });
  assert.equal(budget.reason(), 'input_budget_exhausted');
  now.set('2026-03-02T00:00:01Z');
  assert.deepEqual([budget.reason(), await gate({})], [null, { admitted: true }]);
  budget.record({ input: 3, cacheRead: 0, cacheWrite: 0 });
  assert.equal(budget.reason(), 'input_budget_unknown');
  now.set('2026-03-03T00:00:01Z');
  assert.equal(budget.reason(), null);
  ledger.close();
}));

test('a receipt-less call whose owner cannot be proven alive is unknown usage', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  const self = ownerRecord();
  const owners = [{ ...self, pid: 999999999, boot: null, pidns: null, start: null }, { ...self, pid: process.ppid, pidns: 'pid:[1]' },
    { ...self, pid: process.ppid, host: 'another-host' }, { ...ownerRecord(process.ppid), start: '1' }];
  for (const [index, owner] of owners.entries()) {
    const ledger = createUsageLedger({ directory, now });
    ledger.append({ kind: 'call', id: `unprovable-${index}`, owner });
    ledger.close();
    const reopened = standardGate(directory, { now });
    await assert.rejects(reopened.gate({}), { code: 'input_budget_unknown' }, JSON.stringify(owner));
    reopened.ledger.close();
    now.set(`2026-03-0${index + 2}T10:00:00Z`);
  }
}));

test('concurrent processes cannot all pass the daily interval cap', () => privateDir(async directory => {
  createUsageLedger({ directory }).close();
  const contender = new URL('./helpers/gate-contender.mjs', import.meta.url).pathname;
  const startAt = String(Date.now() + 1500);
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, [contender, directory, startAt]).then(row => row.stdout.trim())));
  assert.deepEqual(outcomes.sort(), ['admitted', ...Array(5).fill('interval_limit')]);
}));

test('the standard gate admits a covered interval and records it with the session spend', () => privateDir(async directory => {
  const now = clock('2026-03-01T10:00:00Z');
  const { ledger, budget, gate } = standardGate(directory, { now });
  const live = harness(directory, gate, { distill: async () => {
    const runtime = boundPiRuntime({ streamSimple: () => ({}) }, budget);
    runtime.streamSimple({});
    budget.record({ input: 10, cacheRead: 0, cacheWrite: 0, output: 1 });
    return { status: 'complete', disposition: 'abstained' };
  } });
  const result = await live.controller.settle({ leafId: 'a', entries });
  const rows = readFileSync(ledger.path, 'utf8').trim().split('\n').map(JSON.parse).map(row => row.kind);
  assert.deepEqual([result.status, rows, budget.used()], ['covered', ['interval', 'call', 'usage'], 10]);
  live.journal.close();
  ledger.close();
}));

test('a closed or failed ledger never writes again', () => privateDir(async directory => {
  const ledger = createUsageLedger({ directory });
  ledger.close();
  ledger.close();
  assert.throws(() => ledger.append({ kind: 'interval' }), /ledger_closed/);
  const budget = createDailyInputBudget({ ledger: { day: () => '2026-03-01', callStart: () => 'c', used: () => 0, unknown: () => false,
    append() { throw new Error('ENOSPC'); } }, limit: 10 });
  budget.beforeCall();
  assert.throws(() => budget.record({ input: 1, cacheRead: 0, cacheWrite: 0 }), /usage_receipt_unavailable/);
  assert.equal(budget.reason(), 'input_budget_unknown');
}));

test('a gated retry of a failed interval is also refused before ingest', () => privateDir(async directory => {
  let allow = true;
  let calls = 0;
  const gate = async () => { if (!allow) throw Object.assign(new Error('no'), { code: 'input_budget_exhausted', refused: true }); return { admitted: true }; };
  const live = harness(directory, gate,
    { distill: async () => { if (++calls === 1) throw Object.assign(new Error('provider'), { code: 'provider_unavailable' }); return { status: 'complete', disposition: 'abstained' }; } });
  await live.controller.settle({ leafId: 'a', entries });
  allow = false;
  const refused = await live.controller.settle({ leafId: 'a', entries });
  allow = true;
  const resumed = await live.controller.settle({ leafId: 'a', entries });
  assert.deepEqual([refused.status, live.journal.failures(live.journal.intervals()[0]?.id), resumed.status, live.seen.ingested], ['refused', 1, 'current', 2]);
  live.journal.close();
}));

test('createInputBudget defaults are unchanged', () => {
  const budget = createInputBudget();
  budget.beforeCall();
  budget.record({ input: 5, cacheRead: 1, cacheWrite: 2 });
  assert.deepEqual([budget.limit, budget.used(), budget.started(), budget.reason(), budget.receipts()],
    [20_000_000, 8, 1, null, [{ input: 5, cacheRead: 1, cacheWrite: 2, output: null }]]);
});
