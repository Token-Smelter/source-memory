import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
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
const safeCode = error => {
  const code = error?.code;
  if (typeof code === 'string' && /^E[A-Z]{2,20}$/.test(code)) return `fs_${code.toLowerCase()}`;
  return typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? code : 'operation_failed';
};
const serveFile = fileURLToPath(new URL('./serve.mjs', import.meta.url));
export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'source-memory', 'pi-live.json');

const MODES = ['tui', 'rpc', 'json', 'print'];
const WRITES = new Set(['ingest', 'enrich', 'beginLinks', 'applyLinks', 'beginOutcome', 'applyOutcome', 'index']);
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const KEYS = {
  root: ['version', 'enabled', 'scope', 'state_dir', 'memory', 'distiller', 'budget', 'max_retries', 'shutdown_grace_ms', 'pi_sdk', 'modes', 'backfill'],
  memory: ['config', 'node', 'timeout_ms', 'index_timeout_ms'],
  distiller: ['model', 'reviewer', 'thinking', 'reviewer_thinking'],
  budget: ['input_tokens_per_day', 'max_intervals_per_day', 'min_remaining_tokens'],
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const absolute = value => typeof value === 'string' && isAbsolute(value);
const bounded = (value, fallback, max) => value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 && value <= max ? value : NaN;
const route = value => typeof value === 'string' && /^[^/\s]+\/[^\s]+$/.test(value);

/** Strict live configuration: unknown keys, wrong types and out-of-range values refuse rather than fall back. */
export function parseLiveConfig(value) {
  if (!only(value, KEYS.root) || value.version !== 1) throw fail('live_config_invalid');
  const { memory = {}, distiller = {}, budget = {} } = value;
  if (!only(memory, KEYS.memory) || !only(distiller, KEYS.distiller) || !only(budget, KEYS.budget)
    || [value, memory, distiller, budget].some(section => Object.values(section).includes(null))) throw fail('live_config_invalid');
  const config = {
    enabled: value.enabled ?? true,
    scope: value.scope,
    stateDir: value.state_dir,
    memory: { config: memory.config, node: memory.node ?? null, timeoutMs: bounded(memory.timeout_ms, 120000, 3_600_000),
      indexTimeoutMs: bounded(memory.index_timeout_ms, 300000, 3_600_000) },
    distiller: { model: distiller.model, reviewer: distiller.reviewer ?? distiller.model, thinking: distiller.thinking ?? 'low',
      reviewerThinking: distiller.reviewer_thinking ?? distiller.thinking ?? 'low' },
    budget: { inputTokensPerDay: bounded(budget.input_tokens_per_day, NaN, Number.MAX_SAFE_INTEGER), maxIntervalsPerDay: budget.max_intervals_per_day ?? null,
      minRemainingTokens: budget.min_remaining_tokens ?? 0 },
    maxRetries: value.max_retries ?? 3,
    shutdownGraceMs: bounded(value.shutdown_grace_ms, 5000, 30000),
    piSdk: value.pi_sdk ?? null,
    modes: value.modes ?? ['tui'],
    backfill: value.backfill ?? false,
  };
  if (typeof config.enabled !== 'boolean' || typeof config.backfill !== 'boolean'
    || typeof config.scope !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.scope) || !absolute(config.stateDir) || !absolute(config.memory.config)
    || (config.memory.node !== null && !absolute(config.memory.node))
    || [config.memory.timeoutMs, config.memory.indexTimeoutMs, config.budget.inputTokensPerDay, config.shutdownGraceMs].some(Number.isNaN)
    || !route(config.distiller.model) || !route(config.distiller.reviewer)
    || ![config.distiller.thinking, config.distiller.reviewerThinking].every(level => THINKING.includes(level))
    || (config.budget.maxIntervalsPerDay !== null && (!Number.isSafeInteger(config.budget.maxIntervalsPerDay) || config.budget.maxIntervalsPerDay < 1))
    || !Number.isSafeInteger(config.budget.minRemainingTokens) || config.budget.minRemainingTokens < 0
    || !Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 10 || (config.piSdk !== null && !absolute(config.piSdk))
    || !Array.isArray(config.modes) || !config.modes.length || config.modes.some(mode => !MODES.includes(mode))) throw fail('live_config_invalid');
  return config;
}

