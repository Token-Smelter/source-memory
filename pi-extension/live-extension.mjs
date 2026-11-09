import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest } from '../src/core.mjs';
import { boundPiRuntime } from './budget.mjs';
import { createCoverageJournal } from './coverage.mjs';
import { createCursorStore } from './cursor-store.mjs';
import { createIncrementalSession } from './incremental.mjs';
import { ensureIndexed } from './index-readiness.mjs';
import { createDailyInputBudget, createLiveGate, createUsageLedger } from './live-gate.mjs';
import { createLiveController, registerLiveMemory } from './live.mjs';
import { createMemoryClient } from './memory-client.mjs';
import { createPiDistiller } from './pi-runtime.mjs';
import { createPiReviewer } from './reviewer.mjs';
import { resolvePiModels } from './slice-runtime.mjs';

const fail = code => Object.assign(new Error(code), { code });
const safeCode = error => typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'operation_failed';
const serveFile = fileURLToPath(new URL('./serve.mjs', import.meta.url));
export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'source-memory', 'pi-live.json');

const absolute = value => typeof value === 'string' && isAbsolute(value);
const positive = (value, fallback) => value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : NaN;
const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Strict live configuration; anything unexpected disables the extension rather than guessing. */
export function parseLiveConfig(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) throw fail('live_config_invalid');
  const { scope, state_dir: stateDir, memory = {}, distiller = {}, budget = {} } = value;
  const config = {
    enabled: value.enabled !== false,
    scope, stateDir,
    memory: { config: memory.config, node: memory.node ?? null, timeoutMs: positive(memory.timeout_ms, 120000), indexTimeoutMs: positive(memory.index_timeout_ms, 300000) },
    distiller: { model: distiller.model, reviewer: distiller.reviewer ?? distiller.model, thinking: distiller.thinking ?? 'low',
      reviewerThinking: distiller.reviewer_thinking ?? distiller.thinking ?? 'low' },
    budget: { inputTokensPerDay: positive(budget.input_tokens_per_day, NaN), maxIntervalsPerDay: budget.max_intervals_per_day ?? null,
      minRemainingTokens: budget.min_remaining_tokens ?? 0 },
    maxRetries: value.max_retries ?? 3,
    shutdownGraceMs: positive(value.shutdown_grace_ms, 5000),
    piSdk: value.pi_sdk ?? null,
  };
  if (typeof scope !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(scope) || !absolute(stateDir) || !absolute(config.memory.config)
    || (config.memory.node !== null && !absolute(config.memory.node))
    || [config.memory.timeoutMs, config.memory.indexTimeoutMs, config.budget.inputTokensPerDay, config.shutdownGraceMs].some(Number.isNaN)
    || typeof config.distiller.model !== 'string' || !config.distiller.model.includes('/') || typeof config.distiller.reviewer !== 'string'
    || ![config.distiller.thinking, config.distiller.reviewerThinking].every(level => thinking.includes(level))
    || (config.budget.maxIntervalsPerDay !== null && (!Number.isSafeInteger(config.budget.maxIntervalsPerDay) || config.budget.maxIntervalsPerDay < 1))
    || !Number.isSafeInteger(config.budget.minRemainingTokens) || config.budget.minRemainingTokens < 0
    || !Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || (config.piSdk !== null && !absolute(config.piSdk))) throw fail('live_config_invalid');
  return config;
}

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = statSync(path);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw fail('state_dir_invalid');
  return realpathSync(path);
}

/** Resolve the Pi SDK: explicit path, PI_SDK_MODULE, the running Pi package, then normal package resolution. */
export async function loadPiSdk(explicit) {
  const candidates = [explicit, process.env.PI_SDK_MODULE];
  try {
    for (let dir = dirname(realpathSync(process.argv[1] ?? '')); dir !== dirname(dir); dir = dirname(dir)) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@earendil-works/pi-coding-agent') { candidates.push(join(dir, 'dist', 'index.js')); break; }
    }
  } catch {}
  for (const path of candidates.filter(Boolean)) if (existsSync(path)) return import(pathToFileURL(path).href);
  try { return await import('@earendil-works/pi-coding-agent'); } catch { throw fail('pi_sdk_unavailable'); }
}

