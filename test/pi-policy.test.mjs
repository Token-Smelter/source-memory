import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCalibrationAssessments, checkTreatmentDiff, fictionalCalibration, fictionalCoverage, retentionPolicy } from '../pi-extension/policy.mjs';
import { distillThrough, createTurnTools } from '../pi-extension/core.mjs';

const assessments = cases => cases.map(row => ({ id: row.id, action: row.expected_action, observed: row.required,
  evidence_ref: `fictional-assessment:${row.id}` }));

test('versioned policy and fictional fixture artifacts retain their frozen hashes', () => {
  assert.deepEqual([retentionPolicy().value.id, fictionalCalibration().value.cases.length, fictionalCoverage().value.cases.length],
    ['memory-retention/r2-v1', 9, 8]);
});

test('treatment drift check requires invariant identity and explanations for each changed surface', () => {
  const policy = retentionPolicy();
  const baseline = { policy_sha256: policy.sha256, wording: 'A', examples: '', tool_presentation: '', bounded_search_strategy: '' };
  const candidate = { ...baseline, wording: 'B' };
  assert.deepEqual(checkTreatmentDiff({ baseline, candidate, rationale: { wording: 'Clarifies wording without changing selection.' } }).changed, ['wording']);
  assert.throws(() => checkTreatmentDiff({ baseline, candidate, rationale: {} }), /treatment_rationale_required/);
  assert.throws(() => checkTreatmentDiff({ baseline, candidate: { ...candidate, policy_sha256: 'changed' }, rationale: { wording: 'x' } }), /treatment_invalid/);
});

test('calibration drift check exposes missing semantic qualifications and forbidden additions', () => {
  const policy = retentionPolicy();
  const calibration = fictionalCalibration();
  const values = assessments(calibration.value.cases);
  const scoped = values.find(row => row.id === 'scoped-override');
  scoped.observed = [...scoped.observed.filter(tag => tag !== 'general_import_30_seconds'), 'global_45_second_replacement'];
  const result = checkCalibrationAssessments({ assessments: values, assessor: 'fictional-independent-assessor',
    policySha256: policy.sha256, calibrationSha256: calibration.sha256 });
  assert.deepEqual(result.failures[0], { id: 'scoped-override', expected_action: 'write', actual_action: 'write',
    missing: ['general_import_30_seconds'], forbidden: ['global_45_second_replacement'] });
});

test('calibration refuses a partial assessment set rather than reporting a pass', () => {
  const policy = retentionPolicy();
  const calibration = fictionalCalibration();
  assert.throws(() => checkCalibrationAssessments({ assessments: assessments(calibration.value.cases).slice(1), assessor: 'fictional',
    policySha256: policy.sha256, calibrationSha256: calibration.sha256 }), /calibration_incomplete/);
});

for (const fixture of fictionalCoverage().value.cases.filter(row => row.entries || row.generator)) {
  test(`fictional coverage: ${fixture.id}`, async () => {
    const entries = fixture.generator ? Array.from({ length: 1025 }, (_, index) => ({ type: 'message', id: `e${index}`,
      parentId: index ? `e${index - 1}` : null, message: { role: index === 1024 ? 'assistant' : 'user', content: 'Fiction',
        ...(index === 1024 ? { stopReason: 'stop' } : {}) } })) : fixture.entries;
    for (const checkpoint of fixture.checkpoints) {
      const captured = [];
      const session = { entries, conversation_id: 'fiction', scopes: ['fiction'],
        memory: { async ingest(_scope, turn) { captured.push(turn); return { id: 'fictional-turn' }; } },
        distiller: { async run() { return { status: 'complete' }; } } };
      const action = distillThrough(session, checkpoint.through, checkpoint.cursor, { allowInterrupted: checkpoint.interrupted === true });
      if (checkpoint.error) {
        await assert.rejects(action, error => error.code === checkpoint.error);
        assert.equal(captured.length, 0);
      } else {
        const result = await action;
        assert.deepEqual([result.cursor, captured[0].entries.map(row => row.id)], [checkpoint.through, checkpoint.entries]);
      }
    }
  });
}

test('an oversized retained chunk is disclosed as uncitable instead of cut at invented offsets', () => {
  const text = `${'x'.repeat(7999)}😀${'y'.repeat(8100)} tail`;
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text }] },
    receipt: { id: 'turn' }, sourceChunks: [{ entry_id: 'u', start: 0, end: text.length - 5, ordinal: 0 }, { entry_id: 'u', start: text.length - 4, end: text.length, ordinal: 1 }],
    memory: { async enrich() {} } });
  assert.deepEqual([tools.labels().length, tools.imageNotes()], [1, [{ entry_id: 'u', reason: 'chunk_over_citable_limit', ordinal: 0 }]]);
  assert.throws(() => createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text }] },
    receipt: { id: 'turn' }, sourceChunks: [{ entry_id: 'u', start: 0, end: text.length + 1, ordinal: 0 }], memory: { async enrich() {} } }), /evidence_chunk_invalid/);
});
