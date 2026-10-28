import test from 'node:test';
import assert from 'node:assert/strict';

test('reported input plus cache reads are charged between calls and the next call stops at the ceiling', async () => {
  const { createInputBudget, boundPiRuntime } = await import('../pi-extension/budget.mjs');
  let calls = 0;
  const runtime = { streamSimple() { calls++; return 'fictional-stream'; } };
  const budget = createInputBudget(200);
  const bound = boundPiRuntime(runtime, budget);
  assert.equal(bound.streamSimple({}, {}), 'fictional-stream');
  budget.record({ input: 90, cacheRead: 110, cacheWrite: 0 });
  assert.throws(() => bound.streamSimple({}, {}), /input_budget_exhausted/);
  assert.deepEqual([calls, budget.used()], [1, 200]);
});

test('multiple provider calls are accounted separately including cache reads', async () => {
  const { createInputBudget, boundPiRuntime } = await import('../pi-extension/budget.mjs');
  const budget = createInputBudget(500);
  const bound = boundPiRuntime({ streamSimple() {} }, budget);
  bound.streamSimple({}, {}); budget.record({ input: 20, cacheRead: 30, cacheWrite: 5, output: 4 });
  bound.streamSimple({}, {}); budget.record({ input: 40, cacheRead: 50, cacheWrite: 0, output: 8 });
  assert.deepEqual([budget.used(), budget.receipts().length, budget.reason()], [145, 2, null]);
});

test('missing usage is recorded as unknown and refuses another provider call', async () => {
  const { createInputBudget, boundPiRuntime } = await import('../pi-extension/budget.mjs');
  let calls = 0;
  const budget = createInputBudget(200);
  const bound = boundPiRuntime({ streamSimple() { calls++; } }, budget);
  bound.streamSimple({}, {});
  budget.record(null);
  assert.throws(() => bound.streamSimple({}, {}), /input_budget_unknown/);
  assert.equal(calls, 1);
});
