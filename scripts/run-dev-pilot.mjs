import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadavg } from 'node:os';
import { pathToFileURL } from 'node:url';
import { verifyChronologicalCheckpoint } from '../pi-extension/chronology.mjs';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createImageArchive } from '../pi-extension/image-archive.mjs';
import { ensureIndexed } from '../pi-extension/index-readiness.mjs';
import { createDerivedAdapter } from '../pi-extension/derived-retrieval.mjs';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';
import { runNamespaceHarness } from '../pi-extension/namespace-harness.mjs';
import { openUnixEmbeddingRelay } from '../pi-extension/unix-relay.mjs';
import { openDockerMemory } from '../pi-extension/docker-memory.mjs';
import { createSliceSession, resolvePiModels } from '../pi-extension/slice-runtime.mjs';
import { createAnswerer } from '../pi-extension/evaluation/answerer.mjs';
import { prepareDevelopmentCases } from '../pi-extension/evaluation/dev-dataset.mjs';
import { createPiAnswererResponder, createPiScorerJudge, ANSWERER_TOOLS_SHA256 } from '../pi-extension/evaluation/pi-calls.mjs';
import { createPilotPlan } from '../pi-extension/evaluation/pilot-plan.mjs';
import { priorSoftSpend } from '../pi-extension/evaluation/prior-spend.mjs';
import { checkpointId, runPilotSequence } from '../pi-extension/evaluation/pilot-sequence.mjs';
import { pairedReport } from '../pi-extension/evaluation/report.mjs';
import { createScorer } from '../pi-extension/evaluation/scorer.mjs';
import { createSoftBudget } from '../pi-extension/evaluation/soft-budget.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolveReply => setTimeout(resolveReply, ms));
function pinned(path, expected, max = 100_000_000) {
  if (!isAbsolute(path ?? '') || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw fail('path_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > max) throw fail('input_invalid');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size || sha(bytes) !== expected) throw fail('input_changed');
    return bytes;
  } finally { closeSync(fd); }
}
function privateWriter(path) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return { append(row) { const bytes = Buffer.from(`${JSON.stringify(row)}\n`); for (let i = 0; i < bytes.length;) i += writeSync(fd, bytes, i, bytes.length - i); fsyncSync(fd); }, close() { closeSync(fd); } };
}
function writePrivate(path, value) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
function rates(model) {
  const tiers = [model.cost, ...(model.cost?.tiers ?? [])];
  const result = {};
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    const values = tiers.map(row => row?.[key]).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (!values.length) throw fail('rate_unavailable');
    result[key] = Math.ceil(Math.max(...values) * 1000);
  }
  return { maxOutputTokens: 4096, ratesNanoPerToken: result, rateEvidence: 'preflight Pi SDK model catalog; highest declared tier; API-equivalent only' };
}
function trackSnapshot(memory) {
  let epoch = 0, lock = false, invalid = false;
  const writes = new Set(['ingest', 'enrich', 'applyLinks', 'applyOutcome', 'index']);
  const client = new Proxy(memory, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (!writes.has(key)) return value.bind(target);
    return async (...args) => {
      if (lock || invalid) throw fail('snapshot_locked');
      try { const result = await value.apply(target, args); epoch++; return result; }
      catch (error) { if (error?.effect !== 'refused') invalid = true; throw error; }
    };
  } });
  return { client, acquire(queryTime) {
    if (lock || invalid) throw fail('snapshot_unverified');
    lock = true;
    const id = `epoch-${epoch}`;
    return { id, verify: async time => lock && !invalid && time === queryTime && id === `epoch-${epoch}` ? id : null,
      release() { lock = false; } };
  } };
}
function exactRoute(model) {
  const url = new URL(model.baseUrl);
  if (url.origin !== 'http://127.0.0.1:3003' || url.username || url.password) throw fail('route_changed');
  return `${model.provider}/${model.id}`;
}

