import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openLedger, estimateUsageNano } from '../pi-extension/evaluation/ledger.mjs';
import { wrapPiRuntime } from '../pi-extension/evaluation/pi-wrapper.mjs';
import { fictionalBounds, fictionalModel, fictionalPlan, fictionalSettings } from '../pi-extension/evaluation/fictional.mjs';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';

const open = path => { const seal = sealComparison(fictionalSettings()); return openLedger({ path, seal, expectedDigest: seal.digest }); };
const boundEvidence = { tokens: 80, providerBound: true, proofRef: 'fictional-payload-proof', contextFingerprint: 'a'.repeat(64) };
const boundCall = { inputBoundTokens: 80, maxOutputTokens: 20, route: 'fiction/one', modelFingerprint: fictionalBounds().modelFingerprint,
  providerBound: true, proofRef: boundEvidence.proofRef, contextFingerprint: boundEvidence.contextFingerprint };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fiction-ledger-'));
  return { file: join(dir, 'ledger.sqlite'), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('atomic reservation covers retries, unknown attempts, crashes and competing callers', () => {
  const f = fixture();
  try {
    const a = open(f.file);
    const b = open(f.file);
    const plan = fictionalPlan();
    const changed = structuredClone(plan); changed.id = 'changed'; changed.slots[0].bounds.rates.input = 1;
    assert.throws(() => a.reservePlan(changed), /budget_seal_mismatch/);
    changed.slots[0].bounds.rates.input = 2; changed.taskVersion = 'unsealed-version';
    assert.throws(() => a.reservePlan(changed), /budget_seal_mismatch/);
    const reserved = a.reservePlan(plan);
    assert.equal(reserved.reservedNano, '6800');
    assert.throws(() => b.reservePlan({ ...plan, id: 'other' }), /budget_exhausted/);
    a.startSlot('plan', 'first', boundCall);
    a.close(); b.close();
    const reopened = open(f.file);
    assert.throws(() => reopened.startSlot('plan', 'first', boundCall), /slot_not_reserved/);
    assert.equal(reopened.summary().heldNano, '6800');
    assert.throws(() => reopened.finishPlan('plan'), /in_flight_or_unknown/);
    assert.throws(() => reopened.startSlot('plan', 'retry', boundCall), /parent_effect_unknown/);
    assert.throws(() => reopened.reconcileAttempt('plan', 'first', { effectQuiesced: true }), /reconciliation_unverified/);
    reopened.reconcileAttempt('plan', 'first', { effectQuiesced: true, reference: 'fiction-proof', outcome: 'failed' });
    reopened.startSlot('plan', 'retry', boundCall);
    assert.equal(reopened.summary().heldNano, '6800');
    reopened.close();
  } finally { f.close(); }
});

test('parallel slots remain reserved together and unused slots alone may be released', () => {
  const f = fixture();
  try {
    const ledger = open(f.file);
    const plan = fictionalPlan(); plan.slots[1].kind = 'initial'; plan.slots[1].parent = null;
    ledger.reservePlan(plan);
    ledger.startSlot('plan', 'first', boundCall);
    ledger.startSlot('plan', 'retry', boundCall);
    assert.equal(ledger.summary().heldNano, '6800');
    assert.throws(() => ledger.finishPlan('plan'), /in_flight_or_unknown/);
    ledger.close();
  } finally { f.close(); }
});

test('completed calls with absent usage retain an explicit unknown and the worst-case hold', () => {
  const f = fixture();
  try {
    const ledger = open(f.file);
    ledger.reservePlan(fictionalPlan());
    ledger.startSlot('plan', 'first', boundCall);
    ledger.recordResult('plan', 'first', { provider: 'fiction', model: 'one', stopReason: 'stop' }, 5);
    ledger.finishPlan('plan');
    const summary = ledger.summary();
    assert.equal(summary.heldNano, '3400');
    assert.equal(summary.usageComplete, false);
    assert.equal(summary.chargesComplete, false);
    assert.equal(ledger.attempt('plan', 'first').usage, null);
    ledger.close();
  } finally { f.close(); }
});

test('provider usage is complete only with explicit provenance and compatible cache semantics', () => {
  const f = fixture();
  try {
    const ledger = open(f.file);
    ledger.reservePlan(fictionalPlan());
    ledger.startSlot('plan', 'first', boundCall);
    const result = ledger.recordResult('plan', 'first', { provider: 'fiction', model: 'one', stopReason: 'stop',
      usage: { input: 100, cacheRead: 20, cacheWrite: 10, output: 5 } }, 5,
    { source: 'provider_reported', reference: 'fictional-receipt' });
    assert.equal(result.usageEstimateNano, '215');
    assert.equal(ledger.summary().usageComplete, true);
    assert.equal(ledger.summary().chargesComplete, false);
    ledger.close();
  } finally { f.close(); }
});

test('concurrent processes cannot over-reserve the same budget', async () => {
  const f = fixture();
  try {
    open(f.file).close();
    const ledgerUrl = new URL('../pi-extension/evaluation/ledger.mjs', import.meta.url).href;
    const sealUrl = new URL('../pi-extension/evaluation/seal.mjs', import.meta.url).href;
    const dataUrl = new URL('../pi-extension/evaluation/fictional.mjs', import.meta.url).href;
    const script = `import {openLedger} from ${JSON.stringify(ledgerUrl)}; import {sealComparison} from ${JSON.stringify(sealUrl)};
      import {fictionalPlan,fictionalSettings} from ${JSON.stringify(dataUrl)};
      const seal=sealComparison(fictionalSettings()); const db=openLedger({path:process.env.LEDGER,seal,expectedDigest:seal.digest});
      try { db.reservePlan({...fictionalPlan(),id:process.env.PLAN}); console.log('admitted'); }
      catch(e) { console.log(e.code); } finally { db.close(); }`;
    const run = id => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, LEDGER: f.file, PLAN: id } });
      let out = ''; child.stdout.on('data', part => { out += part; }); child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(out.trim()) : reject(Error(`child_exit_${code}`)));
    });
    const outcomes = await Promise.all(['a', 'b', 'c', 'd'].map(run));
    assert.deepEqual(outcomes.sort(), ['admitted', 'budget_exhausted', 'budget_exhausted', 'budget_exhausted']);
  } finally { f.close(); }
});

