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

test('resume refuses a snapshot or ledger that was not frozen by the prior run', () => fixture(async ({ args }) => {
  assert.throws(() => validatePilotResume({ ...args, snapshotSha256: '2'.repeat(64) }), /resume_treatment_mismatch/);
  assert.throws(() => validatePilotResume({ ...args, priorLedgerSha256s: [] }), /resume_provenance_mismatch/);
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
