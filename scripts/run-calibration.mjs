// Usage: PILOT_PRIOR_ATTESTATION=<path> PILOT_PRIOR_ATTESTATION_SHA256=<sha> \
//   node scripts/run-calibration.mjs <treatment: baseline|T1> <out dir> <Pi SDK index> <SDK sha256>
// Costed step: the real candidate distiller decides each fictional calibration case against an in-memory store.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIncrementalSession } from '../pi-extension/incremental.mjs';
import { createPiDistiller } from '../pi-extension/pi-runtime.mjs';
import { createInputBudget, boundPiRuntime } from '../pi-extension/budget.mjs';
import { resolvePiModels } from '../pi-extension/slice-runtime.mjs';
import { fictionalCalibrationV2, retentionPolicy } from '../pi-extension/policy.mjs';
import { createSoftBudget } from '../pi-extension/evaluation/soft-budget.mjs';
import { WORKER_SHARE_NANO, attestedPriorSpend } from '../pi-extension/evaluation/prior-spend.mjs';
import { TREATMENTS } from '../pi-extension/evaluation/pilot-plan.mjs';
import { hash } from '../pi-extension/evaluation/seal.mjs';
import { readPinned } from '../pi-extension/evaluation/climb.mjs';
import { privateDir, writeNew } from './export-climb-run.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const ROUTE = 'anthropic/claude-haiku-5-5', CHANNELS = ['turn_lexical', 'record_lexical', 'chunk_lexical', 'chunk_vector', 'record_vector'];

/** The compact search surface over a case's accessible prior items; every item is returned and nothing is omitted. */
export function calibrationMemory(prior) {
  const records = prior.map((text, i) => ({ id: `prior-${i}`, kind: 'observation', text }));
  const writes = [];
  let pending = null;
  const surface = () => ({ bindings: records.map((row, i) => ({ id: row.id, handle: `record-${i}` })),
    surface: { status: records.length ? 'ready' : 'no_matches', records: records.map((row, i) => ({ id: `record-${i}`, kind: row.kind, score: 0.5,
      text: row.text.slice(0, 80), text_truncated: row.text.length > 80 })), relations: [], ranked_count: records.length, seed_count: records.length,
    declared_seed_limit: 48, candidate_pool_limit: 64, budget_omitted: 0, edge_budget_omitted: 0, filtered_record_count: 0, filtered_edge_count: 0,
    collapsed_edge_count: 0, related_kind_count: 0, graph_edge_count: 0, graph_gaps: [], relationship_context_complete: true,
    channels: Object.fromEntries(CHANNELS.map(name => [name, { status: 'ready', candidate_limit_reached: false }])), completeness_guaranteed: false } });
  return { writes, memory: {
    async searchCompact() { return surface(); },
    async fetchCompact(_scope, _trigger, handle) {
      const row = records[Number(handle.replace('record-', ''))];
      if (!row) throw fail('handle_not_offered');
      return { record: { id: row.id, kind: row.kind, text: row.text }, evidence: [{ role: 'user', text: row.text }], relations: [], immediate_relations_complete: true };
    },
    async releaseCompact() {},
    async enrich(_scope, payload) { writes.push(...payload.records.map(row => ({ kind: row.kind }))); return { records: payload.records.map(row => row.id), relations: [] }; },
    async beginOutcome(_scope, _trigger, outcome, action) { pending = [action, outcome].filter(Boolean); return { token: 'calibration', proposal: { requires_review: false } }; },
    async applyOutcome() { writes.push(...pending.map(row => ({ kind: row.kind }))); return { status: 'written', records: pending.map(row => row.id) }; },
    async cancelOutcome() { pending = null; },
  } };
}

export function scoreCalibration(cases, outcomes) {
  const rows = cases.map(row => {
    const outcome = outcomes.find(item => item.id === row.id);
    if (row.expected_action === 'uncertain') return { id: row.id, expected: row.expected_action, status: 'not_model_assessable' };
    if (!outcome || outcome.error) return { id: row.id, expected: row.expected_action, status: 'unavailable', error: outcome?.error ?? 'not_run' };
    const action = outcome.writes.length ? 'write' : 'abstain';
    return { id: row.id, expected: row.expected_action, action, kinds: outcome.writes.map(item => item.kind), pass: action === row.expected_action };
  });
  const assessed = rows.filter(row => 'pass' in row);
  return { rows, passed: assessed.filter(row => row.pass).length, assessed: assessed.length,
    writes_on_must_abstain: assessed.filter(row => row.expected === 'abstain' && row.action === 'write').map(row => row.id) };
}

