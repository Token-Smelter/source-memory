import test from 'node:test';
import assert from 'node:assert/strict';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';
import { scoreCase as scoreAnchored, disagreement, createScorer as createAnchoredScorer, auditAlternatives as auditAnchored } from '../pi-extension/evaluation/scorer.mjs';
import { pairedReport as reportAnchored } from '../pi-extension/evaluation/report.mjs';
import { fictionalSettings, scoringPacket, fictionalTrace, clause } from '../pi-extension/evaluation/fictional.mjs';

const withDigest = options => ({ ...options, expectedDigest: options.seal.digest });
const scoreCase = options => scoreAnchored(withDigest({ ...options, trace: options.trace ?? fictionalTrace() }));
const createScorer = options => createAnchoredScorer(withDigest(options));
const auditAlternatives = options => auditAnchored(withDigest(options));
const pairedReport = options => reportAnchored(withDigest(options));

test('semantic scoring counts each requirement once and does not hide unsafe extra clauses', () => {
  const packet = scoringPacket();
  const judgment = { clauses: [clause('a', ['r1']), clause('b', ['r1']),
    clause('c', [], { support: 'fail', authority: 'fail', scope: 'fail', action: true })] };
  const out = scoreCase({ seal: sealComparison(fictionalSettings()), packet, judgment });
  assert.deepEqual([out.usefulness.credited, out.usefulness.total, out.safety.unsupportedActions,
    out.safety.authorityInflation, out.safety.scopeViolations, out.safety.unsupportedClaims], [1, 2, 1, 1, 1, 0]);
  packet.requirements[0].text = 'changed after freezing';
  assert.throws(() => scoreCase({ seal: sealComparison(fictionalSettings()), packet, judgment }), /packet_seal_mismatch/);
});

test('alternatives require source-linked rationale and recoverable relations', () => {
  const packet = scoringPacket();
  const seal = sealComparison(fictionalSettings());
  const alt = clause('a', ['r1'], { alternative: { rationale: 'equivalent', sourceIds: ['unknown'] } });
  assert.throws(() => scoreCase({ seal, packet, judgment: { clauses: [alt] } }), /alternative_unlinked/);
  alt.alternative.sourceIds = ['src'];
  alt.relation = { required: true, recoverable: false };
  assert.equal(scoreCase({ seal, packet, judgment: { clauses: [alt] } }).usefulness.credited, 0);
  alt.relation = { required: true, recoverable: true, itemIds: ['item'] };
  assert.throws(() => scoreCase({ seal, packet, judgment: { clauses: [alt] }, trace: { ...fictionalTrace(), returnedItemIds: [] } }), /relation_trace_missing/);
  assert.equal(scoreCase({ seal, packet, judgment: { clauses: [alt] }, trace: { ...fictionalTrace(), returnedItemIds: ['item'] } }).usefulness.credited, 1);
});

test('disputed requirements remain uncertain and sensitivity is explicit', () => {
  const packet = scoringPacket();
  const seal = sealComparison(fictionalSettings());
  const uncertain = { clauses: [clause('a', ['r1'], { time: 'uncertain' })] };
  const yes = { clauses: [clause('a', ['r1'])] };
  const out = scoreCase({ seal, packet, judgment: uncertain });
  assert.deepEqual(out.usefulness.sensitivity, { conservative: 0, exclude: 0, inclusive: 0.5 });
  assert.equal(disagreement([uncertain, yes]).disagreements, 1);
});

test('scorer uses the sealed packet and alternatives receive separate blinded audits', async () => {
  const seal = sealComparison(fictionalSettings());
  const packet = scoringPacket();
  const c = clause('a', ['r1'], { alternative: { rationale: 'Equivalent', sourceIds: ['src'] } });
  const scorer = createScorer({ seal, async judge(input) { assert.equal(input.rubric.version, seal.spec.rubric.version); return { clauses: [c] }; } });
  await assert.rejects(scorer.score({ packet, answer: { text: 'Mira chose 4' }, trace: { ...fictionalTrace(), caseDigest: '0'.repeat(64) } }), /case_trace_mismatch/);
  const result = await scorer.score({ packet, answer: { text: 'Mira chose 4' }, trace: fictionalTrace() });
  const sample = auditAlternatives({ seal, alternatives: result.score.alternatives });
  assert.equal(sample.complete, false);
  assert.equal('caseId' in sample.selected[0], false);
  const key = sample.selected[0].key;
  assert.throws(() => auditAlternatives({ seal, alternatives: result.score.alternatives,
    audits: [{ key, verdict: 'pass', rationale: 'ok', auditor: 'fiction/two' }] }), /audit_not_independent/);
  assert.equal(auditAlternatives({ seal, alternatives: result.score.alternatives,
    audits: [{ key, verdict: 'pass', rationale: 'ok', auditor: 'fiction/other' }] }).complete, true);
});

