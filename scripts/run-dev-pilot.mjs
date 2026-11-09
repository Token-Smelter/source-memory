import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, loadavg } from 'node:os';
import { pathToFileURL } from 'node:url';
import { digest } from '../src/core.mjs';
import { verifyChronologicalCheckpoint } from '../pi-extension/chronology.mjs';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createInputBudget } from '../pi-extension/budget.mjs';
import { createImageArchive } from '../pi-extension/image-archive.mjs';
import { sameLogicalSnapshot } from '../pi-extension/restore-scope.mjs';
import { prepareRuntimeTree } from '../pi-extension/runtime-tree.mjs';
import { ensureIndexed } from '../pi-extension/index-readiness.mjs';
import { createDerivedAdapter } from '../pi-extension/derived-retrieval.mjs';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';
import { runNamespaceHarness } from '../pi-extension/namespace-harness.mjs';
import { openUnixEmbeddingRelay } from '../pi-extension/unix-relay.mjs';
import { openDockerMemory } from '../pi-extension/docker-memory.mjs';
import { createSliceSession, resolvePiModels } from '../pi-extension/slice-runtime.mjs';
import { createAnswerer, CITATION_PROTOCOL } from '../pi-extension/evaluation/answerer.mjs';
import { prepareDevelopmentCases, toolCallReviewSummary, verifyToolCallReview } from '../pi-extension/evaluation/dev-dataset.mjs';
import { createPiAnswererResponder, createPiScorerJudge, createPiScorerSpecificRepair, SCORER_SPECIFIC_REPAIR, SCORER_MULTI_REPAIR } from '../pi-extension/evaluation/pi-calls.mjs';
import { CITED_RESUME_TRANSITIONS, TREATMENTS, createCitedPilotPlan, DESIGN_SHA256, INTERPRETATION_02_SHA256 } from '../pi-extension/evaluation/pilot-plan.mjs';
import { WORKER_SHARE_NANO, attestedPriorSpend, priorSoftSpend, validatePriorSpendContinuity } from '../pi-extension/evaluation/prior-spend.mjs';
import { validatePilotResume } from '../pi-extension/evaluation/pilot-resume.mjs';
import { validateCaseHandback, validatePartialCaseHandback } from '../pi-extension/evaluation/pilot-handback.mjs';
import { validateCaseContinuation } from '../pi-extension/evaluation/pilot-continuation.mjs';
import { checkpointId, runPilotSequence } from '../pi-extension/evaluation/pilot-sequence.mjs';
import { pairedReport } from '../pi-extension/evaluation/report.mjs';
import { createScorer, scoreCase } from '../pi-extension/evaluation/scorer.mjs';
import { createSoftBudget } from '../pi-extension/evaluation/soft-budget.mjs';
import { createSnapshotVerifier } from '../pi-extension/evaluation/snapshot-verifier.mjs';

