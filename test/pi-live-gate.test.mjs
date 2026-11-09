import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createCursorStore } from '../pi-extension/cursor-store.mjs';
import { createLiveController } from '../pi-extension/live.mjs';
import { createDailyInputBudget, createLiveGate, createUsageLedger } from '../pi-extension/live-gate.mjs';

const entries = [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Fictional request.' } },
  { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: 'Fictional reply.', stopReason: 'stop' } }];
const grants = { read: ['private'], write: ['private'] };

async function privateDir(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-gate-'));
  chmodSync(directory, 0o700);
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function harness(directory, gate, distill = async () => ({ status: 'complete', disposition: 'abstained' })) {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction', effectIds: true, pidLock: true });
  const seen = { opened: 0, ingested: 0 };
  const controller = createLiveController({ journal, cursorStore: createCursorStore({ directory, sessionKey: 'fiction' }), conversationId: 'fiction', gate,
    open: async () => {
      seen.opened++;
      const memory = journal.track({ async ingest(_scope, turn) { seen.ingested++; return { id: `turn-${turn.turn_id}` }; } });
      return { conversation_id: 'fiction', scopes: ['private'], memory, distiller: { memory, run: distill } };
    } });
  return { journal, controller, seen };
}

test('a refused gate leaves no journal row, opens no Memory process and ingests nothing', () => privateDir(async directory => {
  const live = harness(directory, async () => { throw Object.assign(new Error('no'), { code: 'input_budget_exhausted', refused: true }); });
  const result = await live.controller.settle({ leafId: 'a', entries });
  assert.deepEqual([result.status, result.results[0].code, readFileSync(live.journal.path, 'utf8'), live.seen],
    ['refused', 'input_budget_exhausted', '', { opened: 0, ingested: 0 }]);
  live.journal.close();
}));

test('a failing gate is a refusal, not permission', () => privateDir(async directory => {
  const live = harness(directory, async () => { throw new Error('ledger disk failure'); });
  const result = await live.controller.settle({ leafId: 'a', entries });
  assert.deepEqual([result.status, result.results[0].code, live.seen.ingested], ['refused', 'gate_unavailable', 0]);
  live.journal.close();
}));

test('the gate refuses a scope without both read and write grants', () => privateDir(async directory => {
  const ledger = createUsageLedger({ directory });
  const budget = createDailyInputBudget({ ledger, limit: 1000 });
  const gate = createLiveGate({ scope: 'private', grants: { read: ['private'], write: [] }, budget, ledger });
  await assert.rejects(gate({ through: 'a', cursor: null, retry: false }), { code: 'scope_permission_denied', refused: true });
  ledger.close();
}));

test('spend recorded before a restart exhausts the daily budget before the next ingest', () => privateDir(async directory => {
  let ledger = createUsageLedger({ directory });
  let budget = createDailyInputBudget({ ledger, limit: 100 });
  budget.beforeCall();
  budget.record({ input: 80, cacheRead: 15, cacheWrite: 10, output: 3 });
  ledger.close();
  ledger = createUsageLedger({ directory });
  budget = createDailyInputBudget({ ledger, limit: 100 });
  const live = harness(directory, createLiveGate({ scope: 'private', grants, budget, ledger }));
  const result = await live.controller.settle({ leafId: 'a', entries });
  assert.deepEqual([budget.used(), result.status, result.results[0].code, live.seen.ingested], [105, 'refused', 'input_budget_exhausted', 0]);
  live.journal.close();
  ledger.close();
}));

test('a torn usage line makes the day unknown and is refused', () => privateDir(async directory => {
  let ledger = createUsageLedger({ directory });
  ledger.close();
  appendFileSync(join(directory, 'usage.jsonl'), '{"v":1,"kind":"usage","inp');
  ledger = createUsageLedger({ directory });
  const budget = createDailyInputBudget({ ledger, limit: 1000 });
  const gate = createLiveGate({ scope: 'private', grants, budget, ledger });
  await assert.rejects(gate({ through: 'a', cursor: null, retry: false }), { code: 'input_budget_unknown' });
  ledger.append({ kind: 'interval', through: 'x', cursor: null, retry: false });
  ledger.close();
  assert.equal(readFileSync(join(directory, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-1)[0].startsWith('{"v":1,"day"'), true);
}));

test('the daily interval cap and reserve are enforced, and the next UTC day starts fresh between intervals', () => privateDir(async directory => {
  let clock = new Date('2026-01-01T23:00:00Z');
  const ledger = createUsageLedger({ directory, now: () => clock });
  const budget = createDailyInputBudget({ ledger, limit: 100 });
  const gate = createLiveGate({ scope: 'private', grants, budget, ledger, maxIntervalsPerDay: 1, minRemaining: 10 });
  await gate({ through: 'a', cursor: null, retry: false });
  await assert.rejects(gate({ through: 'b', cursor: 'a', retry: false }), { code: 'interval_limit' });
  budget.beforeCall();
  budget.record({ input: 95, cacheRead: 0, cacheWrite: 0 });
  clock = new Date('2026-01-02T00:00:01Z');
  await gate({ through: 'b', cursor: 'a', retry: false });
  budget.beforeCall();
  budget.record({ input: 91, cacheRead: 0, cacheWrite: 0 });
  await assert.rejects(gate({ through: 'c', cursor: 'b', retry: false }), { code: 'input_budget_reserve' });
  assert.deepEqual([ledger.used('2026-01-01'), ledger.used('2026-01-02'), ledger.intervals('2026-01-02')], [95, 91, 1]);
  ledger.close();
}));

test('a gated retry of a failed interval is also refused before ingest', () => privateDir(async directory => {
  let allow = true;
  let calls = 0;
  const live = harness(directory, async () => { if (!allow) throw Object.assign(new Error('no'), { code: 'input_budget_exhausted', refused: true }); },
    async () => { if (++calls === 1) throw Object.assign(new Error('provider'), { code: 'provider_unavailable' }); return { status: 'complete', disposition: 'abstained' }; });
  await live.controller.settle({ leafId: 'a', entries });
  allow = false;
  const refused = await live.controller.settle({ leafId: 'a', entries });
  allow = true;
  const resumed = await live.controller.settle({ leafId: 'a', entries });
  assert.deepEqual([refused.status, live.journal.attempts(live.journal.intervals()[0]?.id), resumed.status, live.seen.ingested], ['refused', 2, 'current', 2]);
  live.journal.close();
}));