test('paired sensitivity recomputes uncertain requirements rather than accepting a post-hoc score', () => {
  const seal = sealComparison(fictionalSettings());
  const shared = { sealDigest: seal.digest, packetDigest: seal.spec.packets.c1 };
  const row = { caseId: 'c1', sessions: ['s1'], ...shared, arms: {
    candidate: { ...shared, usefulness: { credited: 1, uncertain: 1, total: 2 }, safety: { unsupportedActions: 0, unsupportedClaims: 0, authorityInflation: 0, scopeViolations: 0 } },
    baseline: { ...shared, usefulness: { credited: 1, uncertain: 0, total: 2 } },
  } };
  const report = pairedReport({ seal, rows: [row], dependencies: [['s1', 's2']] });
  assert.deepEqual(report.sensitivity, { conservative: 0, excluded: 0.5, inclusive: 0.5, excludedCases: 0 });
});

test('paired reports retain original seals for compatible carried cases', () => {
  const oldSettings = fictionalSettings(), newSettings = fictionalSettings();
  oldSettings.codeSha = 'a'.repeat(40); newSettings.codeSha = 'b'.repeat(40);
  const oldSeal = sealComparison(oldSettings);
  newSettings.resume = { caseHandbacks: [{ caseId: 'c1', sourceSealDigest: oldSeal.digest, sourceCodeSha: oldSettings.codeSha }] };
  const seal = sealComparison(newSettings);
  const row = (caseId, origin) => {
    const shared = { sealDigest: origin.digest, packetDigest: origin.spec.packets[caseId] };
    return { caseId, sessions: ['same-source'], ...shared, arms: {
      candidate: { ...shared, usefulness: { credited: 1, uncertain: 0, total: 2 },
        safety: { unsupportedActions: 0, unsupportedClaims: 0, authorityInflation: 0, scopeViolations: 0 } },
      baseline: { ...shared, usefulness: { credited: 0, uncertain: 0, total: 2 } } } };
  };
  const result = pairedReport({ seal, provenance: [oldSeal], rows: [row('c1', oldSeal), row('c2', seal)], dependencies: [['s1', 's2']] });
  assert.deepEqual([result.sealDigest, result.provenance.mixedCandidateCode, result.cases], [null, true, 2]);
  const changed = structuredClone(oldSettings); changed.rubric.instructions += ' changed';
  assert.throws(() => pairedReport({ seal, provenance: [sealComparison(changed)], rows: [row('c1', oldSeal)], dependencies: [['s1', 's2']] }), /provenance_mismatch/);
});

test('paired report resamples connected source histories jointly and applies safety separately', () => {
  const seal = sealComparison(fictionalSettings());
  const rows = [
    { caseId: 'c1', sessions: ['s1'], arms: { candidate: { score: 1, safety: { unsupportedActions: 1, unsupportedClaims: 0, authorityInflation: 0, scopeViolations: 0 } }, baseline: { score: 0.5 } } },
    { caseId: 'c2', sessions: ['s2'], arms: { candidate: { score: 0, safety: { unsupportedActions: 0, unsupportedClaims: 0, authorityInflation: 0, scopeViolations: 0 } }, baseline: { score: 0.5 } } },
    { caseId: 'c3', sessions: ['s3'], arms: { candidate: { score: 1, safety: { unsupportedActions: 0, unsupportedClaims: 0, authorityInflation: 0, scopeViolations: 0 } }, baseline: { score: 0 } } },
  ];
  for (const row of rows) {
    row.sealDigest = seal.digest; row.packetDigest = seal.spec.packets[row.caseId];
    for (const arm of Object.values(row.arms)) {
      arm.sealDigest = seal.digest; arm.packetDigest = row.packetDigest;
      arm.usefulness = { credited: arm.score * 2, uncertain: 0, total: 2 }; delete arm.score;
    }
  }
  const report = pairedReport({ seal, rows, dependencies: [['s1', 's2']] });
  assert.equal(report.clusters, 2);
  assert.equal(report.pairedDelta, 1 / 3);
  assert.deepEqual(report.sensitivity, { conservative: 1 / 3, excluded: 1 / 3, inclusive: 1 / 3, excludedCases: 0 });
  assert.equal(report.safety.unsupportedActions.passes, false);
  assert.equal(report.confidence.kind, 'cluster-bootstrap-percentile');
  const one = pairedReport({ seal, rows: rows.slice(0, 2), dependencies: [['s1', 's2']] });
  assert.equal(one.confidence.kind, 'descriptive-only');
  rows[0].packetDigest = '0'.repeat(64);
  assert.throws(() => pairedReport({ seal, rows, dependencies: [['s1', 's2']] }), /packet_seal_mismatch/);
  assert.throws(() => pairedReport({ seal, rows, dependencies: [] }), /dependency_seal_mismatch/);
});
