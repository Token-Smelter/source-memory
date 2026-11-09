import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonical } from '../src/core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const POLICY_SHA256 = '737f85bf69d9a5e6bc892bf5c06ca40c59c8167e3edc2cee5fccc1f9e786ff31';
const CALIBRATION_SHA256 = '28cfd4378a286b781be665bf63876fc89615e5c49d354e36c5bf653751c52703';
const COVERAGE_SHA256 = '907da5f0582b654b67fef43c75afbb7c37b608f685114d1c0984cb579f225e9f';
// v2 adds a routine action/result case (expected abstain) and runner-facing transcripts that carry only source content; v1 stays the frozen contract set.
const CALIBRATION_V2_SHA256 = 'c191171d8c2b976f5c9d68afcf851da52f8892826f99b6b93c9c54aaad33d228';

function readSealed(name, expected) {
  const bytes = readFileSync(new URL(`./policy/${name}`, import.meta.url));
  if (sha(bytes) !== expected) throw fail('policy_artifact_changed');
  return JSON.parse(bytes);
}

/** The task prefix and policy are one versioned artifact, independent of a treatment. */
export function retentionPolicy() {
  return { sha256: POLICY_SHA256, value: readSealed('retention-r2-v1.json', POLICY_SHA256) };
}

export function fictionalCalibration() {
  const value = readSealed('calibration-r2-v1.json', CALIBRATION_SHA256);
  if (value.policy_id !== retentionPolicy().value.id || value.fictional_only !== true) throw fail('calibration_invalid');
  return { sha256: CALIBRATION_SHA256, value };
}

export function fictionalCalibrationV2() {
  const value = readSealed('calibration-r2-v2.json', CALIBRATION_V2_SHA256);
  if (value.policy_id !== retentionPolicy().value.id || value.fictional_only !== true) throw fail('calibration_invalid');
  return { sha256: CALIBRATION_V2_SHA256, value };
}

export function fictionalCoverage() {
  const value = readSealed('coverage-r2-v1.json', COVERAGE_SHA256);
  if (value.policy_id !== retentionPolicy().value.id || value.fictional_only !== true) throw fail('coverage_invalid');
  return { sha256: COVERAGE_SHA256, value };
}

/** A treatment declares its complete diff; policy bytes are not a treatment surface. */
export function checkTreatmentDiff({ baseline, candidate, rationale }) {
  const policy = retentionPolicy();
  const fields = ['wording', 'examples', 'tool_presentation', 'bounded_search_strategy'];
  if (!baseline || !candidate || typeof rationale !== 'object' || rationale === null
    || baseline.policy_sha256 !== policy.sha256 || candidate.policy_sha256 !== policy.sha256
    || Object.keys(baseline).some(key => ![...fields, 'policy_sha256'].includes(key))
    || Object.keys(candidate).some(key => ![...fields, 'policy_sha256'].includes(key))
    || fields.some(key => typeof baseline[key] !== 'string' || typeof candidate[key] !== 'string')) throw fail('treatment_invalid');
  const changed = fields.filter(key => baseline[key] !== candidate[key]);
  if (changed.some(key => typeof rationale[key] !== 'string' || !rationale[key].trim())
    || Object.keys(rationale).some(key => !changed.includes(key))) throw fail('treatment_rationale_required');
  return { policy_sha256: policy.sha256, changed, diff_sha256: sha(canonical({ baseline, candidate, rationale })) };
}

/** Compare independent structured assessments of every fictional case, not the model's self-report. */
export function checkCalibrationAssessments({ assessments, assessor, policySha256, calibrationSha256 }) {
  const calibration = fictionalCalibration();
  if (policySha256 !== POLICY_SHA256 || calibrationSha256 !== calibration.sha256
    || typeof assessor !== 'string' || !assessor.trim() || !Array.isArray(assessments)) throw fail('calibration_invalid');
  const byId = new Map();
  for (const assessment of assessments) {
    if (!assessment || typeof assessment.id !== 'string' || byId.has(assessment.id)
      || !Array.isArray(assessment.observed) || assessment.observed.some(row => typeof row !== 'string')
      || typeof assessment.action !== 'string' || typeof assessment.evidence_ref !== 'string' || !assessment.evidence_ref.trim()) throw fail('calibration_invalid');
    byId.set(assessment.id, assessment);
  }
  if (byId.size !== calibration.value.cases.length || calibration.value.cases.some(row => !byId.has(row.id))) throw fail('calibration_incomplete');
  const failures = [];
  for (const fixture of calibration.value.cases) {
    const actual = byId.get(fixture.id);
    const observed = new Set(actual.observed);
    const missing = fixture.required.filter(item => !observed.has(item));
    const forbidden = fixture.forbidden.filter(item => observed.has(item));
    if (actual.action !== fixture.expected_action || missing.length || forbidden.length) failures.push({ id: fixture.id, expected_action: fixture.expected_action,
      actual_action: actual.action, missing, forbidden });
  }
  return { pass: failures.length === 0, policy_sha256: POLICY_SHA256, calibration_sha256: calibration.sha256,
    assessor, assessments_sha256: sha(canonical(assessments)), failures };
}
