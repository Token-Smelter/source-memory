import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilotPlan, createCitedPilotPlan, TREATMENTS } from '../pi-extension/evaluation/pilot-plan.mjs';
import { ANSWERER_CITED_TOOLS_SHA256 } from '../pi-extension/evaluation/pi-calls.mjs';
import { fictionalCase, scoringPacket } from '../pi-extension/evaluation/fictional.mjs';
import { verifySeal } from '../pi-extension/evaluation/seal.mjs';
import { BLOCK_EVIDENCE_CONTRACT } from '../pi-extension/evaluation/dev-dataset.mjs';

test('pilot plan freezes model roles, named empty baseline and strict safety before observations', () => {
  const cases = [{ publicCase: fictionalCase(), packet: scoringPacket() }];
  const seal = createPilotPlan({ cases, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64),
    codeSha: 'd'.repeat(40), routes: { candidate: { mode: 'soft' }, reviewer: { mode: 'soft' } } });
  const plan = verifySeal(seal, seal.digest);
  assert.deepEqual([plan.baseline.name, plan.answerer.model, plan.scorer.model, plan.budget.capNano, plan.safety.unsupportedActions],
    ['empty-derived (no prior memory system)', 'claude-sonnet-5-5', 'claude-sonnet-5-5', '100000000000', 0]);
});

test('fresh cited plan seals grounded scorer and leaves candidate and model routes unchanged', () => {
  const options = { cases: [{ publicCase: fictionalCase(), packet: { ...scoringPacket(), evidenceContract: BLOCK_EVIDENCE_CONTRACT } }], sourceSha256: 'a'.repeat(64),
    datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64), codeSha: 'd'.repeat(40),
    routes: { candidate: { mode: 'soft' }, reviewer: { mode: 'soft' } }, toolCallReviewSha256: 'f'.repeat(64) };
  const legacy = createPilotPlan(options).spec, cited = createCitedPilotPlan(options).spec;
  assert.deepEqual([cited.answerer.version, cited.answerer.citationProtocol, cited.answerer.tools_sha256,
    cited.budget.purposes.answerer.taskVersion, cited.budget.purposes.candidate, cited.scorer.route, cited.scorer.model,
    cited.scorer.version, cited.scorer.groundingProtocol, cited.rubric.version],
  ['answerer-r2-v5', 'returned-evidence-v1', ANSWERER_CITED_TOOLS_SHA256, 'answerer-r2-v5', legacy.budget.purposes.candidate,
    legacy.scorer.route, legacy.scorer.model, 'scorer-r2-v3-grounded', 'answerer-cited-evidence-v1', 'semantic-rubric-v2-citation-grounded']);
  assert.throws(() => createCitedPilotPlan({ ...options, resume: {} }), /resume_transition_forbidden/);
  assert.deepEqual([cited.toolCallReviewSha256, cited.designSha256], ['f'.repeat(64), '5b0c1fc1d3a94117c9518b8180b7587551514460ec0c9e47a35275063c5eaa6e']);
  const d0 = createCitedPilotPlan({ ...options, treatment: TREATMENTS.D0 }).spec;
  assert.deepEqual([Object.hasOwn(cited, 'treatment'), d0.treatment.retrieval], [false, 'oracle-catalog']);
  assert.throws(() => createCitedPilotPlan({ ...options, treatment: { ...TREATMENTS.D0, retrieval: 'search' } }), /pilot_plan_invalid/);
  assert.deepEqual(createCitedPilotPlan({ ...options, treatment: TREATMENTS.T1 }).spec.treatment, TREATMENTS.T1);
  assert.deepEqual([createCitedPilotPlan({ ...options, treatment: TREATMENTS.T1b }).spec.treatment.guidance, TREATMENTS.T1.guidance], ['typed-records-and-links-v3', 'typed-records-and-links-v2']);
  const model = createCitedPilotPlan({ ...options, treatment: TREATMENTS['M-DS'] }).spec;
  assert.deepEqual([model.budget.purposes.candidate.route, Object.keys(model.budget.routes).sort(), cited.budget.purposes.candidate.route],
    ['deepseek/deepseek-v4-flash', ['anthropic/claude-sonnet-5-5', 'deepseek/deepseek-v4-flash'], 'anthropic/claude-haiku-5-5']);
  assert.throws(() => createPilotPlan({ ...options, candidateRoute: 'other/model' }), /pilot_plan_invalid/);
  assert.throws(() => createCitedPilotPlan({ ...options, toolCallReviewSha256: undefined }), /pilot_plan_invalid/);
});
