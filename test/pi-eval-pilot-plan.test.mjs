import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilotPlan, createCitedPilotPlan } from '../pi-extension/evaluation/pilot-plan.mjs';
import { ANSWERER_CITED_TOOLS_SHA256 } from '../pi-extension/evaluation/pi-calls.mjs';
import { fictionalCase, scoringPacket } from '../pi-extension/evaluation/fictional.mjs';
import { verifySeal } from '../pi-extension/evaluation/seal.mjs';

test('pilot plan freezes model roles, named empty baseline and strict safety before observations', () => {
  const cases = [{ publicCase: fictionalCase(), packet: scoringPacket() }];
  const seal = createPilotPlan({ cases, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64),
    codeSha: 'd'.repeat(40), routes: { candidate: { mode: 'soft' }, reviewer: { mode: 'soft' } } });
  const plan = verifySeal(seal, seal.digest);
  assert.deepEqual([plan.baseline.name, plan.answerer.model, plan.scorer.model, plan.budget.capNano, plan.safety.unsupportedActions],
    ['empty-derived (no prior memory system)', 'claude-sonnet-5-5', 'claude-sonnet-5-5', '100000000000', 0]);
});

test('fresh cited plan seals answerer v5 without changing candidate or scorer settings', () => {
  const options = { cases: [{ publicCase: fictionalCase(), packet: scoringPacket() }], sourceSha256: 'a'.repeat(64),
    datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64), codeSha: 'd'.repeat(40),
    routes: { candidate: { mode: 'soft' }, reviewer: { mode: 'soft' } } };
  const legacy = createPilotPlan(options).spec, cited = createCitedPilotPlan(options).spec;
  assert.deepEqual([cited.answerer.version, cited.answerer.citationProtocol, cited.answerer.tools_sha256,
    cited.budget.purposes.answerer.taskVersion, cited.budget.purposes.candidate, cited.scorer],
  ['answerer-r2-v5', 'returned-evidence-v1', ANSWERER_CITED_TOOLS_SHA256, 'answerer-r2-v5', legacy.budget.purposes.candidate, legacy.scorer]);
  assert.throws(() => createCitedPilotPlan({ ...options, resume: {} }), /resume_transition_forbidden/);
});
