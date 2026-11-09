import test from 'node:test';
import assert from 'node:assert/strict';
import { fictionalCalibration, fictionalCalibrationV2 } from '../pi-extension/policy.mjs';
import { calibrationMemory, scoreCalibration } from '../scripts/run-calibration.mjs';

test('calibration v2 is v1 plus one routine action/result case that must be abstained', () => {
  const v1 = fictionalCalibration().value, v2 = fictionalCalibrationV2().value;
  assert.deepEqual([v2.cases.slice(0, -1), v2.cases.at(-1).id, v2.cases.at(-1).expected_action, v2.policy_id], [v1.cases, 'routine-action-result', 'abstain', v1.policy_id]);
});

test('the calibration store offers every accessible prior and records each derived write', async () => {
  const { memory, writes } = calibrationMemory(['A prior constraint.']);
  const found = await memory.searchCompact();
  assert.deepEqual([found.surface.status, found.surface.records.length, found.surface.budget_omitted], ['ready', 1, 0]);
  await memory.enrich('calibration', { records: [{ id: 'r', kind: 'decision' }] });
  await memory.beginOutcome('calibration', 't', { id: 'o', kind: 'outcome' }, { id: 'a', kind: 'action' });
  await memory.applyOutcome();
  assert.deepEqual(writes.map(row => row.kind), ['decision', 'action', 'outcome']);
});

test('scoring separates writes on must-abstain cases and never model-scores the uncertain case', () => {
  const cases = fictionalCalibrationV2().value.cases;
  const outcomes = cases.filter(row => row.expected_action !== 'uncertain').map(row => ({ id: row.id,
    writes: row.id === 'routine-action-result' || row.expected_action === 'write' ? [{ kind: 'action' }] : [] }));
  const summary = scoreCalibration(cases, outcomes);
  assert.deepEqual([summary.assessed, summary.passed, summary.writes_on_must_abstain, summary.rows.find(row => row.id === 'uncertain-write').status],
    [9, 8, ['routine-action-result'], 'not_model_assessable']);
});