/** The configuration names an executable and a module, so it must be the user's own file and not writable by others. */
export function readLiveConfig(path) {
  return parseLiveConfig(readOwnJson(path, 'live_config'));
}

/** A JSON file that steers execution or where source text goes must be the user's own and not writable by others. */
function readOwnJson(path, label) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw fail(`${label}_unsafe`); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0) throw fail(`${label}_unsafe`);
    try { return JSON.parse(readFileSync(fd, 'utf8')); } catch { throw fail(`${label}_invalid`); }
  } finally { closeSync(fd); }
}

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = statSync(path);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw fail('state_dir_invalid');
  return realpathSync(path);
}

/** Resolve the Pi SDK: explicit path, PI_SDK_MODULE, the running Pi package (its bundle when Pi runs from it), then normal resolution. */
export async function loadPiSdk(explicit) {
  const candidates = [explicit, process.env.PI_SDK_MODULE];
  try {
    const entry = realpathSync(process.argv[1] ?? '');
    for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).name !== '@earendil-works/pi-coding-agent') continue;
      // The CLI runs from dist/bundle; its index shares the loaded chunks instead of importing a second SDK copy.
      if (entry.startsWith(join(dir, 'dist', 'bundle') + sep)) candidates.push(join(dir, 'dist', 'bundle', 'index.js'));
      candidates.push(join(dir, 'dist', 'index.js'));
      break;
    }
  } catch {}
  for (const path of candidates.filter(Boolean)) if (existsSync(path)) return import(pathToFileURL(path).href);
  try { return await import('@earendil-works/pi-coding-agent'); } catch { throw fail('pi_sdk_unavailable'); }
}