test('usage arithmetic honors cache inclusion and never invents missing units', () => {
  const rates = { input: 2, cacheRead: 1, cacheWrite: 3, output: 5 };
  assert.equal(estimateUsageNano({ input: 100, cacheRead: 20, cacheWrite: 10, output: 5 }, rates, 'included'), '215');
  assert.equal(estimateUsageNano({ input: 70, cacheRead: 20, cacheWrite: 10, output: 5 }, rates, 'separate'), '215');
  assert.equal(estimateUsageNano({ input: 100, cacheRead: null, cacheWrite: 10, output: 5 }, rates, 'included'), null);
  assert.equal(estimateUsageNano({ input: 10, cacheRead: 20, cacheWrite: 10, output: 5 }, rates, 'included'), null);
});

test('Pi stream wrapper keeps its synchronous SDK shape and does not rewrite options', async () => {
  const f = fixture();
  try {
    const ledger = open(f.file);
    ledger.reservePlan(fictionalPlan());
    const model = fictionalModel();
    const context = { messages: [{ role: 'user', content: 'fiction' }] };
    const options = { maxTokens: 20, reasoning: 'low' };
    const message = { role: 'assistant', provider: 'fiction', model: 'one', stopReason: 'stop', usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 1, cost: { total: 0.01 } } };
    const stream = { async *[Symbol.asyncIterator]() { yield { type: 'done', message }; }, result: async () => message };
    const runtime = { value: 3, streamSimple(m, c, o) { assert.strictEqual(m, model); assert.strictEqual(c, context); assert.strictEqual(o, options); return stream; },
      completeSimple() { throw Error('must not call'); }, getValue() { return this.value; } };
    const unverified = wrapPiRuntime({ runtime, ledger, planId: 'plan', nextSlot: () => 'first', boundInput: () => 80 });
    assert.throws(() => unverified.streamSimple(model, context, options), /input_bound_unverified/);
    const bounded = wrapPiRuntime({ runtime, ledger, planId: 'plan', nextSlot: () => 'first', boundInput: () => boundEvidence });
    const modified = structuredClone(model); modified.compat.supportsStrictMode = true;
    assert.throws(() => bounded.streamSimple(modified, context, options), /call_bound_unavailable/);
    const got = bounded.streamSimple(model, context, options);
    assert.strictEqual(got, stream);
    assert.equal((await got.result()).stopReason, 'stop');
    const events = []; for await (const event of got) events.push(event.type);
    assert.deepEqual(events, ['done']);
    await new Promise(resolve => setImmediate(resolve));
    const row = ledger.attempt('plan', 'first');
    assert.equal(row.outcome, 'complete');
    assert.equal(row.providerCharge, null);
    assert.equal(row.sdkCostTotal, 0.01);
    assert.equal(row.usageProvenance, 'sdk_unverified');
    assert.equal(row.usageEstimateNano, null);
    assert.equal(ledger.summary().usageComplete, false);
    ledger.recordCharge('plan', 'first', { nano: '123', provenance: 'provider_reported', reference: 'fictional-bill', final: true, effectQuiesced: true });
    assert.equal(ledger.summary().providerChargeKnownNano, '123');
    assert.equal(ledger.summary().heldNano, '6800');
    assert.equal(bounded.getValue(), 3);
    assert.throws(() => bounded.completeSimple(model, context, options), /unmetered_api_refused/);
    ledger.close();
  } finally { f.close(); }
});

test('a reported charge exceeding the bound poisons further admission', () => {
  const f = fixture();
  try {
    const ledger = open(f.file);
    ledger.reservePlan(fictionalPlan());
    ledger.startSlot('plan', 'first', boundCall);
    assert.throws(() => ledger.recordCharge('plan', 'first', { nano: '99999', provenance: 'invoice', reference: 'fictional-invoice', final: true, effectQuiesced: true }), /charge_exceeds_bound/);
    assert.equal(ledger.summary().providerChargeKnownNano, '99999');
    assert.throws(() => ledger.startSlot('plan', 'retry', boundCall), /ledger_poisoned/);
    ledger.close();
  } finally { f.close(); }
});

test('unknown dispatch failure retains its full reservation and blocks replay', () => {
  const f = fixture();
  try {
    const ledger = open(f.file);
    ledger.reservePlan(fictionalPlan());
    const bounded = wrapPiRuntime({ runtime: { streamSimple() { throw Error('unknown effect'); } }, ledger, planId: 'plan', nextSlot: () => 'first', boundInput: () => boundEvidence });
    const invoke = () => bounded.streamSimple(fictionalModel(), { messages: [] }, { maxTokens: 20 });
    assert.throws(invoke, /unknown effect/);
    assert.throws(invoke, /slot_not_reserved/);
    assert.equal(ledger.summary().heldNano, '6800');
    ledger.close();
  } finally { f.close(); }
});
