import test from 'node:test';
import assert from 'node:assert/strict';
import { priorSoftSpend } from '../pi-extension/evaluation/prior-spend.mjs';

const line = value => JSON.stringify(value);
const known = [line({ type: 'open', version: 'soft-sdk-ledger/v1' }), line({ type: 'started', id: 1 }),
  line({ type: 'result', id: 1, outcome: 'received', stop: null, api_equivalent_nano: '23' }),
  line({ type: 'close', in_flight: false, stopped: null, calls_started: 1, spent_nano: '23' })].join('\n');

test('a completed prior ledger is included in the next soft reservation', () => {
  assert.equal(priorSoftSpend(known), '23');
});

test('an unknown prior effect cannot be hidden by starting a fresh ledger', () => {
  assert.throws(() => priorSoftSpend(known.replace('"outcome":"received"', '"outcome":"unknown"')), /prior_ledger_unresolved/);
});