/** One long-lived scoped Memory subprocess speaking NDJSON over its stdio. */
export function spawnMemoryProcess({ node, configPath, scope, intentDir, timeoutMs, indexTimeoutMs }) {
  const program = node ?? (basename(process.execPath).startsWith('node') ? process.execPath : 'node');
  const child = spawn(program, [serveFile, '--config', configPath, '--scope', scope, '--intent-dir', intentDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  // A dead child must never surface as an unhandled stream or process error in the host.
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {});
  let lastCode = null, stderrTail = '';
  child.on('error', error => { lastCode = safeCode(error); });
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
    const match = stderrTail.match(/"code":"([a-zA-Z_]{1,80})"/g);
    if (match) lastCode = safeCode({ code: match.at(-1).slice(8, -1) });
  });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const memory = createMemoryClient({ input: child.stdout, output: child.stdin, timeoutMs, indexTimeoutMs });
  void exited.then(() => memory.close());
  return { memory, exitCode: () => lastCode, async close() {
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
  const memoryConfig = readOwnJson(config.memory.config, 'memory_config');
  const models = await resolveModels({ pi: sdk, modelId: config.distiller.model, reviewerId: config.distiller.reviewer });
  const ledger = createUsageLedger({ directory: stateDir, ...(now ? { now } : {}) });
  let budget, gate;
  try {
    budget = createDailyInputBudget({ ledger, limit: config.budget.inputTokensPerDay });
    gate = createLiveGate({ scope: config.scope, grants: memoryConfig.scopes, budget, ledger,
      maxIntervalsPerDay: config.budget.maxIntervalsPerDay, minRemaining: config.budget.minRemainingTokens });
  } catch (error) { ledger.close(); throw error; }
  const controllers = new Map();
  let closed = false;
  const readiness = (client, scope, state, options = {}) => ensureIndexed(client, scope, state, { waitForVectors: true, batchLimit: 16, ...options });

  async function openSession(journal, sessionId, sessionFile, dir) {
    const intentDir = privateDir(join(dir, 'intents')), workDir = privateDir(join(dir, 'work'));
    // Private session copies left by a crash are never reused; this session holds the journal lock, so none is in use.
    for (const name of readdirSync(workDir)) if (/^(pi-memory-.*\.jsonl|\.pi-memory-.*\.tmp)$/.test(name)) { try { unlinkSync(join(workDir, name)); } catch {} }
    const child = spawnMemory({ node: config.memory.node, configPath: config.memory.config, scope: config.scope, intentDir,
      timeoutMs: config.memory.timeoutMs, indexTimeoutMs: config.memory.indexTimeoutMs });
    let incremental, stopped = false;
    const close = async () => {
      await child.close();
      try { if (incremental) unlinkSync(incremental.file); } catch {}
    };
    try {
      await child.memory.init(config.scope);
      // Once stopped, a write is refused before it is sent, so the journal records it as refused rather than unknown.
      const guarded = new Proxy(child.memory, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (stopped && WRITES.has(key)) return async () => { throw Object.assign(fail('controller_closed'), { effect: 'refused' }); };
        return value.bind(target);
      } });
      const memory = journal.track(guarded);
      incremental = await createIncrementalSession({ source: sessionFile, workDir });
      const runtime = boundPiRuntime(models.runtime, budget);
      const reviewer = createPiReviewer({ pi: sdk, workDir, model: models.reviewerModel, modelRuntime: runtime, budget, thinkingLevel: config.distiller.reviewerThinking });
      const distiller = await createPiDistiller({ pi: sdk, incremental, workDir, model: models.model, modelRuntime: runtime, memory, scope: config.scope,
        reviewer, budget, ensureIndexed: readiness, createOptions: { thinkingLevel: config.distiller.thinking } });
      return { conversation_id: sessionId, scopes: [config.scope], memory, distiller, budget, ensureIndexed: readiness, close,
        stop() { stopped = true; budget.stop(); } };
    } catch (error) {
      const code = error?.code === 'transport_closed' ? child.exitCode?.() : null;
      await close();
      throw code ? Object.assign(fail(code), { cause: error }) : error;
    }
  }

  return {
    budget,
    gate,
    controllerFor({ sessionId, sessionFile }, { baseline = null } = {}) {
      if (closed || typeof sessionId !== 'string' || !sessionId || typeof sessionFile !== 'string' || !sessionFile) return null;
      let entry = controllers.get(sessionId);
      if (!entry) {
        const dir = join(stateDir, 'sessions', digest(['pi-live-session/v1', sessionId]).slice(0, 32));
        privateDir(dir);
        const journal = createCoverageJournal({ directory: dir, sessionKey: sessionId, effectIds: true, pidLock: true });
        const cursorStore = createCursorStore({ directory: dir, sessionKey: sessionId });
        // First seen means no durable coverage state yet, not merely a missing directory.
        const fresh = !journal.intervals().length && journal.state().status === 'ready' && cursorStore.load() === null;
        const controller = createLiveController({ journal, cursorStore,
          conversationId: sessionId, sessionId, maxRetries: config.maxRetries, gate, baseline: fresh && !config.backfill ? baseline : null,
          open: () => openSession(journal, sessionId, sessionFile, dir) });
        entry = { controller, journal, sessionFile };
        controllers.set(sessionId, entry);
      }
      if (entry.sessionFile !== sessionFile) throw fail('session_file_changed');
      return entry.controller;
    },
    /** Stop every controller within the grace, then close journals (releasing their locks) and the ledger last. */
    async close() {
      closed = true;
      budget.stop();
      await Promise.all([...controllers.values()].map(async ({ controller, journal }) => {
        try { await controller.close({ graceMs: config.shutdownGraceMs }); } catch {}
        try { journal.close(); } catch {}
      }));
      controllers.clear();
      try { ledger.close(); } catch {}
    },
  };
}