async function main() {
  const [manifestPath, manifestSha, sourceKey, sdkIndex, sdkIndexSha, sdkSession, sdkSessionSha, parentDir] = process.argv.slice(2);
  if (process.argv.length !== 10 || basename(manifestPath ?? '') !== 'CASE-MANIFEST.json' || basename(dirname(manifestPath ?? '')) !== 'development'
    || !isAbsolute(parentDir ?? '')) throw fail('arguments_invalid');
  const parent = realpathSync(parentDir), parentStat = statSync(parent);
  if (parent !== parentDir || !parentStat.isDirectory() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077)) throw fail('work_dir_invalid');
  const manifest = JSON.parse(pinned(manifestPath, manifestSha, 2_000_000).toString('utf8'));
  if (manifest.schema !== 'source-memory-r2-development-case-manifest/v1' || !String(manifest.state).includes('frozen')
    || !manifest.case_sources?.includes(sourceKey) || manifest.frozen_design_sha256 !== '5b0c1fc1d3a94117c9518b8180b7587551514460ec0c9e47a35275063c5eaa6e') throw fail('manifest_invalid');
  const roots = manifest.source_pins.filter(row => row.source_key === sourceKey);
  if (roots.length !== 1) throw fail('source_invalid');
  const source = roots[0], datasetRoot = dirname(dirname(manifestPath));
  const input = key => {
    const descriptor = manifest.files?.[key];
    if (!descriptor || !Number.isSafeInteger(descriptor.bytes)) throw fail('manifest_invalid');
    const bytes = pinned(join(datasetRoot, key), descriptor.sha256);
    if (bytes.length !== descriptor.bytes) throw fail('input_changed');
    return bytes.toString('utf8');
  };
  const proofs = JSON.parse(input('development/checkpoint-proofs.json')).cases.filter(row => row.source_key === sourceKey);
  const availability = input('development/availability.jsonl').trimEnd().split('\n').map(JSON.parse).filter(row => row.source_key === sourceKey);
  const cases = input('development/cases.jsonl').trimEnd().split('\n').map(JSON.parse).filter(row => row.split === 'development' && row.pre_answer_store_snapshot?.source_key === sourceKey);
  if (!proofs.length || !cases.length || proofs.some(row => row.snapshot_path !== source.snapshot_path || row.source_sha256 !== source.source_sha256)) throw fail('dataset_invalid');
  const sourceBytes = pinned(source.snapshot_path, source.source_sha256);
  pinned(sdkIndex, sdkIndexSha, 5_000_000); pinned(sdkSession, sdkSessionSha, 5_000_000);
  const pi = await import(pathToFileURL(sdkIndex).href), builder = await import(pathToFileURL(sdkSession).href);
  const verified = proofs.map(proof => verifyChronologicalCheckpoint({ bytes: sourceBytes, proof, availability, pi: builder }));
  const rows = sourceBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse).slice(1);
  const scope = cases[0].read_scopes?.[0];
  const prepared = prepareDevelopmentCases({ cases, proofs, verified, entries: rows, availability, sourceKey, scope, sourceSha256: source.source_sha256 });
  const byId = new Map(rows.map(row => [row.id, row]));
  const last = [...prepared].sort((a, b) => Date.parse(a.publicCase.queryTime) - Date.parse(b.publicCase.queryTime)).at(-1).through;
  const chain = [];
  for (let id = last; id;) { const row = byId.get(id); if (!row) throw fail('ancestry_invalid'); chain.unshift(row); id = row.parentId; }
  const checkpoints = chain.filter(row => row.type === 'message' && row.message?.role === 'assistant'
    && !['error', 'aborted', 'toolUse'].includes(row.message.stopReason)
    && !row.message.content?.some?.(part => ['toolCall', 'tool_use'].includes(part.type))).map(row => ({ id: row.id, time: row.timestamp }));
  if (!checkpoints.length || checkpoints.at(-1).id !== last || checkpoints.length > 110) throw fail('schedule_invalid');
  const offsets = new Map(); let start = 0;
  for (let i = 0; i < sourceBytes.length; i++) if (sourceBytes[i] === 10) {
    const row = JSON.parse(sourceBytes.subarray(start, i + 1).toString('utf8'));
    if (row.type !== 'session') offsets.set(row.id, i + 1);
    start = i + 1;
  }
  for (const checkpoint of checkpoints) {
    const end = offsets.get(checkpoint.id);
    if (!end) throw fail('checkpoint_invalid');
    const prefixRows = sourceBytes.subarray(0, end).toString('utf8').trimEnd().split('\n').map(JSON.parse).slice(1);
    const a = builder.buildSessionContext(prefixRows, checkpoint.id).messages;
    const b = builder.buildSessionContext(rows, checkpoint.id).messages;
    if (sha(JSON.stringify(a)) !== sha(JSON.stringify(b))) throw fail('pi_context_mismatch');
  }
  const { runtime, model, reviewerModel } = await resolvePiModels({ pi, modelId: 'anthropic/claude-haiku-5-5', reviewerId: 'anthropic/claude-sonnet-5-5' });
  if (exactRoute(model) !== 'anthropic/claude-haiku-5-5' || exactRoute(reviewerModel) !== 'anthropic/claude-sonnet-5-5') throw fail('route_changed');
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw fail('working_tree_dirty');
  const routeRates = { candidate: rates(model), reviewer: rates(reviewerModel) };
  const priorPath = process.env.PILOT_PRIOR_LEDGER, priorSha = process.env.PILOT_PRIOR_LEDGER_SHA256;
  if (Boolean(priorPath) !== Boolean(priorSha) || (process.env.PILOT_PRIOR_LEDGERS && priorPath)) throw fail('prior_ledger_invalid');
  let priorLedgers = priorPath ? [{ path: priorPath, sha256: priorSha }] : [];
  if (process.env.PILOT_PRIOR_LEDGERS) {
    try { priorLedgers = JSON.parse(process.env.PILOT_PRIOR_LEDGERS); } catch { throw fail('prior_ledger_invalid'); }
  }
  if (!Array.isArray(priorLedgers) || new Set(priorLedgers.map(row => row?.sha256)).size !== priorLedgers.length) throw fail('prior_ledger_invalid');
  const previous = priorLedgers.reduce((sum, row) => sum + BigInt(priorSoftSpend(pinned(row.path, row.sha256, 10_000_000).toString('utf8'))), 0n);
  const remaining = 100000000000n - previous;
  if (remaining <= 0n) throw fail('soft_cap_exhausted');
  const seal = createPilotPlan({ cases: prepared, sourceSha256: source.source_sha256, datasetSha256: manifestSha, sdkSha256: sdkSessionSha,
    codeSha, routes: routeRates, capNano: remaining.toString(), priorSpendNano: previous.toString() });
  const runId = randomUUID(), dir = mkdtempSync(join(parent, 'pilot-'));
  const driverDir = join(dir, 'driver'), piDir = join(dir, 'pi'), imageDir = join(dir, 'image-blobs');
  mkdirSync(driverDir, { mode: 0o700 }); mkdirSync(piDir, { mode: 0o700 }); mkdirSync(imageDir, { mode: 0o700 });
  mkdirSync(join(driverDir, 'intents'), { mode: 0o700 });
  const sourceCopy = join(dir, 'source.jsonl'); writePrivate(sourceCopy, sourceBytes);
  writePrivate(join(dir, 'seal.json'), seal);
  writePrivate(join(driverDir, 'config.json'), { neo4j: { uri: 'bolt://127.0.0.1:7687', auth: 'none' }, scopes: { read: [scope], write: [scope] },
    chunking: { words: 256, overlap: 32 }, embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'embeddinggemma', dimensions: 768, timeout_ms: 120000 }, index_on_write: true });
  const resources = privateWriter(join(dir, 'resources.jsonl')), progress = privateWriter(join(dir, 'progress.jsonl'));
  const memoryLog = privateWriter(join(dir, 'memory-receipts.jsonl')), results = privateWriter(join(dir, 'case-results.jsonl'));
  const relayLog = privateWriter(join(dir, 'embedding-relay.jsonl'));
  const image = name => execFileSync('/usr/bin/docker', ['image', 'inspect', name, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
  const docker = createNamespaceDocker({ databaseImage: image('neo4j:5.26.14-community'), driverImage: image('node:22-bookworm-slim'),
    mounts: { memory: resolve('.'), scratch: driverDir }, runId, onResource: row => resources.append(row) });
  const budget = createSoftBudget({ path: join(dir, 'ledger.jsonl'), capNano: remaining.toString(), sessionKey: `pilot-${runId}`, sealSha256: seal.digest,
    routes: { [exactRoute(model)]: routeRates.candidate, [exactRoute(reviewerModel)]: routeRates.reviewer } });
  let meta = { purpose: 'candidate', arm: 'candidate', checkpoint: 'preflight', task_version: 'distiller-r2-v1', policy_version: seal.spec.policyVersion };
  let journal, sequenceResult, snapshot, failure = null;
  const reportRows = [], caseSnapshots = {};
  const imageHashes = { database: image('neo4j:5.26.14-community'), driver: image('node:22-bookworm-slim') };
  const harness = await runNamespaceHarness({ docker, relay: { open: ({ socketPath }) => openUnixEmbeddingRelay({ socketPath, timeoutMs: 90000,
    onEvent: event => relayLog.append({ checkpoint: meta.checkpoint, ...event }) }) },
    socketPath: join(driverDir, 'embeddings.sock'), shimPort: 18080,
    async onIsolation(isolation) {
      writePrivate(join(dir, 'isolation.json'), isolation);
      if (!isolation.ok) return;
      const ready = { status: 'awaiting_go', run_id: runId, run_dir: dir, source_key: sourceKey, source_sha256: source.source_sha256,
        dataset_sha256: manifestSha, code_sha: codeSha, seal_sha256: seal.digest, sdk_index_sha256: sdkIndexSha, sdk_session_sha256: sdkSessionSha,
        models: { candidate: exactRoute(model), reviewer: exactRoute(reviewerModel), answerer: exactRoute(reviewerModel), scorer: exactRoute(reviewerModel) },
        routes: { origin: 'http://127.0.0.1:3003', privacy: 'configured Pi provider inference; local artifacts; no external review packets' },
        budget: { overall_effort_soft_usd: 250, share_soft_usd: 100, prior_spend_nano: previous.toString(),
          remaining_soft_nano: remaining.toString(), prior_ledger_sha256s: priorLedgers.map(row => row.sha256), one_call_in_flight: true, stop_unknown_usage: true,
          stop_above_twice_estimate: true, gateway_attempt_ledger: 'partial: gateway-internal failover/retry attempts not correlatable', rate_card: routeRates },
        checkpoints: checkpoints.length, cases: prepared.length, isolation: { network_mode: isolation.network_mode,
          namespace: isolation.namespace, interfaces: isolation.interfaces, no_default_route: isolation.no_default_route,
          probes: isolation.targets.length, connected: isolation.targets.filter(row => row.outcome === 'connected').length,
          unprobeable_link_local: isolation.unprobeable_link_local.length }, images: imageHashes };
      writePrivate(join(dir, 'READY.json'), ready);
      process.stdout.write(`${JSON.stringify(ready)}\n`);
      if (process.env.SOURCE_MEMORY_PREFLIGHT_ONLY === '1') throw fail('preflight_only');
      const deadline = Date.now() + 600000, go = join(dir, 'GO');
      while (Date.now() < deadline) {
        try { if (readFileSync(go, 'utf8').trim() === seal.digest) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await sleep(250);
      }
      throw fail('preflight_go_timeout');
    },
    async onWarm(result) {
      const sample = { at: new Date().toISOString(), host_load_average: loadavg(), ollama_ps: null, gpu_utilization_memory: null };
      try { sample.ollama_ps = execFileSync('/usr/local/bin/ollama', ['ps'], { encoding: 'utf8', timeout: 5000 }); } catch {}
      try { sample.gpu_utilization_memory = execFileSync('/usr/bin/nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
        { encoding: 'utf8', timeout: 5000 }); } catch {}
      writePrivate(join(dir, 'environment.json'), sample);
      progress.append({ type: 'embedding_warm', ...result });
    },
    async memoryFactory({ driver }) { return openDockerMemory({ containerId: driver, scope, configPath: '/scratch/config.json', intentDir: '/scratch/intents',
      timeoutMs: 180000, offerTimeoutMs: 120000, onReceipt: event => memoryLog.append({ checkpoint: meta.checkpoint, ...event }) }); },
    async work({ memory, driver }) {
      const guarded = trackSnapshot(memory);
      journal = createCoverageJournal({ directory: dir, sessionKey: sourceKey });
      try {
        const session = await createSliceSession({ pi, source: sourceCopy, entries: rows, conversationId: source.conversation_id, workDir: piDir, scope,
          memory: guarded.client, modelId: exactRoute(model), reviewerId: exactRoute(reviewerModel), coverageJournal: journal,
          imageArchive: createImageArchive({ directory: imageDir }),
          ensureIndexed: (client, selectedScope, state) => ensureIndexed(client, selectedScope, state, { waitForVectors: true }),
          meterRuntime: (underlying, context) => budget.wrap(underlying, () => ({ ...meta,
            purpose: context.purpose, task_version: context.purpose === 'candidate' ? 'distiller-r2-v1' : 'link-review-r2-v1' })) });
        const evaluatorRuntime = budget.wrap(runtime, () => meta);
        sequenceResult = await runPilotSequence({ session, journal, checkpoints, cases: prepared, budget,
          async onBeforeCheckpoint(checkpoint) { meta = { purpose: 'candidate', arm: 'candidate', checkpoint: checkpoint.id,
            task_version: 'distiller-r2-v1', policy_version: seal.spec.policyVersion }; },
          async onCheckpoint(row, state) { progress.append({ type: 'checkpoint', through: checkpointId(row), disposition: row.disposition,
            image_limitation: row.omissions?.images ?? null, budget: state }); },
          async onCase(row, state) { progress.append({ type: 'case', case_id: row.case_id, status: row.status, budget: state }); },
          async evaluateCase(item, cursor) {
            const held = guarded.acquire(item.publicCase.queryTime);
            try {
              caseSnapshots[item.publicCase.id] = await docker.snapshot({ driver, scope,
                filename: `baseline-${runId}-${sha(item.publicCase.id).slice(0, 16)}.json` });
              const allow = async access => access.actor === item.publicCase.actor && access.queryTime === item.publicCase.queryTime;
              const empty = { async searchDerived() { return []; }, async resolveDerived() { throw fail('evidence_not_offered'); } };
              const candidate = { scope, snapshotId: held.id, authorize: allow, verifySnapshot: held.verify, client: session.memory };
              const baseline = { scope, snapshotId: held.id, authorize: allow, verifySnapshot: held.verify, client: empty };
              const adapter = createDerivedAdapter({ stores: { candidate, 'baseline-empty': baseline } });
              const archive = { async search(args) {
                if (!await allow(args) || await held.verify(args.queryTime) !== held.id) throw fail('snapshot_unverified');
                return session.memory.searchRaw(scope, { query: args.query, limit: args.limit });
              } };
              const respond = createPiAnswererResponder({ runtime: evaluatorRuntime, model: reviewerModel, sessionId: `answer-${runId}-${item.publicCase.id}`,
                expectedToolsSha256: ANSWERER_TOOLS_SHA256 });
              const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: adapter, archive, respond });
              const judge = createPiScorerJudge({ runtime: evaluatorRuntime, model: reviewerModel, sessionId: `score-${runId}-${item.publicCase.id}`, outputTokens: 4096 });
              const scorer = createScorer({ seal, expectedDigest: seal.digest, judge });
              const arms = {};
              for (const arm of ['candidate', 'baseline', 'empty', 'raw-only']) {
                meta = { purpose: 'answerer', arm, checkpoint: cursor, task_version: 'answerer-r2-v1', policy_version: seal.spec.policyVersion };
                const answer = await answerer.run({ arm, case: item.publicCase });
                meta = { purpose: 'scorer', arm, checkpoint: cursor, task_version: 'scorer-r2-v1', policy_version: seal.spec.policyVersion };
                const judged = await scorer.score({ packet: item.packet, answer: answer.answer, trace: answer.trace });
                arms[arm] = judged.score;
                results.append({ case_id: item.publicCase.id, arm, answer, judgment: judged.judgment, score: judged.score });
              }
              reportRows.push({ caseId: item.publicCase.id, sessions: [sourceKey], sealDigest: seal.digest, packetDigest: arms.candidate.packetDigest, arms });
              return { case_id: item.publicCase.id, status: 'scored', reference: 'pending_reference_freeze', snapshot: caseSnapshots[item.publicCase.id] };
            } finally { held.release(); }
          } });
        if (sequenceResult.status === 'complete' && source.leaf_entry_id !== sequenceResult.cursor) {
          const tail = [];
          for (let id = source.leaf_entry_id; id && id !== sequenceResult.cursor;) {
            const row = byId.get(id);
            if (!row) throw fail('ancestry_invalid');
            tail.unshift(row); id = row.parentId;
          }
          if (!tail.length || tail[0].parentId !== sequenceResult.cursor || tail.some(row => !['custom', 'custom_message', 'session_info'].includes(row.type))) throw fail('tail_unresolved');
          journal.begin({ through: source.leaf_entry_id, cursor: sequenceResult.cursor });
          journal.finish('ineligible_by_policy');
          sequenceResult.tail = { through: source.leaf_entry_id, disposition: 'ineligible_by_policy', entries: tail.length };
          progress.append({ type: 'tail', ...sequenceResult.tail, budget: budget.state() });
        }
      } catch (error) { failure = typeof error?.code === 'string' ? error.code : 'pilot_failed'; }
      finally {
        try { snapshot = await docker.snapshot({ driver, scope, filename: `baseline-${runId}.json` }); } catch { failure ??= 'snapshot_failed'; }
        try { journal?.close(); } catch { failure ??= 'journal_close_failed'; }
      }
      return { sequence: sequenceResult, failure, snapshot, reference: 'pending_reference_freeze' };
    } });
  let scorecard = null;
  if (reportRows.length) scorecard = pairedReport({ seal, expectedDigest: seal.digest, rows: reportRows, dependencies: [] });
  try { budget.close(); } catch { failure ??= 'ledger_close_failed'; }
  for (const writer of [resources, progress, memoryLog, results, relayLog]) writer.close();
  const artifactNames = ['seal.json', 'ledger.jsonl', 'progress.jsonl', 'memory-receipts.jsonl', 'case-results.jsonl', 'resources.jsonl',
    'isolation.json', 'embedding-relay.jsonl', 'environment.json'];
  const artifacts = {};
  for (const name of artifactNames) {
    try { const bytes = readFileSync(join(dir, name)); artifacts[name] = { path: join(dir, name), sha256: sha(bytes), bytes: bytes.length }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (snapshot?.path) { const bytes = readFileSync(snapshot.path); if (sha(bytes) !== snapshot.sha256) throw fail('snapshot_changed');
    artifacts.baseline_snapshot = { path: snapshot.path, sha256: snapshot.sha256, bytes: bytes.length, restore_verified: false }; }
  artifacts.case_snapshots = Object.entries(caseSnapshots).map(([caseId, item]) => {
    const bytes = readFileSync(item.path);
    if (sha(bytes) !== item.sha256) throw fail('snapshot_changed');
    return { case_id: caseId, path: item.path, sha256: item.sha256, bytes: bytes.length, restore_verified: false };
  });
  artifacts.source_snapshot = { path: sourceCopy, sha256: source.source_sha256, bytes: sourceBytes.length };
  artifacts.image_blobs = readdirSync(imageDir).map(name => {
    if (!/^[a-f0-9]{64}\.blob$/.test(name)) throw fail('image_archive_conflict');
    const path = join(imageDir, name), bytes = readFileSync(path), digest = sha(bytes);
    if (`${digest}.blob` !== name) throw fail('image_archive_conflict');
    return { path, sha256: digest, bytes: bytes.length };
  });
  const final = { status: harness.status === 'complete' && !failure && sequenceResult?.status === 'complete' ? 'partial_reference_unavailable' : 'failed_or_partial',
    harness_status: harness.status, failure: failure ?? harness.code ?? null, coverage: sequenceResult ? { status: sequenceResult.status,
      scheduled: checkpoints.length, processed: sequenceResult.results.length, tail: sequenceResult.tail ?? null,
      dispositions: sequenceResult.results.map(row => ({ through: checkpointId(row), disposition: row.disposition, code: row.code ?? null })) } : null,
    scorecard, reference: 'pending_reference_freeze',
    stage_attribution: reportRows.map(row => ({ case_id: row.caseId, status: 'pending_reference_freeze',
      reason: 'Reference catalog and candidate-trace semantic comparison have not been validated.' })),
    snapshot: snapshot ?? null, budget: { ...budget.state(), prior_spend_nano: previous.toString(),
      total_spent_nano: (previous + BigInt(budget.state().spent_nano)).toString(), share_cap_nano: '100000000000' },
    ledger_completeness: 'partial: gateway-internal failover/retry attempts not correlatable',
    image_limitation: 'Original image blobs are archived by SHA-256; image content is not text-citable.',
    latency_limitation: 'Local embedding latency is environment-sensitive; a later sample showed 100% GPU and elevated host load, not proof of contention during any call.', artifacts,
    run_dir: dir, run_id: runId, seal_sha256: seal.digest };
  writePrivate(join(dir, 'REPORT.json'), final);
  process.stdout.write(`${JSON.stringify({ status: final.status, run_id: runId, run_dir: dir, failure: final.failure })}\n`);
}

main().catch(error => {
  const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'pilot_failed';
  process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`); process.exitCode = 1;
});