/** One long-lived scoped Memory subprocess speaking NDJSON over its stdio. */
export function spawnMemoryProcess({ node, configPath, scope, intentDir, timeoutMs, indexTimeoutMs }) {
  const program = node ?? (basename(process.execPath).startsWith('node') ? process.execPath : 'node');
  const child = spawn(program, [serveFile, '--config', configPath, '--scope', scope, '--intent-dir', intentDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  // A dead child must never surface as an unhandled stream error in the host process.
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {});
  child.stderr.resume();
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const memory = createMemoryClient({ input: child.stdout, output: child.stdin, timeoutMs, indexTimeoutMs });
  void exited.then(() => memory.close());
  return { memory, async close() {
    memory.close();
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  } };
}

/** Assemble per-session controllers for one extension instance from a parsed configuration. */
export async function createLiveRuntime({ config, sdk, resolveModels = resolvePiModels, spawnMemory = spawnMemoryProcess, now } = {}) {
  const stateDir = privateDir(config.stateDir);
  const memoryConfig = JSON.parse(readFileSync(config.memory.config, 'utf8'));
  const ledger = createUsageLedger({ directory: stateDir, ...(now ? { now } : {}) });
  const budget = createDailyInputBudget({ ledger, limit: config.budget.inputTokensPerDay });
  const gate = createLiveGate({ scope: config.scope, grants: memoryConfig.scopes, budget, ledger,
    maxIntervalsPerDay: config.budget.maxIntervalsPerDay, minRemaining: config.budget.minRemainingTokens });
  const models = await resolveModels({ pi: sdk, modelId: config.distiller.model, reviewerId: config.distiller.reviewer });
  const controllers = new Map();
  const readiness = (client, scope, state, options = {}) => ensureIndexed(client, scope, state, { waitForVectors: true, batchLimit: 16, ...options });

  async function openSession(journal, sessionId, sessionFile, dir) {
    const intentDir = privateDir(join(dir, 'intents')), workDir = privateDir(join(dir, 'work'));
    const child = spawnMemory({ node: config.memory.node, configPath: config.memory.config, scope: config.scope, intentDir,
      timeoutMs: config.memory.timeoutMs, indexTimeoutMs: config.memory.indexTimeoutMs });
    let incremental;
    const close = async () => {
      try { if (incremental) unlinkSync(incremental.file); } catch {}
      await child.close();
    };
    try {
      await child.memory.init(config.scope);
      const memory = journal.track(child.memory);
      incremental = await createIncrementalSession({ source: sessionFile, workDir });
      const runtime = boundPiRuntime(models.runtime, budget);
      const reviewer = createPiReviewer({ pi: sdk, workDir, model: models.reviewerModel, modelRuntime: runtime, budget, thinkingLevel: config.distiller.reviewerThinking });
      const distiller = await createPiDistiller({ pi: sdk, incremental, workDir, model: models.model, modelRuntime: runtime, memory, scope: config.scope,
        reviewer, budget, ensureIndexed: readiness, createOptions: { thinkingLevel: config.distiller.thinking } });
      return { conversation_id: sessionId, scopes: [config.scope], memory, distiller, budget, ensureIndexed: readiness, close };
    } catch (error) { await close(); throw error; }
  }

  return {
    budget,
    controllerFor({ sessionId, sessionFile }) {
      if (typeof sessionId !== 'string' || !sessionId || typeof sessionFile !== 'string' || !sessionFile) return null;
      let entry = controllers.get(sessionId);
      if (!entry) {
        const dir = privateDir(join(stateDir, 'sessions', digest(['pi-live-session/v1', sessionId]).slice(0, 32)));
        const journal = createCoverageJournal({ directory: dir, sessionKey: sessionId, effectIds: true, pidLock: true });
        const controller = createLiveController({ journal, cursorStore: createCursorStore({ directory: dir, sessionKey: sessionId }),
          conversationId: sessionId, maxRetries: config.maxRetries, gate, open: () => openSession(journal, sessionId, sessionFile, dir) });
        entry = { controller, journal, sessionFile };
        controllers.set(sessionId, entry);
      }
      if (entry.sessionFile !== sessionFile) throw fail('session_file_changed');
      return entry.controller;
    },
    async close() {
      for (const { controller, journal } of controllers.values()) {
        try { await controller.close(); } catch {}
        try { journal.close(); } catch {}
      }
      controllers.clear();
      try { ledger.close(); } catch {}
    },
  };
}

/**
 * Pi extension factory. Distillation runs after agent_settled in the background; every failure is logged and shown as a
 * status, and none propagates into the host session. A missing configuration file leaves the extension inactive.
 */
export function createLiveExtension({ configPath = process.env.SOURCE_MEMORY_PI_LIVE_CONFIG || DEFAULT_CONFIG_PATH, loadSdk = loadPiSdk,
  resolveModels, spawnMemory, now, onResult = () => {}, onError = () => {} } = {}) {
  return function sourceMemoryLive(pi) {
    let config = null, runtime = null, starting = null, disabled = null, ui = null;
    const status = text => { try { ui?.setStatus?.('source-memory', text); } catch {} };
    const log = event => {
      if (!config) return;
      try { appendFileSync(join(config.stateDir, 'live.log'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 }); } catch {}
    };
    const report = error => {
      const code = safeCode(error);
      log({ event: 'error', code });
      status(`memory: ${code}`);
      try { onError(error); } catch {}
    };
    const ensure = async () => {
      if (disabled) return null;
      if (runtime) return runtime;
      starting ??= (async () => {
        if (!existsSync(configPath)) { disabled = 'unconfigured'; return null; }
        config = parseLiveConfig(JSON.parse(readFileSync(configPath, 'utf8')));
        if (!config.enabled) { disabled = 'disabled'; return null; }
        privateDir(config.stateDir);
        const sdk = await loadSdk(config.piSdk);
        runtime = await createLiveRuntime({ config, sdk, ...(resolveModels ? { resolveModels } : {}), ...(spawnMemory ? { spawnMemory } : {}), ...(now ? { now } : {}) });
        log({ event: 'started', scope: config.scope });
        return runtime;
      })().catch(error => { disabled = safeCode(error); throw error; });
      return starting;
    };
    try {
      pi.on('session_start', (_event, ctx) => { ui = ctx?.ui ?? null; });
      const hook = registerLiveMemory(pi, {
        controllerFor: async snapshot => (await ensure())?.controllerFor(snapshot) ?? null,
        onResult(result, snapshot) {
          log({ event: 'settle', status: result.status, code: result.code ?? result.results?.at(-1)?.code ?? null,
            dispositions: result.results?.map(row => row.disposition ?? (row.refused ? 'refused' : null)) ?? [] });
          status(`memory: ${result.status}`);
          try { onResult(result, snapshot); } catch {}
        },
        onError: report,
      });
      pi.on('session_shutdown', async () => {
        try {
          let timer;
          await Promise.race([hook.drain(), new Promise(resolve => { timer = setTimeout(resolve, config?.shutdownGraceMs ?? 5000); })]);
          clearTimeout(timer);
        } catch {}
        try { await runtime?.close(); } catch {}
        runtime = null; starting = null;
      });
    } catch (error) { report(error); }
  };
}

export default createLiveExtension();
