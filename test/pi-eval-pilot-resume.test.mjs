import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createPilotPlan } from '../pi-extension/evaluation/pilot-plan.mjs';
import { validatePilotResume } from '../pi-extension/evaluation/pilot-resume.mjs';
import { runPilotSequence } from '../pi-extension/evaluation/pilot-sequence.mjs';
import { fictionalCase, scoringPacket } from '../pi-extension/evaluation/fictional.mjs';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';
import { ANSWERER_FORMAT_SUFFIX, SCORER_FORMAT_SUFFIX } from '../pi-extension/evaluation/pi-calls.mjs';

async function fixture(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-resume-'));
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  try {
    const memory = journal.track({ async ingest(_scope, turn) { return { id: `turn-${turn.turn_id}` }; }, async enrich() { return { records: ['fiction'] }; } });
    journal.begin({ through: 'a', cursor: null });
    await memory.enrich('fiction', { records: [] });
    journal.finish('committed');
    const failed = journal.begin({ through: 'b', cursor: 'a' });
    await memory.enrich('fiction', { records: ['different'] });
    journal.finish('failed', 'fictional_failure');
    journal.reconcile({ id: failed, disposition: 'failed', evidenceRef: 'fictional-evidence' });
    const cases = [{ through: 'c', publicCase: fictionalCase(), packet: scoringPacket() }];
    const seal = createPilotPlan({ cases, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64),
      codeSha: 'd'.repeat(40), routes: { candidate: { mode: 'soft' }, reviewer: { mode: 'soft' } } });
    const snapshot = 'e'.repeat(64), ledger = 'f'.repeat(64), journalSha = '1'.repeat(64);
    const checkpoints = [{ id: 'a', time: '2030-01-01T00:00:00Z' }, { id: 'b', time: '2030-01-01T00:00:02Z' },
      { id: 'c', time: '2030-01-01T00:00:04Z' }];
    const report = { status: 'failed_or_partial', run_id: 'fiction-run', seal_sha256: seal.digest,
      coverage: { dispositions: [{ through: 'a', disposition: 'committed' }, { through: 'b', disposition: 'failed' }] },
      artifacts: { source_snapshot: { sha256: 'a'.repeat(64) }, 'ledger.jsonl': { sha256: ledger },
        checkpoint_snapshots: [{ through: 'a', sha256: snapshot }] } };
    const progress = [{ type: 'checkpoint', through: 'a', disposition: 'committed', snapshot: { sha256: snapshot } },
      { type: 'checkpoint', through: 'b', disposition: 'failed', snapshot: null }];
    const currentSeal = createPilotPlan({ cases, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64),
      codeSha: 'e'.repeat(40), routes: { candidate: { mode: 'soft' }, reviewer: { mode: 'soft' } },
      resume: { priorRunId: 'fiction-run', priorSealDigest: seal.digest, priorCodeSha: 'd'.repeat(40), cursor: 'a',
        snapshotSha256: snapshot, journalSha256: journalSha, transition: 'structured-submission-format-only' } });
    const args = { report, seal, currentSeal, progress, journal, checkpoints, cases, cursor: 'a', snapshotSha256: snapshot, journalSha256: journalSha,
      sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), priorLedgerSha256s: [ledger] };
    await fn({ args, journal, memory, checkpoints });
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('resume validates the prior seal, covered journal prefix, clean snapshot and reconciled retry', () => fixture(async ({ args }) => {
  const result = validatePilotResume(args);
  assert.deepEqual([result.cursor, result.prefixCount, result.retryFirst, result.priorSealDigest], ['a', 1, true, args.seal.digest]);
}));

