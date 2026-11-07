import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSoftBudget } from '../pi-extension/evaluation/soft-budget.mjs';
import { boundPiRuntime, createInputBudget } from '../pi-extension/budget.mjs';

async function withBudget(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-soft-budget-'));
  try {
    const path = join(directory, 'ledger.jsonl');
    const budget = createSoftBudget({ path, capNano: '1000000', sessionKey: 'fiction', sealSha256: 'a'.repeat(64),
      routes: { 'fiction/model': { maxOutputTokens: 10, ratesNanoPerToken: { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 }, rateEvidence: 'fiction' } } });
    await action(budget, path);
    budget.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const model = { provider: 'fiction', id: 'model' };
const metadata = () => ({ purpose: 'candidate', arm: 'candidate', checkpoint: 'fiction', task_version: 'fiction', policy_version: 'fiction' });
const stream = promise => ({ result: () => promise, async *[Symbol.asyncIterator]() {} });

test('soft ledger enforces one in-flight call and records SDK usage without cache double-counting', () => withBudget(async (budget, path) => {
  let finish;
  const runtime = budget.wrap({ streamSimple() { return stream(new Promise(resolve => { finish = resolve; })); } }, metadata);
  const pending = runtime.streamSimple(model, { messages: [] });
  assert.throws(() => runtime.streamSimple(model, { messages: [] }), /model_call_in_flight/);
  finish({ provider: 'fiction', model: 'model', stopReason: 'stop', usage: { input: 5, cacheRead: 3, cacheWrite: 2, output: 1 } });
  await pending.result();
  await new Promise(resolve => setImmediate(resolve));
  const result = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([budget.state().spent_nano, result.api_equivalent_nano, result.usage.inclusion], ['11', '11', 'Pi Anthropic input excludes cache classes']);
}));

test('a locally prevented input-limit dispatch is typed as not sent', () => withBudget(async (budget, path) => {
  let upstream = 0;
  const input = createInputBudget(1);
  input.beforeCall(); input.record({ input: 1, cacheRead: 0, cacheWrite: 0 });
  const runtime = budget.wrap(boundPiRuntime({ streamSimple() { upstream++; } }, input), metadata);
  assert.throws(() => runtime.streamSimple(model, { messages: [] }), /input_budget_exhausted/);
  const result = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([upstream, result.outcome, result.reason, budget.state().stopped], [0, 'not_sent', 'input_budget_exhausted', 'input_budget_exhausted']);
}));

test('unknown received usage stops further admission', () => withBudget(async budget => {
  const runtime = budget.wrap({ streamSimple() { return stream(Promise.resolve({ provider: 'fiction', model: 'model', stopReason: 'stop', usage: null })); } }, metadata);
  await runtime.streamSimple(model, { messages: [] }).result();
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => runtime.streamSimple(model, { messages: [] }), /usage_or_outcome_unknown/);
}));

test('a call exceeding twice its pre-call estimate stops further admission', () => withBudget(async budget => {
  const runtime = budget.wrap({ streamSimple() { return stream(Promise.resolve({ provider: 'fiction', model: 'model', stopReason: 'stop',
    usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 1 } })); } }, metadata);
  await runtime.streamSimple(model, { messages: [] }).result();
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => runtime.streamSimple(model, { messages: [] }), /over_twice_estimate/);
}));
