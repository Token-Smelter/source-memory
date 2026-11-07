import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyChronologicalCheckpoint } from '../pi-extension/chronology.mjs';
import { createDerivedAdapter } from '../pi-extension/derived-retrieval.mjs';
import { ensureIndexed } from '../pi-extension/index-readiness.mjs';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';
import { runNamespaceHarness } from '../pi-extension/namespace-harness.mjs';
import { openUnixEmbeddingRelay } from '../pi-extension/unix-relay.mjs';
import { openDockerMemory } from '../pi-extension/docker-memory.mjs';
import { sameLogicalSnapshot } from '../pi-extension/restore-scope.mjs';
import { resolvePiModels } from '../pi-extension/slice-runtime.mjs';
import { createAnswerer } from '../pi-extension/evaluation/answerer.mjs';
import { prepareDevelopmentCases } from '../pi-extension/evaluation/dev-dataset.mjs';
import { createPiAnswererResponder, createPiScorerJudge, ANSWERER_TOOLS_SHA256 } from '../pi-extension/evaluation/pi-calls.mjs';
import { priorSoftSpend } from '../pi-extension/evaluation/prior-spend.mjs';
import { createScorer } from '../pi-extension/evaluation/scorer.mjs';
import { hash, sealComparison, verifySeal } from '../pi-extension/evaluation/seal.mjs';
import { createSoftBudget } from '../pi-extension/evaluation/soft-budget.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolveReply => setTimeout(resolveReply, ms));
function pinned(path, expected, max = 128_000_000) {
  if (!isAbsolute(path ?? '') || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw fail('path_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = fstatSync(fd); if (!before.isFile() || before.size > max) throw fail('input_invalid');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size || sha(bytes) !== expected) throw fail('input_changed'); return bytes;
  } finally { closeSync(fd); }
}
function writePrivate(path, value) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, Buffer.isBuffer(value) ? value : JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
function writer(path) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  return { append(row) { const bytes = Buffer.from(`${JSON.stringify(row)}\n`); for (let i = 0; i < bytes.length;) i += writeSync(fd, bytes, i, bytes.length - i); fsyncSync(fd); }, close() { closeSync(fd); } };
}
function rawOnly(value) {
  const nodes = value.nodes.filter(row => row.labels?.includes('SMTurn') || row.labels?.includes('SMChunk'));
  const relationships = value.relationships.filter(row => row.type === 'SM_HAS_CHUNK');
  return { schema: value.schema, scope: value.scope, nodes, relationships };
}
function priorSpend(root, hashes) {
  const wanted = new Set(hashes), found = new Map();
  for (const name of readdirSync(root).filter(value => value.startsWith('pilot-'))) {
    const path = join(root, name, 'ledger.jsonl');
    let bytes; try { bytes = readFileSync(path); } catch { continue; }
    const digest = sha(bytes); if (!wanted.has(digest)) continue;
    if (found.has(digest)) throw fail('prior_ledger_ambiguous');
    const reconciliations = [];
    if (digest === '08f52e97e0db01c66b99ac59dbfa1aa2822f111ef690292d0fe57aa0750ea541') {
      const receiptPath = join(root, name, 'ledger-reconciliation-77.json');
      const receipt = JSON.parse(pinned(receiptPath, '01e9fe35c9a4042b9368c87de102219e4d35144ff3c2c4006fa966b33aa9eb5e', 100000));
      pinned(receipt.gateway_correlation_path, receipt.gateway_correlation_sha256, 100000); reconciliations.push(receipt);
    }
    found.set(digest, BigInt(priorSoftSpend(bytes.toString('utf8'), { reconciliations })));
  }
  if (found.size !== wanted.size) throw fail('prior_ledger_missing');
  return [...found.values()].reduce((sum, value) => sum + value, 0n);
}
async function main() {
  const [pilotReportPath, expectedReport, expectedReady, parentDir, sdkIndex, sdkIndexSha, sdkSession, sdkSessionSha] = process.argv.slice(2);
  if (process.argv.length !== 10 || !isAbsolute(parentDir ?? '')) throw fail('arguments_invalid');
  const root = realpathSync(parentDir), stat = statSync(root);
  if (root !== parentDir || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail('work_dir_invalid');
  const pilot = JSON.parse(pinned(pilotReportPath, expectedReport, 20_000_000));
  if (pilot.status !== 'partial_reference_unavailable' || pilot.coverage?.processed !== 44 || pilot.scorecard?.cases !== 3) throw fail('pilot_incomplete');
  const pilotDir = dirname(pilotReportPath), pilotSeal = JSON.parse(pinned(join(pilotDir, 'seal.json'), pilot.artifacts['seal.json'].sha256, 10_000_000));
  verifySeal(pilotSeal, pilot.seal_sha256);
  const ready = JSON.parse(pinned(join(pilotDir, 'READY.json'), expectedReady, 1_000_000));
  if (ready.run_id !== pilot.run_id || ready.seal_sha256 !== pilot.seal_sha256 || ready.source_sha256 !== pilotSeal.spec.sourceSha256
    || ready.dataset_sha256 !== pilotSeal.spec.datasetSha256) throw fail('pilot_provenance_mismatch');
  const previous = priorSpend(root, [...ready.budget.prior_ledger_sha256s, pilot.artifacts['ledger.jsonl'].sha256]);
  if (previous.toString() !== pilot.budget.total_spent_nano) throw fail('prior_ledger_mismatch');
  const remaining = 100000000000n - previous;
  if (remaining <= 0n) throw fail('soft_cap_exhausted');
  const manifestPath = '/var/tmp/source-memory-real-eval-r2-20261107T155822Z/development/CASE-MANIFEST.json';
  const manifest = JSON.parse(pinned(manifestPath, '7c33475f6c178bcf0ab8479c6e39675ae2a88efd3f44fa88cafd7bfcc6f8b7db', 2_000_000));
  const dataRoot = dirname(dirname(manifestPath)), sourceKey = '01a083db-bf9a', source = manifest.source_pins.find(row => row.source_key === sourceKey);
  const input = key => pinned(join(dataRoot, key), manifest.files[key].sha256).toString('utf8');
  const proofs = JSON.parse(input('development/checkpoint-proofs.json')).cases.filter(row => row.source_key === sourceKey);
  const availability = input('development/availability.jsonl').trimEnd().split('\n').map(JSON.parse).filter(row => row.source_key === sourceKey);
  const cases = input('development/cases.jsonl').trimEnd().split('\n').map(JSON.parse).filter(row => row.split === 'development' && row.pre_answer_store_snapshot?.source_key === sourceKey);
  const sourceBytes = pinned(source.snapshot_path, source.source_sha256), entries = sourceBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse).slice(1);
  pinned(sdkIndex, sdkIndexSha, 5_000_000); pinned(sdkSession, sdkSessionSha, 5_000_000);
  const pi = await import(pathToFileURL(sdkIndex).href), builder = await import(pathToFileURL(sdkSession).href);
  const verified = proofs.map(proof => verifyChronologicalCheckpoint({ bytes: sourceBytes, proof, availability, pi: builder }));
  const prepared = prepareDevelopmentCases({ cases, proofs, verified, entries, availability, sourceKey, scope: cases[0].read_scopes[0], sourceSha256: source.source_sha256 });
  const mappings = [
    { ordinal: '020', id: 'R2-NEED-001', plan: join(root, 'reference-cut20-store.json'), planSha: 'aed757cdf65dfce0d22f11ce0bba43e9195324fc5634abcc4fafd46054f359a6', audit: join(root, 'reference-cut20-audit.json'), auditSha: 'f9c7876765780c4d7f7331c803bcb6acf96c39f7ac42ff332b46cc91db61c5b5' },
    { ordinal: '037', id: 'R2-NEED-002', plan: join(root, 'reference-cut037-store.json'), planSha: '7ddeab6235df94c2176da3161712c45fa41ad4f86812056536487387764543bf', audit: join(root, 'reference-cut037-audit.json'), auditSha: 'ec9c078c83861df8ba6471388c574d7e787bdc2b4bbe27c571adf65f63543f49' },
    { ordinal: '044', id: 'R2-NEED-006', plan: join(root, 'reference-cut044-store.json'), planSha: '1ba89115891496a6f7813586207044ef3774fb91d1e2b84da17e18351068c896', audit: join(root, 'reference-cut044-audit.json'), auditSha: '4bdcd3ff4fa3d711f7a4c88763f654473f47ee9ac1ffa9a9442107345b3ef41d' },
  ];
  for (const mapping of mappings) {
    const planBytes = pinned(mapping.plan, mapping.planSha), auditBytes = pinned(mapping.audit, mapping.auditSha, 10_000_000);
    const plan = JSON.parse(planBytes), audit = JSON.parse(auditBytes), ref = prepared.find(row => row.publicCase.id === mapping.id);
    const snapshot = pilot.artifacts.case_snapshots.find(row => row.case_id === mapping.id);
    if (!ref || !snapshot || !sameLogicalSnapshot(rawOnly(plan), rawOnly(JSON.parse(pinned(snapshot.path, snapshot.sha256))))) throw fail('reference_source_mismatch');
    mapping.planBytes = planBytes; mapping.auditData = audit; mapping.item = ref; mapping.candidateSnapshot = snapshot.sha256;
  }
  const { runtime, reviewerModel } = await resolvePiModels({ pi, modelId: 'anthropic/claude-haiku-5-5', reviewerId: 'anthropic/claude-sonnet-5-5' });
  if (`${reviewerModel.provider}/${reviewerModel.id}` !== 'anthropic/claude-sonnet-5-5' || new URL(reviewerModel.baseUrl).origin !== 'http://127.0.0.1:3003') throw fail('route_changed');
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw fail('working_tree_dirty');
  const spec = structuredClone(pilotSeal.spec); spec.codeSha = codeSha; spec.freezeBasis = 'reference diagnostic after candidate pilot; same answerer and scorer settings';
  spec.budget.capNano = remaining.toString(); spec.budget.priorSpendNano = previous.toString();
  spec.referenceDiagnostic = { pilotReportSha256: expectedReport, pilotSealDigest: pilotSeal.digest,
    plans: mappings.map(row => ({ caseId: row.id, planSha256: row.planSha, auditSha256: row.auditSha, candidateSnapshotSha256: row.candidateSnapshot })),
    limitation: 'Reference store, outcome_of→non-action omitted; whole cited entries dropped when ineligible or over bounds; semantic audit pending.' };
  const seal = sealComparison(spec), dir = mkdtempSync(join(root, 'reference-run-')), runId = randomUUID();
  writePrivate(join(dir, 'seal.json'), seal);
  const resources = writer(join(dir, 'resources.jsonl')), progress = writer(join(dir, 'progress.jsonl')),
    outputs = writer(join(dir, 'model-outputs.jsonl')), results = writer(join(dir, 'case-results.jsonl'));
  const route = `${reviewerModel.provider}/${reviewerModel.id}`, rate = ready.budget.rate_card.reviewer;
  if (hash(rate) !== hash(pilotSeal.spec.budget.routes[route])) throw fail('rate_changed');
  const budget = createSoftBudget({ path: join(dir, 'ledger.jsonl'), capNano: remaining.toString(), sessionKey: `reference-${runId}`, sealSha256: seal.digest,
    routes: { [route]: rate }, onRaw: row => outputs.append(row) });
  let meta = { purpose: 'answerer', arm: 'reference', checkpoint: 'preflight', task_version: 'answerer-r2-v3', policy_version: seal.spec.policyVersion };
  const evaluatorRuntime = budget.wrap(runtime, () => meta), summaries = [];
  const image = name => execFileSync('/usr/bin/docker', ['image', 'inspect', name, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
  for (const mapping of mappings) {
    if (budget.state().stopped) break;
    const cutDir = join(dir, `cut-${mapping.ordinal}`); mkdirSync(cutDir, { mode: 0o700 }); mkdirSync(join(cutDir, 'intents'), { mode: 0o700 });
    writePrivate(join(cutDir, 'reference.json'), mapping.planBytes);
    const scope = mapping.item.publicCase.readScopes[0];
    writePrivate(join(cutDir, 'config.json'), { neo4j: { uri: 'bolt://127.0.0.1:7687', auth: 'none' }, scopes: { read: [scope], write: [scope] },
      embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'embeddinggemma', dimensions: 768, timeout_ms: 120000 }, index_on_write: false });
    const id = randomUUID(), docker = createNamespaceDocker({ databaseImage: image('neo4j:5.26.14-community'), driverImage: image('node:22-bookworm-slim'),
      mounts: { memory: resolve('.'), scratch: cutDir }, runId: id, onResource: row => resources.append(row) });
    let snapshot;
    const harness = await runNamespaceHarness({ docker, relay: { open: ({ socketPath }) => openUnixEmbeddingRelay({ socketPath, timeoutMs: 90000 }) },
      socketPath: join(cutDir, 'embeddings.sock'), shimPort: 18080,
      async onIsolation(isolation) {
        writePrivate(join(cutDir, 'isolation.json'), isolation);
        if (!isolation.ok) return;
        const gate = { status: 'awaiting_go', run_dir: dir, run_id: runId, cut: mapping.ordinal, seal_sha256: seal.digest,
          code_sha: codeSha, candidate_snapshot_sha256: mapping.candidateSnapshot, reference_plan_sha256: mapping.planSha,
          prior_spend_nano: previous.toString(), current_spend_nano: budget.state().spent_nano, remaining_cap_nano: remaining.toString(),
          model: route, one_call_in_flight: true, gateway_attempt_ledger: 'partial', isolation: { interfaces: isolation.interfaces,
            no_default_route: isolation.no_default_route, probes: isolation.targets.length, connected: isolation.targets.filter(row => row.outcome === 'connected').length,
            unprobeable_link_local: isolation.unprobeable_link_local.length } };
        writePrivate(join(cutDir, 'READY.json'), gate); process.stdout.write(`${JSON.stringify(gate)}\n`);
        const deadline = Date.now() + 600000, path = join(cutDir, 'GO');
        while (Date.now() < deadline) { try { if (readFileSync(path, 'utf8').trim() === seal.digest) return; } catch (error) { if (error.code !== 'ENOENT') throw error; } await sleep(250); }
        throw fail('preflight_go_timeout');
      },
      async memoryFactory({ driver }) { return openDockerMemory({ containerId: driver, scope, configPath: '/scratch/config.json', intentDir: '/scratch/intents', timeoutMs: 180000, indexTimeoutMs: 600000 }); },
      async work({ memory, driver }) {
        const restored = JSON.parse(execFileSync('/usr/bin/docker', ['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/restore-scope.mjs',
          '/scratch/reference.json', mapping.planSha, scope], { encoding: 'utf8', timeout: 180000, maxBuffer: 100000 }));
        if (restored.equivalent !== true || restored.source_sha256 !== mapping.planSha) throw fail('reference_restore_unverified');
        await ensureIndexed(memory, scope, { status: 'deferred' }, { batchLimit: 16, maxRounds: 128, maxIndexRetries: 2, waitForVectors: true });
        const plan = JSON.parse(mapping.planBytes), ids = plan.nodes.filter(row => row.labels.includes('SMRecord')).map(row => row.properties.record_id);
        for (let i = 0; i < ids.length; i += 16) await ensureIndexed(memory, scope, { status: 'ready' }, { waitForVectors: true, recordIds: ids.slice(i, i + 16) });
        snapshot = await docker.snapshot({ driver, scope, filename: `baseline-${id}.json` });
        const allow = async access => access.actor === mapping.item.publicCase.actor && access.queryTime === mapping.item.publicCase.queryTime;
        const store = { scope, snapshotId: mapping.planSha, authorize: allow, verifySnapshot: async time => time === mapping.item.publicCase.queryTime ? mapping.planSha : null, client: memory };
        const adapter = createDerivedAdapter({ stores: { reference: store } });
        const respond = createPiAnswererResponder({ runtime: evaluatorRuntime, model: reviewerModel, sessionId: `reference-answer-${id}`, expectedToolsSha256: ANSWERER_TOOLS_SHA256 });
        const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: adapter, archive: { async search() { throw fail('raw_search_refused'); } }, respond });
        const judge = createPiScorerJudge({ runtime: evaluatorRuntime, model: reviewerModel, sessionId: `reference-score-${id}`, outputTokens: 4096 });
        const scorer = createScorer({ seal, expectedDigest: seal.digest, judge });
        meta = { purpose: 'answerer', arm: 'reference', checkpoint: mapping.item.through, task_version: 'answerer-r2-v3', policy_version: seal.spec.policyVersion };
        const answer = await answerer.run({ arm: 'reference', case: mapping.item.publicCase });
        results.append({ type: 'answer', case_id: mapping.id, arm: 'reference', answer });
        meta = { purpose: 'scorer', arm: 'reference', checkpoint: mapping.item.through, task_version: 'scorer-r2-v2', policy_version: seal.spec.policyVersion };
        try {
          const judged = await scorer.score({ packet: mapping.item.packet, answer: answer.answer, trace: answer.trace });
          results.append({ type: 'judgment', case_id: mapping.id, arm: 'reference', judgment: judged.judgment, score: judged.score });
          return { case_id: mapping.id, status: 'scored', score: judged.score, trace: answer.trace, restored, snapshot };
        } catch (error) {
          if (error?.code !== 'scorer_output_invalid') throw error;
          results.append({ type: 'scorer_failed', case_id: mapping.id, arm: 'reference', reason: 'invalid_after_one_repair' });
          return { case_id: mapping.id, status: 'scorer_failed', restored, snapshot };
        }
      } });
    summaries.push({ cut: mapping.ordinal, status: harness.status, result: harness.result ?? null, code: harness.code ?? null,
      plan_sha256: mapping.planSha, audit_sha256: mapping.auditSha, input_records: mapping.auditData.input_records,
      imported_records: mapping.auditData.imported_records, input_edges: mapping.auditData.input_edges, imported_edges: mapping.auditData.imported_edges,
      omitted_items: mapping.auditData.omitted_items.length, omitted_edges: mapping.auditData.omitted_edges.length,
      dropped_citations: mapping.auditData.dropped_entries.length });
    progress.append({ type: 'reference_case', cut: mapping.ordinal, harness_status: harness.status, status: harness.result?.status ?? null, budget: budget.state() });
    if (harness.status !== 'complete') break;
  }
  budget.close(); for (const out of [resources, progress, outputs, results]) out.close();
  const artifacts = {};
  for (const name of ['seal.json', 'ledger.jsonl', 'resources.jsonl', 'progress.jsonl', 'model-outputs.jsonl', 'case-results.jsonl']) {
    const path = join(dir, name), bytes = readFileSync(path); artifacts[name] = { path, sha256: sha(bytes), bytes: bytes.length };
  }
  const report = { status: summaries.length === 3 && summaries.every(row => row.status === 'complete' && row.result?.status === 'scored') ? 'complete' : 'partial',
    limitation: spec.referenceDiagnostic.limitation, pilot_report_sha256: expectedReport, seal_sha256: seal.digest, cases: summaries,
    budget: { ...budget.state(), prior_spend_nano: previous.toString(), total_spent_nano: (previous + BigInt(budget.state().spent_nano)).toString() },
    ledger_completeness: 'partial: gateway-internal retries/failovers not correlatable', artifacts, run_dir: dir, run_id: runId };
  writePrivate(join(dir, 'REPORT.json'), report);
  process.stdout.write(`${JSON.stringify({ status: report.status, run_dir: dir, run_id: runId, cases: summaries.length })}\n`);
}
main().catch(error => { process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'reference_failed' })}\n`); process.exitCode = 1; });