const fail = code => Object.assign(new Error(code), { code });
// Recomputed from git so a transition cannot under-declare what changed between the two sealed commits.
function changedPaths(from, to) {
  if (!/^[a-f0-9]{40}$/.test(from ?? '') || !/^[a-f0-9]{40}$/.test(to ?? '')) throw fail('resume_invalid');
  const names = execFileSync('git', ['diff', '--name-only', '--no-renames', from, to], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  return names.map(path => {
    try { return { path, blob: execFileSync('git', ['rev-parse', `${to}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }; }
    catch { return { path, blob: null }; }
  });
}
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
// Haiku and Sonnet 5.5 use Pi's adaptive thinking (compat.forceAdaptiveThinking): there is no separate thinking budget,
// so thinking and the answer share max_tokens. At 4,096 a distiller turn could spend the whole ceiling thinking and stop
// with "length", failing the checkpoint; 16,384 is the declared distiller ceiling for every arm (baseline v2.1 onward).
export const DISTILLER_MAX_OUTPUT_TOKENS = 16384, EVALUATOR_MAX_OUTPUT_TOKENS = 4096;
function rates(model, maxOutputTokens) {
  const tiers = [model.cost, ...(model.cost?.tiers ?? [])];
  const result = {};
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    const values = tiers.map(row => row?.[key]).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (!values.length) throw fail('rate_unavailable');
    result[key] = Math.ceil(Math.max(...values) * 1000);
  }
  return { maxOutputTokens, ratesNanoPerToken: result, rateEvidence: 'preflight Pi SDK model catalog; highest declared tier; API-equivalent only' };
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
      catch (error) { if (error?.effect !== 'refused' && !(key === 'index' && error?.code === 'request_timeout')) invalid = true; throw error; }
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
  const [manifestPath, manifestSha, sourceKey, reviewMapPath, reviewMapSha, sdkIndex, sdkIndexSha, sdkSession, sdkSessionSha, parentDir] = process.argv.slice(2);
  if (process.argv.length !== 12 || basename(manifestPath ?? '') !== 'MANIFEST.json' || !isAbsolute(parentDir ?? '')) throw fail('arguments_invalid');
  const parent = realpathSync(parentDir), parentStat = statSync(parent);
  if (parent !== parentDir || !parentStat.isDirectory() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077)) throw fail('work_dir_invalid');
  const manifest = JSON.parse(pinned(manifestPath, manifestSha, 2_000_000).toString('utf8'));
  if (manifest.schema !== 'source-memory-change-development-manifest/v2' || !String(manifest.status).startsWith('frozen')
    || !Number.isSafeInteger(manifest.counts_by_source?.[sourceKey]) || manifest.review_sha256 !== manifest.files?.['REVIEW.json']?.sha256) throw fail('manifest_invalid');
  const datasetRoot = dirname(manifestPath);
  const input = key => {
    const descriptor = manifest.files?.[key];
    if (!descriptor || !Number.isSafeInteger(descriptor.bytes)) throw fail('manifest_invalid');
    const bytes = pinned(join(datasetRoot, key), descriptor.sha256);
    if (bytes.length !== descriptor.bytes) throw fail('input_changed');
    return bytes.toString('utf8');
  };
  const roots = JSON.parse(input('SOURCES.json')).sources.filter(row => row.source_key === sourceKey);
  if (roots.length !== 1) throw fail('source_invalid');
  const source = { source_key: roots[0].source_key, source_sha256: roots[0].source_sha256, snapshot_path: roots[0].source_snapshot_path,
    conversation_id: roots[0].source_session_id, leaf_entry_id: roots[0].active_leaf_entry_id };
  const toolCallReview = verifyToolCallReview({ bytes: pinned(reviewMapPath, reviewMapSha, 1_000_000), expectedSha256: reviewMapSha,
    datasetManifestSha256: manifestSha, sourceReviewSha256: manifest.review_sha256 });
  const proofs = JSON.parse(input('checkpoint-proofs.json')).cases.filter(row => row.source_key === sourceKey);
  const availability = input('availability.jsonl').trimEnd().split('\n').map(JSON.parse).filter(row => row.source_key === sourceKey);
  const cases = input('cases.final.jsonl').trimEnd().split('\n').map(JSON.parse).filter(row => row.split === 'development' && row.pre_answer_store_snapshot?.source_key === sourceKey);
  if (cases.length !== manifest.counts_by_source[sourceKey]) throw fail('dataset_invalid');
  if (!proofs.length || !cases.length || proofs.some(row => row.snapshot_path !== source.snapshot_path || row.source_sha256 !== source.source_sha256)) throw fail('dataset_invalid');
  const sourceBytes = pinned(source.snapshot_path, source.source_sha256);
  pinned(process.env.SOURCE_MEMORY_INTERPRETATION_PATH, INTERPRETATION_02_SHA256, 100000);
  pinned(process.env.SOURCE_MEMORY_DESIGN_PATH, DESIGN_SHA256, 1_000_000);
  pinned(sdkIndex, sdkIndexSha, 5_000_000); pinned(sdkSession, sdkSessionSha, 5_000_000);
  const pi = await import(pathToFileURL(sdkIndex).href), builder = await import(pathToFileURL(sdkSession).href);
  const verified = proofs.map(proof => verifyChronologicalCheckpoint({ bytes: sourceBytes, proof, availability, pi: builder }));
  const rows = sourceBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse).slice(1);
  const scope = cases[0].read_scopes?.[0];
  const prepared = prepareDevelopmentCases({ cases, proofs, verified, entries: rows, availability, sourceKey, scope, sourceSha256: source.source_sha256, toolCallReview });
  const reviewUse = toolCallReviewSummary(toolCallReview, sourceKey);
  if (reviewUse.used !== reviewUse.approved) throw fail('toolcall_review_unused');
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
  const routeRates = { candidate: rates(model, DISTILLER_MAX_OUTPUT_TOKENS), reviewer: rates(reviewerModel, EVALUATOR_MAX_OUTPUT_TOKENS) };
  const priorPath = process.env.PILOT_PRIOR_LEDGER, priorSha = process.env.PILOT_PRIOR_LEDGER_SHA256;
  if (Boolean(priorPath) !== Boolean(priorSha) || (process.env.PILOT_PRIOR_LEDGERS && priorPath)) throw fail('prior_ledger_invalid');
  let priorLedgers = priorPath ? [{ path: priorPath, sha256: priorSha }] : [];
  if (process.env.PILOT_PRIOR_LEDGERS) {
    try { priorLedgers = JSON.parse(process.env.PILOT_PRIOR_LEDGERS); } catch { throw fail('prior_ledger_invalid'); }
  }
  if (!Array.isArray(priorLedgers) || new Set(priorLedgers.map(row => row?.sha256)).size !== priorLedgers.length) throw fail('prior_ledger_invalid');
  const attestationPath = process.env.PILOT_PRIOR_ATTESTATION, attestationSha = process.env.PILOT_PRIOR_ATTESTATION_SHA256;
  if (Boolean(attestationPath) !== Boolean(attestationSha) || (attestationPath && priorLedgers.length)) throw fail('prior_ledger_invalid');
  let priorAttestation = null;
  if (attestationPath) {
    const attestation = JSON.parse(pinned(attestationPath, attestationSha, 1_000_000).toString('utf8'));
    const texts = (attestation.ledgers ?? []).map(row => pinned(row.path, row.sha256, 10_000_000).toString('utf8'));
    priorAttestation = { path: attestationPath, sha256: attestationSha, ledgerSha256s: attestation.ledgers.map(row => row.sha256), ...attestedPriorSpend(attestation, texts) };
  }
  const previous = priorAttestation ? BigInt(priorAttestation.totalNano) : priorLedgers.reduce((sum, row) => {
    if (Boolean(row.reconciliationPath) !== Boolean(row.reconciliationSha256)) throw fail('prior_ledger_invalid');
    const reconciliations = [];
    if (row.reconciliationPath) {
      if (dirname(row.reconciliationPath) !== dirname(row.path)) throw fail('prior_ledger_invalid');
      const receipt = JSON.parse(pinned(row.reconciliationPath, row.reconciliationSha256, 100000).toString('utf8'));
      if (dirname(receipt.gateway_correlation_path ?? '') !== dirname(row.path)) throw fail('prior_ledger_invalid');
      pinned(receipt.gateway_correlation_path, receipt.gateway_correlation_sha256, 100000);
      reconciliations.push(receipt);
    }
    return sum + BigInt(priorSoftSpend(pinned(row.path, row.sha256, 10_000_000).toString('utf8'), { reconciliations }));
  }, 0n);
  let resume = null;
  const treatment = process.env.PILOT_TREATMENT ? TREATMENTS[process.env.PILOT_TREATMENT] ?? null : null;
  if (process.env.PILOT_TREATMENT && !treatment) throw fail('treatment_invalid');
  if (process.env.PILOT_RESUME) {
    let request;
    try { request = JSON.parse(process.env.PILOT_RESUME); } catch { throw fail('resume_invalid'); }
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail('resume_invalid');
    const report = JSON.parse(pinned(request.reportPath, request.reportSha256, 10_000_000).toString('utf8'));
    validatePriorSpendContinuity(previous.toString(), report.budget?.total_spent_nano);
    const priorDir = dirname(request.reportPath);
    const checkpointsAtCursor = report.artifacts?.checkpoint_snapshots?.filter(row => row.through === request.cursor) ?? [];
    const checkpointMatch = checkpointsAtCursor.length === 1;
    const snapshotPathMatch = report.artifacts?.checkpoint_snapshots?.some(row => row.through === request.cursor && row.path === request.snapshotPath && row.sha256 === request.snapshotSha256)
      || report.artifacts?.case_snapshots?.some(row => row.path === request.snapshotPath && row.sha256 === request.snapshotSha256
        && prepared.some(item => item.through === request.cursor && item.publicCase.id === row.case_id));
    if (dirname(priorDir) !== parent || report.run_dir !== priorDir
      || request.sealPath !== report.artifacts?.['seal.json']?.path || request.sealSha256 !== report.artifacts?.['seal.json']?.sha256
      || request.progressPath !== report.artifacts?.['progress.jsonl']?.path || request.progressSha256 !== report.artifacts?.['progress.jsonl']?.sha256
      || request.journalPath !== join(priorDir, `coverage-${digest(['coverage-session/v1', sourceKey])}.jsonl`)
      || !checkpointMatch || !snapshotPathMatch) throw fail('resume_provenance_mismatch');
    const priorSeal = JSON.parse(pinned(request.sealPath, request.sealSha256, 10_000_000).toString('utf8'));
    if (priorSeal.spec?.answerer?.citationProtocol !== CITATION_PROTOCOL || !CITED_RESUME_TRANSITIONS.includes(request.transition)) throw fail('legacy_resume_forbidden');
    const progressBytes = pinned(request.progressPath, request.progressSha256, 10_000_000);
    const journalBytes = pinned(request.journalPath, request.journalSha256, 20_000_000);
    const snapshotBytes = pinned(request.snapshotPath, request.snapshotSha256, 128_000_000);
    const checkpointRef = checkpointsAtCursor[0];
    const checkpointBytes = checkpointRef.sha256 === request.snapshotSha256 ? snapshotBytes : pinned(checkpointRef.path, checkpointRef.sha256, 128_000_000);
    const checkpointSnapshotEquivalent = checkpointRef.sha256 === request.snapshotSha256
      || sameLogicalSnapshot(JSON.parse(checkpointBytes), JSON.parse(snapshotBytes));
    if (!checkpointSnapshotEquivalent) throw fail('resume_snapshot_mismatch');
    if (Boolean(request.driftPath) !== Boolean(request.driftSha256)) throw fail('resume_invalid');
    const driftPath = request.driftPath ?? report.source_tree_drift?.artifact ?? null;
    const driftSha = request.driftSha256 ?? report.source_tree_drift?.sha256 ?? null;
    if (Boolean(driftPath) !== Boolean(driftSha) || (driftPath && dirname(driftPath) !== priorDir)) throw fail('resume_invalid');
    const driftBytes = driftPath ? pinned(driftPath, driftSha, 100000) : null;
    const progress = progressBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
    const cursorIndex = checkpoints.findIndex(row => row.id === request.cursor);
    if (cursorIndex < 0) throw fail('resume_invalid');
    const completedCases = prepared.filter(item => checkpoints.findIndex(row => row.id === item.through) <= cursorIndex
      && progress.some(row => row.type === 'case' && row.case_id === item.publicCase.id && row.status === 'scored'));
    const handbacks = [], handbackRows = [], carriedRows = [], carriedSnapshots = [], originSeals = [], carriedCases = [], originBundles = new Map();
    for (const item of completedCases) {
      const priorCarried = report.artifacts?.carried_cases?.find(row => row.caseId === item.publicCase.id);
      const originPath = priorCarried?.sourceReportPath ?? request.reportPath;
      const originSha = priorCarried?.sourceReportSha256 ?? request.reportSha256;
      if (basename(originPath ?? '') !== 'REPORT.json' || dirname(dirname(originPath)) !== parent) throw fail('handback_invalid');
      const origin = JSON.parse(pinned(originPath, originSha, 10_000_000).toString('utf8'));
      if (origin.run_dir !== dirname(originPath)) throw fail('handback_invalid');
      const readArtifact = key => {
        const descriptor = origin.artifacts?.[key];
        return pinned(descriptor?.path, descriptor?.sha256, 128_000_000);
      };
      const sealBytes = readArtifact('seal.json'), resultsBytes = readArtifact('case-results.jsonl'), outputsBytes = readArtifact('model-outputs.jsonl');
      const originSeal = JSON.parse(sealBytes.toString('utf8'));
      const originProgress = readArtifact('progress.jsonl').toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
      const originResults = resultsBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
      const originOutputs = outputsBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
      const originLedger = readArtifact('ledger.jsonl').toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
      if (!originBundles.has(originSha)) originBundles.set(originSha, { sealBytes, resultsBytes, outputsBytes });
      const caseSnapshot = origin.artifacts?.case_snapshots?.find(row => row.case_id === item.publicCase.id);
      pinned(caseSnapshot?.path, caseSnapshot?.sha256, 128_000_000);
      const handback = validateCaseHandback({ report: origin, reportSha256: originSha, seal: originSeal, progress: originProgress,
        resultRows: originResults, outputRows: originOutputs, ledgerRows: originLedger, cases: [item], checkpoints, cursor: request.cursor, sourceKey });
      if (handback.descriptors.length !== 1) throw fail('handback_invalid');
      handbacks.push(handback.descriptors[0]); handbackRows.push(...handback.reportRows); carriedRows.push(...handback.carriedRows);
      carriedSnapshots.push(...handback.caseSnapshots);
      if (!originSeals.some(row => row.digest === originSeal.digest)) originSeals.push(originSeal);
      carriedCases.push({ ...handback.descriptors[0], sourceReportPath: originPath,
        sourceResultsPath: origin.artifacts['case-results.jsonl'].path, sourceOutputsPath: origin.artifacts['model-outputs.jsonl'].path,
        sourceLedgerPath: origin.artifacts['ledger.jsonl'].path, sourceSealPath: origin.artifacts['seal.json'].path, sourceSnapshotPath: caseSnapshot.path });
    }
    const plan = { priorRunId: report.run_id, priorSealDigest: priorSeal.digest, priorCodeSha: priorSeal.spec?.codeSha,
      cursor: request.cursor, snapshotSha256: request.snapshotSha256, journalSha256: request.journalSha256,
      transition: request.transition, ledgerReconciliationSha256s: priorLedgers.map(row => row.reconciliationSha256).filter(Boolean),
      caseHandbacks: handbacks, checkpointSnapshotSha256: checkpointRef.sha256, ...(driftBytes ? { sourceTreeDriftSha256: driftSha } : {}),
      ...(request.transition === 'default-path-code-transition' ? { codeTransition: { from: priorSeal.spec?.codeSha, to: codeSha,
        failureCode: request.codeTransition?.failureCode, failedCheckpoint: request.codeTransition?.failedCheckpoint,
        reason: request.codeTransition?.reason, evidence: request.codeTransition?.evidence, reviewedPaths: request.codeTransition?.reviewedPaths,
        changedPaths: changedPaths(priorSeal.spec?.codeSha, codeSha) } } : {}) };
    let superseded = null, partialCase = null;
    const pendingCases = prepared.filter(item => item.through === request.cursor && !completedCases.includes(item));
    if (pendingCases.length) {
      const priorResults = report.artifacts?.['case-results.jsonl'];
      const resultBytes = pinned(priorResults?.path, priorResults?.sha256, 20_000_000);
      const priorRows = resultBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
      const priorLedger = report.artifacts?.['ledger.jsonl'];
      const ledgerRows = pinned(priorLedger?.path, priorLedger?.sha256, 20_000_000).toString('utf8').trimEnd().split('\n').map(JSON.parse);
      const priorOutputs = report.artifacts?.['model-outputs.jsonl'];
      const outputBytes = priorOutputs ? pinned(priorOutputs.path, priorOutputs.sha256, 128_000_000) : null;
      const outputRows = outputBytes ? outputBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse) : [];
      if (priorRows.some(row => pendingCases.some(item => item.publicCase.id === row.case_id))) {
        if (pendingCases.length !== 1) throw fail('resume_partial_case_unsupported');
        if (request.transition === 'specific-scorer-repair-and-arm-handback') {
          partialCase = validatePartialCaseHandback({ report, reportSha256: request.reportSha256, seal: priorSeal,
            resultRows: priorRows, outputRows, ledgerRows, item: pendingCases[0] });
          carriedRows.push(partialCase.candidateAnswer, partialCase.candidateJudgment, partialCase.baselineAnswer);
        } else if (request.transition === 'specific-scorer-repair-continuation') {
          const descriptor = report.resume?.partialCaseHandback, originPath = request.partialOriginReportPath;
          if (!descriptor || basename(originPath ?? '') !== 'REPORT.json' || dirname(dirname(originPath)) !== parent) throw fail('handback_invalid');
          const originBytes = pinned(originPath, descriptor.sourceReportSha256, 10_000_000), originReport = JSON.parse(originBytes);
          if (originReport.run_id !== descriptor.sourceRunId || originReport.run_dir !== dirname(originPath)) throw fail('handback_invalid');
          const originArtifact = key => { const row = originReport.artifacts?.[key]; return pinned(row?.path, row?.sha256, 128_000_000); };
          const oldSealBytes = originArtifact('seal.json'), oldResultsBytes = originArtifact('case-results.jsonl'), oldOutputsBytes = originArtifact('model-outputs.jsonl');
          const originalSeal = JSON.parse(oldSealBytes.toString('utf8'));
          const originalPartial = validatePartialCaseHandback({ report: originReport, reportSha256: descriptor.sourceReportSha256, seal: originalSeal,
            resultRows: oldResultsBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse),
            outputRows: oldOutputsBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse),
            ledgerRows: originArtifact('ledger.jsonl').toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse), item: pendingCases[0] });
          partialCase = validateCaseContinuation({ report, reportSha256: request.reportSha256, seal: priorSeal, resultRows: priorRows,
            outputRows, ledgerRows, item: pendingCases[0], originalPartial, originalSeal });
          partialCase.originalSeal = originalSeal;
          carriedRows.push(partialCase.candidateAnswer, partialCase.candidateJudgment, partialCase.baselineAnswer,
            partialCase.baselineJudgment, partialCase.emptyAnswer);
          if (!originSeals.some(row => row.digest === originalSeal.digest)) originSeals.push(originalSeal);
          if (!originBundles.has(descriptor.sourceReportSha256)) originBundles.set(descriptor.sourceReportSha256,
            { sealBytes: oldSealBytes, resultsBytes: oldResultsBytes, outputsBytes: oldOutputsBytes });
        } else throw fail('resume_partial_case_unsupported');
        if (partialCase.descriptor.snapshotSha256 !== request.snapshotSha256) throw fail('handback_snapshot_invalid');
        plan.partialCaseHandback = partialCase.descriptor;
        plan.specificScorerRepair = { instruction: SCORER_SPECIFIC_REPAIR, ...(request.transition === 'specific-scorer-repair-continuation'
          ? { multiInstruction: SCORER_MULTI_REPAIR, scope: 'per-arm', allowedArms: ['empty', 'raw-only'] } : {}),
          maxCalls: 1, format: 'scorer-r2-v3-specific-repair' };
        if (!originSeals.some(row => row.digest === priorSeal.digest)) originSeals.push(priorSeal);
        if (!originBundles.has(request.reportSha256)) originBundles.set(request.reportSha256,
          { sealBytes: pinned(request.sealPath, request.sealSha256, 10_000_000), resultsBytes: resultBytes, outputsBytes: outputBytes });
      } else {
        const calls = ledgerRows.filter(row => row.type === 'started' && row.checkpoint === request.cursor && ['answerer', 'scorer'].includes(row.purpose))
          .map(row => ({ id: row.id, purpose: row.purpose, arm: row.arm, context_sha256: row.context_sha256, at: row.at }));
        const outputAvailable = Boolean(priorOutputs && calls.length && calls.every(call => outputRows.some(row => row.id === call.id && row.message)));
        superseded = { schema: 'superseded-case-attempt/v1', prior_run_id: report.run_id, case_ids: pendingCases.map(item => item.publicCase.id),
          pre_answer_snapshot_sha256: request.snapshotSha256, prior_ledger_sha256: priorLedger.sha256, calls,
          status: 'superseded', output_available: outputAvailable,
          ...(outputAvailable ? { prior_output_path: priorOutputs.path, prior_output_sha256: priorOutputs.sha256 }
            : { limitation: 'The earlier harness did not persist answer or scorer raw outputs.' }) };
      }
    }
    resume = { report, priorSeal, progress, journalBytes, snapshotBytes, checkpointSnapshotEquivalent, driftBytes, plan, superseded, partialCase,
      handbacks, handbackRows, carriedRows, carriedSnapshots, originSeals, carriedCases, originBundles };
  }
  const remaining = WORKER_SHARE_NANO - previous;
  if (remaining <= 0n) throw fail('soft_cap_exhausted');
  const seal = createCitedPilotPlan({ cases: prepared, sourceSha256: source.source_sha256, datasetSha256: manifestSha, sdkSha256: sdkSessionSha,
    codeSha, routes: routeRates, capNano: remaining.toString(), priorSpendNano: previous.toString(), resume: resume?.plan ?? null,
    toolCallReviewSha256: reviewMapSha, treatment,
    interpretationSha256: INTERPRETATION_02_SHA256 });
  if (resume?.handbackRows.length) pairedReport({ seal, expectedDigest: seal.digest, rows: resume.handbackRows, dependencies: [],
    provenance: resume.originSeals.filter(row => row.digest !== seal.digest) });
  const runId = randomUUID(), dir = mkdtempSync(join(parent, 'pilot-'));
  const driverDir = join(dir, 'driver'), piDir = join(dir, 'pi'), imageDir = join(dir, 'image-blobs'), runtimeDir = join(dir, 'runtime');
  mkdirSync(driverDir, { mode: 0o700 }); mkdirSync(piDir, { mode: 0o700 }); mkdirSync(imageDir, { mode: 0o700 }); mkdirSync(runtimeDir, { mode: 0o700 });
  const runtimeTree = prepareRuntimeTree({ repo: realpathSync('.'), codeSha, directory: runtimeDir,
    npmCache: process.env.SOURCE_MEMORY_NPM_CACHE ?? join(homedir(), '.npm') });
  writePrivate(join(dir, 'runtime-tree.json'), runtimeTree);
  mkdirSync(join(driverDir, 'intents'), { mode: 0o700 });
  const sourceCopy = join(dir, 'source.jsonl'); writePrivate(sourceCopy, sourceBytes);
  writePrivate(join(dir, 'seal.json'), seal);
  let resumeValidation = null;
  if (resume) {
    if (resume.superseded) writePrivate(join(dir, 'superseded-case-attempt.json'), resume.superseded);
    if (resume.partialCase) writePrivate(join(dir, 'partial-case-handback.json'), { schema: 'partial-case-handback/v1', ...resume.partialCase.descriptor });
    if (resume.driftBytes) writePrivate(join(dir, 'prior-source-tree-drift.json'), resume.driftBytes);
    if (resume.carriedCases.length) {
      const copies = [];
      for (const [originSha, bundle] of resume.originBundles) for (const [name, bytes] of Object.entries(bundle)) {
        const path = join(dir, `handback-${originSha.slice(0, 16)}-${name}.${name === 'sealBytes' ? 'json' : 'jsonl'}`);
        writePrivate(path, bytes);
        copies.push({ originReportSha256: originSha, kind: name, path, sha256: sha(bytes), bytes: bytes.length });
      }
      resume.handbackCopies = copies;
      writePrivate(join(dir, 'case-handback.json'), { schema: 'case-handback/v1', cases: resume.carriedCases, copies });
    }
    writePrivate(join(driverDir, 'resume-snapshot.json'), resume.snapshotBytes);
    writePrivate(join(dir, `coverage-${digest(['coverage-session/v1', sourceKey])}.jsonl`), resume.journalBytes);
    const priorJournal = createCoverageJournal({ directory: dir, sessionKey: sourceKey });
    try {
      resumeValidation = validatePilotResume({ report: resume.report, seal: resume.priorSeal, currentSeal: seal, progress: resume.progress, journal: priorJournal,
        checkpoints, cases: prepared, cursor: resume.plan.cursor, snapshotSha256: resume.plan.snapshotSha256, journalSha256: resume.plan.journalSha256,
        sourceSha256: source.source_sha256, datasetSha256: manifestSha, priorLedgerSha256s: priorAttestation?.ledgerSha256s ?? priorLedgers.map(row => row.sha256),
        reconciliationSha256s: priorLedgers.map(row => row.reconciliationSha256).filter(Boolean), caseHandbacks: resume.handbacks,
        partialCaseHandback: resume.partialCase?.descriptor ?? null, checkpointSnapshotEquivalent: resume.checkpointSnapshotEquivalent,
        sourceTreeDriftSha256: resume.plan.sourceTreeDriftSha256 ?? null });
    } finally { priorJournal.close(); }
  }
  writePrivate(join(driverDir, 'config.json'), { neo4j: { uri: 'bolt://127.0.0.1:7687', auth: 'none' }, scopes: { read: [scope], write: [scope] },
    chunking: { words: 256, overlap: 32 }, embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'embeddinggemma', dimensions: 768, timeout_ms: 120000 }, index_on_write: false });
  const resources = privateWriter(join(dir, 'resources.jsonl')), progress = privateWriter(join(dir, 'progress.jsonl'));
  const memoryLog = privateWriter(join(dir, 'memory-receipts.jsonl')), results = privateWriter(join(dir, 'case-results.jsonl'));
  const relayLog = privateWriter(join(dir, 'embedding-relay.jsonl')), rawOutputs = privateWriter(join(dir, 'model-outputs.jsonl')),
    snapshotChecks = privateWriter(join(dir, 'snapshot-verifications.jsonl'));
  const image = name => execFileSync('/usr/bin/docker', ['image', 'inspect', name, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
  const docker = createNamespaceDocker({ databaseImage: image('neo4j:5.26.14-community'), driverImage: image('node:22-bookworm-slim'),
    mounts: { memory: runtimeDir, scratch: driverDir }, runId, onResource: row => resources.append(row) });
  const budget = createSoftBudget({ path: join(dir, 'ledger.jsonl'), capNano: remaining.toString(), sessionKey: `pilot-${runId}`, sealSha256: seal.digest,
    routes: { [exactRoute(model)]: routeRates.candidate, [exactRoute(reviewerModel)]: routeRates.reviewer }, onRaw: row => rawOutputs.append(row) });
  const onInterrupt = signal => { try { budget.requestStop(signal); } catch {} };
  const onSigint = () => onInterrupt('SIGINT'), onSigterm = () => onInterrupt('SIGTERM');
  process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
  let meta = { purpose: 'candidate', arm: 'candidate', checkpoint: 'preflight', task_version: 'distiller-r2-v4', policy_version: seal.spec.policyVersion };
  let journal, sequenceResult, snapshot, resumeRestore, partialCaseResult = null, failure = null;
  const reportRows = resume ? [...resume.handbackRows] : [],
    caseSnapshots = Object.fromEntries((resume?.carriedSnapshots ?? []).map(row => [row.case_id, row])), checkpointSnapshots = {};
  const imageHashes = { database: image('neo4j:5.26.14-community'), driver: image('node:22-bookworm-slim') };
  const harness = await runNamespaceHarness({ docker, relay: { open: ({ socketPath }) => openUnixEmbeddingRelay({ socketPath, timeoutMs: 90000,
    onEvent: event => relayLog.append({ checkpoint: meta.checkpoint, ...event }) }) },
    socketPath: join(driverDir, 'embeddings.sock'), shimPort: 18080,
    async onIsolation(isolation) {
      writePrivate(join(dir, 'isolation.json'), isolation);
      if (!isolation.ok) return;
      const ready = { status: 'awaiting_go', run_id: runId, run_dir: dir, source_key: sourceKey, source_sha256: source.source_sha256,
        dataset_sha256: manifestSha, code_sha: codeSha, seal_sha256: seal.digest, interpretation_sha256: INTERPRETATION_02_SHA256,
        toolcall_review: reviewUse, treatment,
        runtime_archive_sha256: runtimeTree.archive_sha256,
        sdk_index_sha256: sdkIndexSha, sdk_session_sha256: sdkSessionSha,
        models: { candidate: exactRoute(model), reviewer: exactRoute(reviewerModel), answerer: exactRoute(reviewerModel), scorer: exactRoute(reviewerModel) },
        routes: { origin: 'http://127.0.0.1:3003', privacy: 'configured Pi provider inference; local artifacts; no external review packets' },
        budget: { overall_effort_soft_usd: 250, share_soft_usd: Number(WORKER_SHARE_NANO / 1_000_000_000n), prior_spend_nano: previous.toString(), prior_attestation: priorAttestation,
          remaining_soft_nano: remaining.toString(), prior_ledger_sha256s: priorLedgers.map(row => row.sha256),
          prior_reconciliation_sha256s: priorLedgers.map(row => row.reconciliationSha256).filter(Boolean), one_call_in_flight: true, stop_unknown_usage: true,
          stop_above_twice_estimate: true, gateway_attempt_ledger: 'partial: gateway-internal failover/retry attempts not correlatable', rate_card: routeRates },
        checkpoints: checkpoints.length, cases: prepared.length, resume: resumeValidation ? { ...resumeValidation, restore: 'pending' } : null,
        isolation: { network_mode: isolation.network_mode,
          namespace: isolation.namespace, interfaces: isolation.interfaces, no_default_route: isolation.no_default_route,
          probes: isolation.targets.length, connected: isolation.targets.filter(row => row.outcome === 'connected').length,
          unprobeable_link_local: isolation.unprobeable_link_local.length }, images: imageHashes };
      writePrivate(join(dir, 'READY.json'), ready);
      process.stdout.write(`${JSON.stringify(ready)}\n`);
      if (process.env.SOURCE_MEMORY_PREFLIGHT_ONLY === '1') throw fail('preflight_only');
      const deadline = Date.now() + 600000, go = join(dir, 'GO');
      while (Date.now() < deadline) {
        if (budget.state().stopped) throw fail(budget.state().stopped);
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
      timeoutMs: 180000, indexTimeoutMs: 600000, offerTimeoutMs: 120000, onReceipt: event => memoryLog.append({ checkpoint: meta.checkpoint, ...event }) }); },
    async work({ memory, driver }) {
      const guarded = trackSnapshot(memory);
      journal = createCoverageJournal({ directory: dir, sessionKey: sourceKey });
      try {
        if (resume) {
          const current = validatePilotResume({ report: resume.report, seal: resume.priorSeal, currentSeal: seal, progress: resume.progress, journal,
            checkpoints, cases: prepared, cursor: resume.plan.cursor, snapshotSha256: resume.plan.snapshotSha256, journalSha256: resume.plan.journalSha256,
            sourceSha256: source.source_sha256, datasetSha256: manifestSha, priorLedgerSha256s: priorAttestation?.ledgerSha256s ?? priorLedgers.map(row => row.sha256),
            reconciliationSha256s: priorLedgers.map(row => row.reconciliationSha256).filter(Boolean), caseHandbacks: resume.handbacks,
            partialCaseHandback: resume.partialCase?.descriptor ?? null, checkpointSnapshotEquivalent: resume.checkpointSnapshotEquivalent,
            sourceTreeDriftSha256: resume.plan.sourceTreeDriftSha256 ?? null });
          if (JSON.stringify(current) !== JSON.stringify(resumeValidation)) throw fail('resume_provenance_mismatch');
          const output = execFileSync('/usr/bin/docker', ['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/restore-scope.mjs',
            '/scratch/resume-snapshot.json', resume.plan.snapshotSha256, scope], { encoding: 'utf8', timeout: 180000, maxBuffer: 100000 });
          const restored = JSON.parse(output);
          if (restored.equivalent !== true || restored.source_sha256 !== resume.plan.snapshotSha256) throw fail('resume_restore_unverified');
          const restoredIds = JSON.parse(resume.snapshotBytes).nodes.filter(row => row.labels?.includes('SMRecord')).map(row => row.properties?.record_id);
          if (restoredIds.some(id => typeof id !== 'string' || !id)) throw fail('resume_restore_unverified');
          for (let i = 0; i < restoredIds.length; i += 16) await ensureIndexed(memory, scope, { status: 'ready' },
            { waitForVectors: true, recordIds: restoredIds.slice(i, i + 16) });
          resumeRestore = { ...restored, ...resumeValidation };
          writePrivate(join(dir, 'resume-restore.json'), resumeRestore);
          progress.append({ type: 'resume', ...resumeValidation, restored_sha256: restored.restored_sha256, equivalent: true });
          for (const row of resume.carriedRows) results.append(row);
          for (const handback of resume.handbacks) progress.append({ type: 'case', case_id: handback.caseId, status: 'scored', inherited: true,
            source_seal_digest: handback.sourceSealDigest, snapshot_sha256: handback.snapshotSha256, budget: budget.state() });
          for (const row of resume.progress.filter(item => {
            const index = checkpoints.findIndex(cp => cp.id === item.through);
            return item.type === 'checkpoint' && item.snapshot && index >= 0 && index < resumeValidation.prefixCount;
          })) {
            checkpointSnapshots[row.through] = row.snapshot;
            progress.append({ type: 'checkpoint', through: row.through, disposition: row.disposition, inherited: true,
              search_incomplete: row.search_incomplete ?? null, search_statuses: row.search_statuses ?? [], snapshot: row.snapshot, budget: budget.state() });
          }
        }
        const session = await createSliceSession({ pi, source: sourceCopy, entries: rows, conversationId: source.conversation_id, workDir: piDir, scope,
          memory: guarded.client, modelId: exactRoute(model), reviewerId: exactRoute(reviewerModel), coverageJournal: journal,
          retrieval: treatment?.retrieval ?? 'search', guidance: treatment?.guidance ?? null,
          budget: createInputBudget(Number.MAX_SAFE_INTEGER),
          imageArchive: createImageArchive({ directory: imageDir }),
          ensureIndexed: (client, selectedScope, state, options = {}) => ensureIndexed(client, selectedScope, state,
            { waitForVectors: true, batchLimit: 16, maxRounds: 128, maxIndexRetries: 2, ...options }),
          meterRuntime: (underlying, context) => budget.wrap(underlying, () => ({ ...meta,
            purpose: context.purpose, task_version: context.purpose === 'candidate' ? 'distiller-r2-v4' : 'link-review-r2-v3' })) });
        const evaluatorRuntime = budget.wrap(runtime, () => meta);
        sequenceResult = await runPilotSequence({ session, journal, checkpoints, cases: prepared, budget,
          initialCursor: resumeValidation?.cursor ?? null, retryFirst: resumeValidation?.retryFirst ?? false,
          completedCaseIds: resume?.handbacks.map(row => row.caseId) ?? [],
          async onBeforeCheckpoint(checkpoint) { meta = { purpose: 'candidate', arm: 'candidate', checkpoint: checkpoint.id,
            task_version: 'distiller-r2-v4', policy_version: seal.spec.policyVersion }; },
          async onCheckpoint(row, state) {
            const through = checkpointId(row);
            let checkpointSnapshot = null;
            if (['committed', 'abstained'].includes(row.disposition)) {
              checkpointSnapshot = await docker.snapshot({ driver, scope, filename: `baseline-${runId}-${sha(through).slice(0, 16)}.json` });
              checkpointSnapshots[through] = checkpointSnapshot;
            }
            progress.append({ type: 'checkpoint', through, disposition: row.disposition,
              search_incomplete: row.search_incomplete ?? null, search_statuses: row.search_statuses ?? [],
              image_limitation: row.omissions?.images ?? null, snapshot: checkpointSnapshot, budget: state });
          },
          async onCase(row, state) { progress.append({ type: 'case', case_id: row.case_id, status: row.status, budget: state }); },
          async evaluateCase(item, cursor) {
            const held = guarded.acquire(item.publicCase.queryTime);
            try {
              caseSnapshots[item.publicCase.id] = await docker.snapshot({ driver, scope,
                filename: `baseline-${runId}-${sha(item.publicCase.id).slice(0, 16)}.json` });
              const original = caseSnapshots[item.publicCase.id];
              const expectedSnapshot = JSON.parse(pinned(original.path, original.sha256, 128_000_000));
              let verificationSequence = 0;
              const verifySnapshot = createSnapshotVerifier({ held, expectedSnapshot,
                async capture() {
                  const sequence = (++verificationSequence).toString(16).padStart(8, '0');
                  const check = await docker.snapshot({ driver, scope,
                    filename: `baseline-${runId}-${sha(item.publicCase.id).slice(0, 16)}-${sequence}.json` });
                  return { snapshot: JSON.parse(pinned(check.path, check.sha256, 128_000_000)),
                    receipt: { case_id: item.publicCase.id, sequence, expected_sha256: original.sha256,
                      observed_sha256: check.sha256, path: check.path } };
                },
                onCheck: row => snapshotChecks.append(row),
              });
              const allow = async access => access.actor === item.publicCase.actor && access.queryTime === item.publicCase.queryTime;
              const empty = { async searchDerived() { return []; }, async resolveDerived() { throw fail('evidence_not_offered'); } };
              const candidate = { scope, snapshotId: held.id, authorize: allow, verifySnapshot, client: session.memory };
              const baseline = { scope, snapshotId: held.id, authorize: allow, verifySnapshot, client: empty };
              const adapter = createDerivedAdapter({ stores: { candidate, 'baseline-empty': baseline } });
              const archive = { async search(args) {
                if (!await allow(args) || await verifySnapshot(args.queryTime) !== held.id) throw fail('snapshot_unverified');
                const value = await session.memory.searchRaw(scope, { query: args.query, limit: args.limit });
                if (await verifySnapshot(args.queryTime) !== held.id) throw fail('snapshot_unverified');
                return value;
              } };
              const respond = createPiAnswererResponder({ runtime: evaluatorRuntime, model: reviewerModel, sessionId: `answer-${runId}-${item.publicCase.id}`,
                expectedToolsSha256: seal.spec.answerer.tools_sha256 });
              const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: adapter, archive, respond });
              const judge = createPiScorerJudge({ runtime: evaluatorRuntime, model: reviewerModel, sessionId: `score-${runId}-${item.publicCase.id}`, outputTokens: 4096 });
              const scorer = createScorer({ seal, expectedDigest: seal.digest, judge });
              const partial = resume?.partialCase?.descriptor.caseId === item.publicCase.id ? resume.partialCase : null;
              const arms = {}, failedArms = [], repairs = [];
              const specific = async (arm, answer, originSeal, previousMessage, clauseIds) => {
                const repair = createPiScorerSpecificRepair({ runtime: evaluatorRuntime, model: reviewerModel,
                  sessionId: `score-repair-${runId}-${item.publicCase.id}-${arm}`, outputTokens: 4096 });
                const anchored = createScorer({ seal: originSeal, expectedDigest: originSeal.digest,
                  judge: request => repair({ ...request, previousMessage, clauseIds }) });
                meta = { purpose: 'scorer', arm, checkpoint: cursor, task_version: 'scorer-r2-v3-specific-repair', policy_version: seal.spec.policyVersion };
                try {
                  const judged = await anchored.score({ packet: item.packet, answer: answer.answer, trace: answer.trace });
                  arms[arm] = judged.score;
                  const receipt = { arm, format: 'scorer-r2-v3-specific-repair', repairSealDigest: seal.digest };
                  repairs.push(receipt);
                  results.append({ type: 'judgment', case_id: item.publicCase.id, arm, judgment: judged.judgment, score: judged.score, repair: receipt });
                } catch (error) {
                  if (error?.code !== 'scorer_output_invalid') throw error;
                  failedArms.push(arm);
                  results.append({ type: 'scorer_failed', case_id: item.publicCase.id, arm,
                    reason: 'specific_repair_still_invalid', repairSealDigest: seal.digest });
                }
              };
              for (const arm of ['candidate', 'baseline', 'empty', 'raw-only']) {
                if (partial && arm === 'candidate') { arms.candidate = partial.candidateJudgment.score; continue; }
                if (partial?.baselineJudgment && arm === 'baseline') {
                  arms.baseline = partial.baselineJudgment.score;
                  repairs.push({ arm: 'baseline', format: 'scorer-r2-v3-specific-repair', repairSealDigest: resume.priorSeal.digest });
                  continue;
                }
                if (partial?.emptyAnswer && arm === 'empty') {
                  await specific('empty', partial.emptyAnswer.answer, resume.priorSeal, partial.previousMessage, partial.clauseIds);
                  continue;
                }
                if (partial && arm === 'baseline') {
                  await specific('baseline', partial.baselineAnswer.answer, resume.priorSeal, partial.previousMessage, [partial.clauseId]);
                  continue;
                }
                meta = { purpose: 'answerer', arm, checkpoint: cursor, task_version: seal.spec.answerer.version, policy_version: seal.spec.policyVersion };
                const answer = await answerer.run({ arm, case: item.publicCase });
                results.append({ type: 'answer', case_id: item.publicCase.id, arm, answer });
                meta = { purpose: 'scorer', arm, checkpoint: cursor, task_version: seal.spec.scorer.version, policy_version: seal.spec.policyVersion };
                try {
                  const judged = await scorer.score({ packet: item.packet, answer: answer.answer, trace: answer.trace });
                  arms[arm] = judged.score;
                  results.append({ type: 'judgment', case_id: item.publicCase.id, arm, judgment: judged.judgment, score: judged.score });
                } catch (error) {
                  if (error?.code !== 'scorer_output_invalid' || !partial || !['empty', 'raw-only'].includes(arm)) throw error;
                  const calls = error.last_message?.content?.filter(row => row.type === 'toolCall' && row.name === 'submit_score') ?? [];
                  const clauseIds = calls.length === 1 ? calls[0].arguments?.clauses?.filter(row => row.judgments?.support === 'pass'
                    && Array.isArray(row.sourceIds) && row.sourceIds.length === 0).map(row => row.id) ?? [] : [];
                  if (clauseIds.length) await specific(arm, answer, seal, error.last_message, clauseIds);
                  else { failedArms.push(arm); results.append({ type: 'scorer_failed', case_id: item.publicCase.id, arm, reason: 'invalid_output_without_specific_rule' }); }
                }
              }
              if (failedArms.length) {
                partialCaseResult = { case_id: item.publicCase.id, status: 'partial', failed_arms: failedArms, arms,
                  source_snapshot_sha256: partial?.descriptor.snapshotSha256 ?? null };
                return { case_id: item.publicCase.id, status: 'partial', failed_arms: failedArms, reference: 'pending_reference_freeze', snapshot: caseSnapshots[item.publicCase.id] };
              }
              reportRows.push({ caseId: item.publicCase.id, sessions: [sourceKey], sealDigest: seal.digest, packetDigest: arms.candidate.packetDigest, arms,
                ...(partial && !partial.baselineJudgment ? { repair: { arm: 'baseline', format: 'scorer-r2-v3-specific-repair', repairSealDigest: seal.digest } } : {}),
                ...(repairs.length ? { repairs } : {}) });
              return { case_id: item.publicCase.id, status: 'scored', reference: 'pending_reference_freeze', snapshot: caseSnapshots[item.publicCase.id] };
            } finally { held.release(); }
          } });
        if (sequenceResult.failure) failure = sequenceResult.failure;
        if (['complete', 'complete_with_partial_cases'].includes(sequenceResult.status) && source.leaf_entry_id !== sequenceResult.cursor) {
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
  try {
    if (reportRows.length && sequenceResult?.status !== 'invalid_search_truncation') scorecard = pairedReport({ seal, expectedDigest: seal.digest, rows: reportRows, dependencies: [],
      provenance: (resume?.originSeals ?? []).filter(row => row.digest !== seal.digest) });
  } catch (error) { failure ??= typeof error?.code === 'string' ? error.code : 'scorecard_failed'; }
  process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm);
  if (budget.state().stopped === 'operator_interrupted') failure ??= 'operator_interrupted';
  try { budget.close(); } catch { failure ??= 'ledger_close_failed'; }
  for (const writer of [resources, progress, memoryLog, results, relayLog, rawOutputs, snapshotChecks]) {
    try { writer.close(); } catch { failure ??= 'artifact_close_failed'; }
  }
  const artifactNames = ['seal.json', 'runtime-tree.json', 'ledger.jsonl', 'progress.jsonl', 'memory-receipts.jsonl', 'case-results.jsonl', 'model-outputs.jsonl', 'snapshot-verifications.jsonl', 'resources.jsonl',
    'isolation.json', 'embedding-relay.jsonl', 'environment.json', 'resume-restore.json', 'superseded-case-attempt.json', 'case-handback.json',
    'partial-case-handback.json', 'prior-source-tree-drift.json'];
  const artifacts = {};
  for (const name of artifactNames) {
    try { const bytes = readFileSync(join(dir, name)); artifacts[name] = { path: join(dir, name), sha256: sha(bytes), bytes: bytes.length }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
  if (snapshot?.path) { const bytes = readFileSync(snapshot.path); if (sha(bytes) !== snapshot.sha256) throw fail('snapshot_changed');
    artifacts.baseline_snapshot = { path: snapshot.path, sha256: snapshot.sha256, bytes: bytes.length, restore_verified: false }; }
  artifacts.checkpoint_snapshots = Object.entries(checkpointSnapshots).map(([through, item]) => {
    const bytes = readFileSync(item.path);
    if (sha(bytes) !== item.sha256) throw fail('snapshot_changed');
    return { through, path: item.path, sha256: item.sha256, bytes: bytes.length,
      restore_verified: resumeRestore?.equivalent === true && item.sha256 === resumeRestore.source_sha256 };
  });
  artifacts.carried_cases = resume?.carriedCases ?? [];
  artifacts.handback_copies = (resume?.handbackCopies ?? []).map(item => {
    const bytes = readFileSync(item.path);
    if (sha(bytes) !== item.sha256) throw fail('handback_changed');
    return item;
  });
  artifacts.case_snapshots = Object.entries(caseSnapshots).map(([caseId, item]) => {
    const bytes = readFileSync(item.path);
    if (sha(bytes) !== item.sha256) throw fail('snapshot_changed');
    const planned = prepared.find(row => row.publicCase.id === caseId);
    if (!planned) throw fail('case_schedule_invalid');
    return { case_id: caseId, through_entry_id: planned.through, path: item.path, sha256: item.sha256, bytes: bytes.length, restore_verified: false };
  });
  artifacts.source_snapshot = { path: sourceCopy, sha256: source.source_sha256, bytes: sourceBytes.length };
  artifacts.image_blobs = readdirSync(imageDir).map(name => {
    if (!/^[a-f0-9]{64}\.blob$/.test(name)) throw fail('image_archive_conflict');
    const path = join(imageDir, name), bytes = readFileSync(path), digest = sha(bytes);
    if (`${digest}.blob` !== name) throw fail('image_archive_conflict');
    return { path, sha256: digest, bytes: bytes.length };
  });
  } catch (error) {
    failure ??= typeof error?.code === 'string' ? error.code : 'artifact_verification_failed';
    scorecard = null;
  }
  const final = { status: sequenceResult?.status === 'invalid_search_truncation' ? 'invalid: search truncation fault'
    : harness.status === 'complete' && !failure && sequenceResult?.status === 'complete' ? 'partial_reference_unavailable'
      : harness.status === 'complete' && !failure && sequenceResult?.status === 'complete_with_partial_cases' ? 'partial_scorer_failed' : 'failed_or_partial',
    harness_status: harness.status, failure: failure ?? harness.code ?? null, resume: resumeValidation, resume_restore: resumeRestore ?? null,
    source_tree_drift: resume?.driftBytes ? { sha256: sha(resume.driftBytes), artifact: join(dir, 'prior-source-tree-drift.json'),
      limitation: 'The preceding run experienced disclosed additive source-tree drift; see the retained incident.' } : null,
    future_scorer_instruction: { path: resolve('pi-extension/evaluation/next-round-scorer-instructions.md'),
      sha256: sha(readFileSync('pi-extension/evaluation/next-round-scorer-instructions.md')), applies: 'future rounds; current pilot repair only' },
    coverage: sequenceResult ? { status: sequenceResult.status, scheduled: checkpoints.length,
      processed: (resumeValidation?.prefixCount ?? 0) + sequenceResult.results.length, tail: sequenceResult.tail ?? null,
      dispositions: [...(resume ? (resume.report.coverage?.dispositions ?? resume.progress.filter(row => row.type === 'checkpoint')
        .map(row => ({ through: row.through, disposition: row.disposition, code: row.code ?? null }))).slice(0, resumeValidation.prefixCount) : []),
        ...sequenceResult.results.map(row => ({ through: checkpointId(row), disposition: row.disposition, code: row.code ?? null,
          search_incomplete: row.search_incomplete ?? null, search_statuses: row.search_statuses ?? [] }))] } : null,
    scorecard, partial_case: partialCaseResult, reference: 'pending_reference_freeze',
    stage_attribution: reportRows.map(row => ({ case_id: row.caseId, status: 'pending_reference_freeze',
      reason: 'Reference catalog and candidate-trace semantic comparison have not been validated.' })),
    snapshot: snapshot ?? null, budget: { ...budget.state(), prior_spend_nano: previous.toString(),
      total_spent_nano: (previous + BigInt(budget.state().spent_nano)).toString(), share_cap_nano: WORKER_SHARE_NANO.toString() },
    ledger_completeness: 'partial: gateway-internal failover/retry attempts not correlatable',
    image_limitation: 'Original image blobs are archived by SHA-256; image content is not text-citable.',
    latency_limitation: 'Local embedding latency is environment-sensitive; a later sample showed 100% GPU and elevated host load, not proof of contention during any call.', artifacts,
    mixed_code: seal.spec.resume?.codeTransition ? { from: seal.spec.resume.codeTransition.from, to: seal.spec.resume.codeTransition.to,
      cursor: seal.spec.resume.cursor, changed_paths: seal.spec.resume.codeTransition.changedPaths.length } : null,
    run_dir: dir, run_id: runId, seal_sha256: seal.digest };
  writePrivate(join(dir, 'REPORT.json'), final);
  process.stdout.write(`${JSON.stringify({ status: final.status, run_id: runId, run_dir: dir, failure: final.failure })}\n`);
}

main().catch(error => {
  const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'pilot_failed';
  process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`); process.exitCode = 1;
});