/**
 * Pi extension factory. Distillation runs after agent_settled in the background; every failure is logged and shown as a
 * status, and none propagates into the host session. A missing configuration file leaves the extension inactive, and only
 * the configured run modes (default: the interactive TUI) are processed.
 */
export function createLiveExtension({ configPath = process.env.SOURCE_MEMORY_PI_LIVE_CONFIG || DEFAULT_CONFIG_PATH, loadSdk = loadPiSdk,
  resolveModels, spawnMemory, now, onResult = () => {}, onError = () => {} } = {}) {
  return function sourceMemoryLive(pi) {
    let config = null, logDir = null, runtime = null, starting = null, disabled = null, closed = false;
    let ui = null, mode = null, baseline = null;
    // After shutdown the footer and host callbacks belong to the next session; late results are only logged.
    const status = text => { if (closed) return; try { ui?.setStatus?.('source-memory', text); } catch {} };
    const log = event => {
      if (!logDir) return;
      try { appendFileSync(join(logDir, 'live.log'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 }); } catch {}
    };
    const report = error => {
      const code = safeCode(error);
      log({ event: 'error', code });
      status(`memory: ${code}`);
      if (closed) return;
      try { onError(Object.assign(error ?? fail(code), { code })); } catch {}
    };
    const ensure = async () => {
      if (disabled || closed) return null;
      if (runtime) return runtime;
      starting ??= (async () => {
        if (!existsSync(configPath)) { disabled = 'unconfigured'; return null; }
        config = readLiveConfig(configPath);
        if (!config.enabled) { disabled = 'disabled'; return null; }
        privateDir(config.stateDir);
        logDir = config.stateDir;
        if (!config.modes.includes(mode)) { disabled = 'mode_not_enabled'; log({ event: 'inactive', mode }); return null; }
        const sdk = await loadSdk(config.piSdk);
        const built = await createLiveRuntime({ config, sdk, ...(resolveModels ? { resolveModels } : {}), ...(spawnMemory ? { spawnMemory } : {}), ...(now ? { now } : {}) });
        if (closed) { await built.close(); return null; }
        runtime = built;
        log({ event: 'started', scope: config.scope, mode });
        return runtime;
      })().catch(error => { disabled = safeCode(error); throw error; });
      return starting;
    };
    try {
      pi.on('session_start', (_event, ctx) => {
        try {
          ui = ctx?.ui ?? null;
          mode = ctx?.mode ?? null;
          baseline = ctx?.sessionManager?.getLeafId?.() ?? null;
        } catch {}
      });
      const hook = registerLiveMemory(pi, {
        active: ctx => !closed && !disabled && Boolean(ctx?.sessionManager?.getSessionFile?.()) && (runtime !== null || starting !== null || existsSync(configPath)),
        controllerFor: async snapshot => {
          if (closed || !snapshot.sessionFile) return null;
          return (await ensure())?.controllerFor(snapshot, { baseline }) ?? null;
        },
        onResult(result, snapshot) {
          log({ event: 'settle', status: result.status, code: result.code ?? result.results?.at(-1)?.code ?? null,
            dispositions: result.results?.map(row => row.disposition ?? (row.refused ? 'refused' : null)) ?? [] });
          status(`memory: ${result.status}`);
          if (!closed) { try { onResult(result, snapshot); } catch {} }
        },
        onError: report,
      });
      pi.on('session_shutdown', async () => {
        // Closed first: queued settles and a runtime that finishes starting afterwards are refused or closed, never run.
        closed = true;
        try { await (runtime ?? (await starting?.catch(() => null)))?.close(); } catch {}
        runtime = null;
        try {
          let timer;
          await Promise.race([hook.drain(), new Promise(resolve => { timer = setTimeout(resolve, config?.shutdownGraceMs ?? 5000); })]);
          clearTimeout(timer);
        } catch {}
      });
    } catch (error) { report(error); }
  };
}

export default createLiveExtension();
