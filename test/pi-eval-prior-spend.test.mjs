import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { attestedPriorSpend, priorSoftSpend, validatePriorSpendContinuity } from '../pi-extension/evaluation/prior-spend.mjs';

const line = value => JSON.stringify(value);
const known = [line({ type: 'open', version: 'soft-sdk-ledger/v1' }), line({ type: 'started', id: 1 }),
  line({ type: 'result', id: 1, outcome: 'received', stop: null, api_equivalent_nano: '23' }),
  line({ type: 'close', in_flight: false, stopped: null, calls_started: 1, spent_nano: '23' })].join('\n');

test('a completed prior ledger is included in the next soft reservation', () => {
  assert.equal(priorSoftSpend(known), '23');
});

test('resume refuses prior spend lower than the previous report total', () => {
  assert.throws(() => validatePriorSpendContinuity('99', '100'), /prior_spend_chain_incomplete/);
  assert.equal(validatePriorSpendContinuity('100', '100'), '100');
});

test('an unknown prior effect cannot be hidden by starting a fresh ledger', () => {
  assert.throws(() => priorSoftSpend(known.replace('"outcome":"received"', '"outcome":"unknown"')), /prior_ledger_unresolved/);
});

test('a pinned local pre-dispatch reconciliation preserves known prior spend', () => {
  const ledger = [line({ type: 'open', version: 'soft-sdk-ledger/v1' }), line({ type: 'started', id: 1 }),
    line({ type: 'result', id: 1, outcome: 'received', stop: null, api_equivalent_nano: '23' }), line({ type: 'started', id: 2 }),
    line({ type: 'result', id: 2, outcome: 'unknown', stop: 'dispatch_unknown' }),
    line({ type: 'close', in_flight: false, stopped: 'dispatch_unknown', calls_started: 2, spent_nano: '23' })].join('\n');
  const receipt = { schema: 'soft-ledger-reconciliation/v1', ledger_sha256: createHash('sha256').update(ledger).digest('hex'),
    call_id: 2, decision: 'not_sent', reported_error: 'input_budget_exhausted', additional_upstream_request: false,
    transcript_row_sha256: 'a'.repeat(64), budget_code_sha256: 'b'.repeat(64), gateway_correlation_sha256: 'c'.repeat(64) };
  assert.equal(priorSoftSpend(ledger, { reconciliations: [receipt] }), '23');
  assert.throws(() => priorSoftSpend(ledger, { reconciliations: [{ ...receipt, ledger_sha256: 'd'.repeat(64) }] }), /prior_ledger_unresolved/);
});

test('a graceful interruption retains all completed usage without inventing a dispatch', () => {
  const ledger = [line({ type: 'open', version: 'soft-sdk-ledger/v1' }), line({ type: 'started', id: 1 }),
    line({ type: 'stop_requested', reason: 'SIGTERM', in_flight: true }),
    line({ type: 'result', id: 1, outcome: 'received', stop: 'operator_interrupted', api_equivalent_nano: '23' }),
    line({ type: 'close', in_flight: false, stopped: 'operator_interrupted', calls_started: 1, spent_nano: '23' })].join('\n');
  assert.equal(priorSoftSpend(ledger), '23');
});

test('an attested prior total includes recorded spend and requires a reserve for unresolved calls', () => {
  const unknown = [line({ type: 'open', version: 'soft-sdk-ledger/v1' }), line({ type: 'started', id: 1 }),
    line({ type: 'result', id: 1, outcome: 'unknown', stop: 'dispatch_unknown' }),
    line({ type: 'close', in_flight: false, stopped: 'dispatch_unknown', calls_started: 1, spent_nano: '0' })].join('\n');
  const digest = text => createHash('sha256').update(text).digest('hex');
  const attestation = reserve => ({ schema: 'prior-spend-attestation/v1', unresolved_reserve_nano: reserve,
    ledgers: [{ path: '/fiction/a', sha256: digest(known) }, { path: '/fiction/b', sha256: digest(unknown) }] });
  assert.deepEqual(attestedPriorSpend(attestation('100'), [known, unknown]), { totalNano: '123', unresolvedCalls: 1 });
  assert.throws(() => attestedPriorSpend(attestation('0'), [known, unknown]), /prior_attestation_invalid/);
  assert.throws(() => attestedPriorSpend(attestation('100'), [known, known]), /prior_attestation_invalid/);
});

test('a typed pre-dispatch stop requires no fabricated usage', () => {
  const ledger = [line({ type: 'open', version: 'soft-sdk-ledger/v1' }), line({ type: 'started', id: 1 }),
    line({ type: 'result', id: 1, outcome: 'not_sent', reason: 'input_budget_exhausted', stop: 'input_budget_exhausted', provenance: 'bound-runtime-pre-dispatch' }),
    line({ type: 'close', in_flight: false, stopped: 'input_budget_exhausted', calls_started: 1, spent_nano: '0' })].join('\n');
  assert.equal(priorSoftSpend(ledger), '0');
});
