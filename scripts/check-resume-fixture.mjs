import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageJournal, runCoveredInterval } from '../pi-extension/coverage.mjs';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';
import { runNamespaceHarness } from '../pi-extension/namespace-harness.mjs';
import { openUnixEmbeddingRelay } from '../pi-extension/unix-relay.mjs';
import { openDockerMemory } from '../pi-extension/docker-memory.mjs';
import { createPilotPlan } from '../pi-extension/evaluation/pilot-plan.mjs';
import { validatePilotResume } from '../pi-extension/evaluation/pilot-resume.mjs';
import { runPilotSequence } from '../pi-extension/evaluation/pilot-sequence.mjs';
import { fictionalCase, scoringPacket } from '../pi-extension/evaluation/fictional.mjs';

const root = realpathSync(process.cwd()), scope = 'fiction', sha = b => createHash('sha256').update(b).digest('hex');
const image = name => execFileSync('/usr/bin/docker', ['image', 'inspect', name, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
const images = { databaseImage: image('neo4j:5.26.14-community'), driverImage: image('node:22-bookworm-slim') };
const entries = ['a', 'b', 'c'].map((id, i) => ({ type: 'message', id, parentId: i ? ['a', 'b'][i - 1] : null,
  message: { role: 'assistant', content: `Fictional checkpoint ${id}.`, stopReason: 'stop' } }));
const checkpoints = ['a', 'b', 'c'].map((id, i) => ({ id, time: `2030-01-01T00:00:0${i * 2}Z` }));
const publicCase = { ...fictionalCase(), queryTime: '2030-01-01T00:00:03Z' };
const cases = [{ through: 'b', publicCase, packet: scoringPacket() }];
const seal = createPilotPlan({ cases, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64),
  codeSha: 'd'.repeat(40), routes: { candidate: { mode: 'fiction' }, reviewer: { mode: 'fiction' } } });

function environment() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-resume-fixture-')), runId = randomUUID();
  mkdirSync(join(dir, 'intents'), { mode: 0o700 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ neo4j: { uri: 'bolt://127.0.0.1:7687', auth: 'none' },
    scopes: { read: [scope], write: [scope] }, chunking: { words: 256, overlap: 32 },
    embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'embeddinggemma', dimensions: 768 }, index_on_write: true }), { mode: 0o600 });
  const docker = createNamespaceDocker({ ...images, mounts: { memory: root, scratch: dir }, runId,
    onResource: event => appendFileSync(join(dir, 'resources.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 }) });
  const relay = { open: ({ socketPath }) => openUnixEmbeddingRelay({ socketPath, fetchFn: async (_url, options) => {
    const input = JSON.parse(options.body).input;
    return new Response(JSON.stringify({ model: 'embeddinggemma', data: input.map((_item, index) => ({ index, embedding: [1, ...Array(767).fill(0)] })) }));
  } }) };
  const memoryFactory = async ({ driver }) => openDockerMemory({ containerId: driver, scope, configPath: '/scratch/config.json', intentDir: '/scratch/intents',
    spawnFn(program, args, options) { const child = spawn(program, args, options); child.stderr.resume(); return child; } });
  return { dir, runId, docker, relay, memoryFactory, socketPath: join(dir, 'embeddings.sock'), shimPort: 18080,
    warm: { model: 'embeddinggemma', dimensions: 768 } };
}

const first = environment();
let checkpointSnapshot, journalPath, firstResult;
firstResult = await runNamespaceHarness({ ...first, async work({ memory, driver }) {
  const journal = createCoverageJournal({ directory: first.dir, sessionKey: 'fiction-session' });
  journalPath = journal.path;
  try {
    const tracked = journal.track(memory);
    const session = { entries, conversation_id: 'fiction-session', scopes: [scope], memory: tracked, distiller: { memory: tracked,
      async run({ throughEntryId, turn, receipt }) {
        if (throughEntryId === 'b') throw Object.assign(new Error('fictional failure'), { code: 'fictional_failure' });
        const entry = turn.entries[0];
        await tracked.enrich(scope, { records: [{ id: 'fixture-record', kind: 'observation', text: 'Fictional memory.', status: 'proposed',
          attribution: 'fiction', evidence: [{ turn: receipt.id, entry_id: entry.id, start: 0, end: entry.text.length }] }], relations: [] }, { trigger: receipt.id });
        return { status: 'complete', disposition: 'committed' };
      } } };
    const one = await runCoveredInterval({ journal, session, through: 'a', cursor: null });
    if (one.disposition !== 'committed') throw new Error('fixture_first_checkpoint_failed');
    checkpointSnapshot = await first.docker.snapshot({ driver, scope, filename: `baseline-${first.runId}.json` });
    const two = await runCoveredInterval({ journal, session, through: 'b', cursor: 'a' });
    if (two.disposition !== 'failed' || journal.state().reconciliation_required) throw new Error('fixture_gap_failed');
    return { first: one.disposition, second: two.disposition, snapshot_sha256: checkpointSnapshot.sha256 };
  } finally { journal.close(); }
} });
if (firstResult.status !== 'complete') throw new Error('fixture_first_namespace_failed');
const journalBytes = readFileSync(journalPath), journalSha = sha(journalBytes), ledger = 'f'.repeat(64);
const report = { status: 'failed_or_partial', run_id: first.runId, seal_sha256: seal.digest,
  coverage: { dispositions: [{ through: 'a', disposition: 'committed' }, { through: 'b', disposition: 'failed' }] },
  artifacts: { source_snapshot: { sha256: 'a'.repeat(64) }, 'ledger.jsonl': { sha256: ledger },
    checkpoint_snapshots: [{ through: 'a', sha256: checkpointSnapshot.sha256 }] } };
const progress = [{ type: 'checkpoint', through: 'a', disposition: 'committed', snapshot: { sha256: checkpointSnapshot.sha256 } },
  { type: 'checkpoint', through: 'b', disposition: 'failed' }];
const currentSeal = createPilotPlan({ cases, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64),
  codeSha: 'e'.repeat(40), routes: { candidate: { mode: 'fiction' }, reviewer: { mode: 'fiction' } },
  resume: { priorRunId: first.runId, priorSealDigest: seal.digest, priorCodeSha: 'd'.repeat(40), cursor: 'a',
    snapshotSha256: checkpointSnapshot.sha256, journalSha256: journalSha, transition: 'structured-submission-format-only' } });
const second = environment();
copyFileSync(checkpointSnapshot.path, join(second.dir, 'snapshot.json'));
copyFileSync(journalPath, join(second.dir, journalPath.split('/').at(-1)));
const secondResult = await runNamespaceHarness({ ...second, async work({ memory, driver }) {
  const journal = createCoverageJournal({ directory: second.dir, sessionKey: 'fiction-session' });
  try {
    const resume = validatePilotResume({ report, seal, currentSeal, progress, journal, checkpoints, cases, cursor: 'a', snapshotSha256: checkpointSnapshot.sha256,
      journalSha256: journalSha, sourceSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), priorLedgerSha256s: [ledger] });
    const restored = JSON.parse(execFileSync('/usr/bin/docker', ['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/restore-scope.mjs',
      '/scratch/snapshot.json', checkpointSnapshot.sha256, scope], { encoding: 'utf8', timeout: 180000 }));
    if (!restored.equivalent || restored.source_sha256 !== checkpointSnapshot.sha256) throw new Error('fixture_restore_failed');
    const tracked = journal.track(memory), events = [];
    const session = { entries, conversation_id: 'fiction-session', scopes: [scope], memory: tracked,
      distiller: { memory: tracked, async run({ throughEntryId }) { events.push(`distill:${throughEntryId}`); return { status: 'complete', disposition: 'abstained' }; } } };
    const outcome = await runPilotSequence({ session, journal, checkpoints, cases, initialCursor: resume.cursor, retryFirst: resume.retryFirst,
      budget: { state: () => ({ stopped: null }) }, async evaluateCase() { events.push('case:b'); return { status: 'scored' }; } });
    if (outcome.status !== 'complete' || JSON.stringify(events) !== JSON.stringify(['distill:b', 'case:b', 'distill:c'])) throw new Error('fixture_resume_failed');
    return { restored, sequence: outcome.status, events, previous_record_count: (await memory.status(scope)).records };
  } finally { journal.close(); }
} });
const result = { first: firstResult.status, second: secondResult.status, resumed: secondResult.result ?? null,
  run_ids: [first.runId, second.runId], receipt_dirs: [first.dir, second.dir] };
process.stdout.write(`${JSON.stringify(result)}\n`);
if (secondResult.status !== 'complete' || result.resumed?.previous_record_count !== 1) process.exitCode = 1;