test('a sealed evaluator format transition preserves the old rubric and score rules', () => fixture(async ({ args }) => {
  const old = structuredClone(args.seal.spec);
  old.answerer.version = 'answerer-r2-v1'; old.answerer.instructions = old.answerer.instructions.slice(0, -ANSWERER_FORMAT_SUFFIX.length);
  delete old.answerer.repair_instruction; delete old.answerer.limits.formatRepairCalls; old.answerer.tools_sha256 = 'a'.repeat(64);
  old.scorer.version = 'scorer-r2-v1'; old.scorer.instructions = old.scorer.instructions.slice(0, -SCORER_FORMAT_SUFFIX.length)
    .replace('Use this JSON object schema:', 'Return JSON only, without a code fence:');
  delete old.scorer.tools_sha256; delete old.scorer.repair_instruction; delete old.scorer.formatRepairCalls;
  const previousSeal = sealComparison(old);
  const currentSeal = createPilotPlan({ cases: args.cases, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64),
    codeSha: 'e'.repeat(40), routes: { candidate: { mode: 'soft' }, reviewer: { mode: 'soft' } },
    resume: { priorRunId: args.report.run_id, priorSealDigest: previousSeal.digest, priorCodeSha: old.codeSha, cursor: 'a',
      snapshotSha256: args.snapshotSha256, journalSha256: args.journalSha256, transition: 'structured-evaluator-submission-only' } });
  const report = { ...args.report, seal_sha256: previousSeal.digest };
  assert.equal(validatePilotResume({ ...args, report, seal: previousSeal, currentSeal }).cursor, 'a');
  const changed = structuredClone(currentSeal.spec); changed.rubric.instructions += ' changed';
  assert.throws(() => validatePilotResume({ ...args, report, seal: previousSeal, currentSeal: sealComparison(changed) }), /resume_treatment_mismatch/);
}));

test('the owner-approved abstention interpretation is pinned as an explicit transition', () => fixture(async ({ args }) => {
  const old = structuredClone(args.seal.spec); delete old.interpretation;
  const previousSeal = sealComparison(old);
  const currentSeal = createPilotPlan({ cases: args.cases, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64),
    codeSha: 'e'.repeat(40), routes: { candidate: { mode: 'soft' }, reviewer: { mode: 'soft' } },
    resume: { priorRunId: args.report.run_id, priorSealDigest: previousSeal.digest, priorCodeSha: old.codeSha, cursor: 'a',
      snapshotSha256: args.snapshotSha256, journalSha256: args.journalSha256, transition: 'interpretation-02-abstention-clarification' } });
  const report = { ...args.report, seal_sha256: previousSeal.digest };
  assert.equal(validatePilotResume({ ...args, report, seal: previousSeal, currentSeal }).transition, 'interpretation-02-abstention-clarification');
}));

test('resume refuses a snapshot or ledger that was not frozen by the prior run', () => fixture(async ({ args }) => {
  assert.throws(() => validatePilotResume({ ...args, snapshotSha256: '2'.repeat(64) }), /resume_treatment_mismatch/);
  assert.throws(() => validatePilotResume({ ...args, priorLedgerSha256s: [] }), /resume_provenance_mismatch/);
}));

test('resume at an unscored case requires its exact pre-answer snapshot', () => fixture(async ({ args }) => {
  const pending = [{ ...args.cases[0], through: 'a' }];
  const report = { ...args.report, coverage: null, artifacts: { ...args.report.artifacts,
    case_snapshots: [{ case_id: pending[0].publicCase.id, sha256: args.snapshotSha256 }] } };
  assert.equal(validatePilotResume({ ...args, report, cases: pending }).cursor, 'a');
  assert.throws(() => validatePilotResume({ ...args, report: { ...report, artifacts: { ...report.artifacts, case_snapshots: [] } }, cases: pending }), /resume_case_snapshot_mismatch/);
}));