async function main() {
  const [label, outDir, sdkIndex, sdkSha] = process.argv.slice(2);
  if (process.argv.length !== 6 || !['baseline', 'T1'].includes(label)) throw fail('arguments_invalid');
  privateDir(outDir);
  const guidance = label === 'T1' ? TREATMENTS.T1.guidance : null;
  const calibration = fictionalCalibrationV2();
  const attestationBytes = readPinned(process.env.PILOT_PRIOR_ATTESTATION, process.env.PILOT_PRIOR_ATTESTATION_SHA256, 1_000_000);
  const attestation = JSON.parse(attestationBytes);
  const prior = attestedPriorSpend(attestation, attestation.ledgers.map(row => readPinned(row.path, row.sha256).toString('utf8')));
  const remaining = WORKER_SHARE_NANO - BigInt(prior.totalNano);
  if (remaining <= 0n) throw fail('soft_cap_exhausted');
  readPinned(sdkIndex, sdkSha, 5_000_000);
  const pi = await import(pathToFileURL(sdkIndex).href), { runtime, model, reviewerModel } = await resolvePiModels({ pi, modelId: ROUTE, reviewerId: ROUTE });
  if (`${model.provider}/${model.id}` !== ROUTE) throw fail('route_changed');
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw fail('working_tree_dirty');
  const spec = { schema: 'calibration-run-seal/v1', codeSha, label, guidance, calibrationSha256: calibration.sha256, policySha256: retentionPolicy().sha256,
    route: ROUTE, priorSpendNano: prior.totalNano, capNano: remaining.toString() };
  const digest = hash(spec), dir = mkdtempSync(join(outDir, `calibration-${label}-`)), runId = randomUUID();
  writeNew(join(dir, 'seal.json'), JSON.stringify({ spec, digest }));
  const rates = { maxOutputTokens: 4096, ratesNanoPerToken: { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500 }, rateEvidence: 'Haiku SDK max tier as sealed in pilot plans' };
  const soft = createSoftBudget({ path: join(dir, 'ledger.jsonl'), capNano: remaining.toString(), sessionKey: `calibration-${runId}`, sealSha256: digest, routes: { [ROUTE]: rates } });
  const outcomes = [];
  try {
    for (const item of calibration.value.cases.filter(row => row.expected_action !== 'uncertain')) {
      const caseDir = mkdtempSync(join(dir, `${item.id}-`)), source = join(caseDir, 'source.jsonl'), text = `[Fictional calibration] ${item.context}`;
      writeFileSync(source, [{ type: 'session', version: 3, id: `calibration-${item.id}` },
        { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: text } },
        { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }], stopReason: 'stop' } }]
        .map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
      const incremental = await createIncrementalSession({ source, workDir: caseDir, sessionId: `calibration-${item.id}` });
      const budget = createInputBudget(2_000_000), fake = calibrationMemory(item.accessible_prior);
      const metered = soft.wrap(boundPiRuntime(runtime, budget), () => ({ purpose: 'candidate', arm: label, checkpoint: item.id,
        task_version: 'calibration-r2-v2', policy_version: retentionPolicy().value.id }));
      try {
        const distiller = await createPiDistiller({ pi, incremental, workDir: caseDir, model, modelRuntime: metered, memory: fake.memory, scope: 'calibration',
          budget, guidance, createOptions: { thinkingLevel: 'low' } });
        const result = await distiller.run({ throughEntryId: 'a1', receipt: { id: `turn-${item.id}` },
          turn: { turn_id: item.id, entries: [{ id: 'u1', role: 'user', text }, { id: 'a1', role: 'assistant', text: 'Noted.' }] } });
        outcomes.push({ id: item.id, disposition: result.disposition, writes: fake.writes });
      } catch (error) {
        outcomes.push({ id: item.id, error: error?.code ?? 'distillation_failed', writes: fake.writes });
        if (soft.state().stopped) break;
      }
    }
  } finally { soft.close(); }
  const summary = scoreCalibration(calibration.value.cases, outcomes);
  const ledgerBytes = readFileSync(join(dir, 'ledger.jsonl'));
  const report = { schema: 'calibration-run/v1', label, seal_sha256: digest, calibration_sha256: calibration.sha256, code_sha: codeSha, guidance,
    summary, spent_nano: soft.state().spent_nano, ledger: { path: join(dir, 'ledger.jsonl'), sha256: sha(ledgerBytes) },
    limitation: 'Fictional single-turn cases against an in-memory store; a write is any derived record; disposition quality beyond write/abstain is not judged.' };
  writeNew(join(dir, 'CALIBRATION-RESULT.json'), JSON.stringify(report));
  process.stdout.write(`${JSON.stringify({ dir, passed: summary.passed, assessed: summary.assessed, writes_on_must_abstain: summary.writes_on_must_abstain,
    spent_nano: report.spent_nano, ledger_sha256: report.ledger.sha256 })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'calibration_failed' })}\n`); process.exitCode = 1; });
}