test('a resumed sequence answers a pending cursor case before the next source interval', () => fixture(async ({ journal, memory, checkpoints, args }) => {
  const events = [];
  const entries = ['a', 'b', 'c'].map((id, i) => ({ type: 'message', id, parentId: i ? ['a', 'b'][i - 1] : null,
    message: { role: 'assistant', content: 'fiction', stopReason: 'stop' } }));
  const session = { entries, conversation_id: 'fiction', scopes: ['fiction'], memory,
    distiller: { memory, async run({ throughEntryId }) { events.push(`distill:${throughEntryId}`); return { status: 'complete', disposition: 'abstained' }; } } };
  const cases = [{ through: 'a', publicCase: { ...args.cases[0].publicCase, queryTime: '2030-01-01T00:00:01Z' } }];
  const result = await runPilotSequence({ session, journal, checkpoints, cases, initialCursor: 'a', retryFirst: true,
    budget: { state: () => ({ stopped: null }) }, async evaluateCase() { events.push('case:a'); return { status: 'scored' }; } });
  assert.deepEqual([result.status, events], ['complete', ['case:a', 'distill:b', 'distill:c']]);
}));

test('a scored earlier case requires an exactly sealed handback descriptor', () => fixture(async ({ args }) => {
  const completed = [{ ...args.cases[0], through: 'a' }];
  const descriptor = { caseId: completed[0].publicCase.id, sourceRunId: 'fiction-run', sourceReportSha256: '1'.repeat(64),
    sourceSealDigest: args.seal.digest, sourceCodeSha: args.seal.spec.codeSha, snapshotSha256: args.snapshotSha256,
    resultsSha256: '2'.repeat(64), outputsSha256: '3'.repeat(64), ledgerSha256: 'f'.repeat(64) };
  const spec = structuredClone(args.currentSeal.spec); spec.resume.caseHandbacks = [descriptor];
  const currentSeal = sealComparison(spec);
  assert.equal(validatePilotResume({ ...args, currentSeal, cases: completed, caseHandbacks: [descriptor] }).cursor, 'a');
  assert.throws(() => validatePilotResume({ ...args, currentSeal, cases: completed, caseHandbacks: [] }), /resume_treatment_mismatch/);
}));

test('a carried scored case is not re-evaluated during resume', () => fixture(async ({ journal, memory, checkpoints, args }) => {
  const events = [];
  const entries = ['a', 'b', 'c'].map((id, i) => ({ type: 'message', id, parentId: i ? ['a', 'b'][i - 1] : null,
    message: { role: 'assistant', content: 'fiction', stopReason: 'stop' } }));
  const session = { entries, conversation_id: 'fiction', scopes: ['fiction'], memory,
    distiller: { memory, async run({ throughEntryId }) { events.push(throughEntryId); return { status: 'complete', disposition: 'abstained' }; } } };
  const cases = [{ through: 'a', publicCase: { ...args.cases[0].publicCase, queryTime: '2030-01-01T00:00:01Z' } }];
  const result = await runPilotSequence({ session, journal, checkpoints, cases, initialCursor: 'a', retryFirst: true,
    completedCaseIds: [cases[0].publicCase.id], budget: { state: () => ({ stopped: null }) },
    async evaluateCase() { throw new Error('must_not_reevaluate'); } });
  assert.deepEqual([result.status, events], ['complete', ['b', 'c']]);
}));

test('a resumed sequence retries only the first failed interval and never reprocesses its prefix', () => fixture(async ({ journal, memory, checkpoints }) => {
  const events = [];
  const entries = ['a', 'b', 'c'].map((id, i) => ({ type: 'message', id, parentId: i ? ['a', 'b'][i - 1] : null,
    message: { role: 'assistant', content: 'fiction', stopReason: 'stop' } }));
  const session = { entries, conversation_id: 'fiction', scopes: ['fiction'], memory,
    distiller: { memory, async run({ throughEntryId }) { events.push(throughEntryId); return { status: 'complete', disposition: 'abstained' }; } } };
  const result = await runPilotSequence({ session, journal, checkpoints, cases: [], initialCursor: 'a', retryFirst: true,
    budget: { state: () => ({ stopped: null }) }, async evaluateCase() {} });
  assert.deepEqual([result.status, result.cursor, events], ['complete', 'c', ['b', 'c']]);
}));
