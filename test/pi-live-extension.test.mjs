import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compactResult } from './helpers/compact-fixture.mjs';
import { distillerRuntime, fakeModels, hostSession, scriptedRuntime } from './helpers/fake-pi.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'pi-live-extension-'));
chmodSync(scratch, 0o700);
// The default export reads this at import; it must never see an operator's real configuration.
process.env.SOURCE_MEMORY_PI_LIVE_CONFIG = join(scratch, 'absent.json');
const { createLiveExtension, parseLiveConfig, readLiveConfig } = await import('../pi-extension/live-extension.mjs');
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const sdkPath = process.env.PI_SDK_MODULE;
const loadPi = () => import(pathToFileURL(sdkPath).href);
const waitFor = async (predicate, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('wait_timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

function layout(name) {
  const root = join(scratch, name);
  for (const dir of ['', 'agent', 'sessions', 'state']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const memoryConfig = join(root, 'memory.json');
  writeFileSync(memoryConfig, JSON.stringify({ neo4j: { uri: 'bolt://127.0.0.1:1', auth: 'none' }, scopes: { read: ['fiction'], write: ['fiction'] } }), { mode: 0o600 });
  const configPath = join(root, 'live.json');
  const config = { version: 1, scope: 'fiction', state_dir: join(root, 'state'), memory: { config: memoryConfig },
    distiller: { model: 'fiction/model' }, budget: { input_tokens_per_day: 1000000 } };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { root, configPath, config, cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions') };
}

/** Fictional Memory client with the store's identity rules: a turn ID or record ID written twice is a replay. */
function fakeMemory() {
  const store = { turns: new Map(), records: new Map(), ingests: [], spawned: 0, closed: 0 };
  const memory = {
    async init() { return { initialized: true }; },
    async ingest(_scope, turn) {
      store.ingests.push(turn.entries.map(row => row.id));
      const replayed = store.turns.has(turn.turn_id);
      if (!replayed) store.turns.set(turn.turn_id, turn);
      return { id: `turn-${turn.turn_id}`, replayed, indexing: { status: 'ready' } };
    },
    async status() { return { unindexed: 0, vector_indexes: { chunk: 'online', record: 'online' } }; },
    async turnVectorStatus() { return { visible: true }; },
    async recordVectorStatus() { return { visible: true }; },
    async searchCompact() { return compactResult(); },
    async releaseCompact() { return { released: true }; },
    async enrich(_scope, payload) { for (const row of payload.records) store.records.set(row.id, row); return { records: payload.records.map(row => row.id), indexing: { status: 'ready' } }; },
    async recordPresence(_scope, ids) { return { present: ids.filter(id => store.records.has(id)), absent: ids.filter(id => !store.records.has(id)) }; },
  };
  return { store, spawnMemory: () => { store.spawned++; return { memory, async close() { store.closed++; } }; } };
}

test('a strict configuration refuses relative paths, unknown thinking levels and missing budgets', () => {
  const base = { version: 1, scope: 'fiction', state_dir: '/fiction/state', memory: { config: '/fiction/memory.json' },
    distiller: { model: 'fiction/model' }, budget: { input_tokens_per_day: 10 } };
  assert.equal(parseLiveConfig(base).distiller.reviewer, 'fiction/model');
  for (const broken of [{ ...base, state_dir: 'state' }, { ...base, distiller: { model: 'fiction/model', thinking: 'max' } }, { ...base, budget: {} },
    { ...base, scope: 'two scopes' }, { ...base, version: 2 }, { ...base, enabled: 'false' }, { ...base, shutdown_grace: 10 },
    { ...base, budget: { input_tokens_per_day: 10, max_interval_per_day: 1 } }, { ...base, memory: null }, { ...base, shutdown_grace_ms: 60000 },
    { ...base, memory: { config: '/fiction/memory.json', timeout_ms: 4_000_000 } }, { ...base, distiller: { model: 'fiction/model', reviewer: 'model' } },
    { ...base, modes: ['web'] }, { ...base, modes: [] }]) assert.throws(() => parseLiveConfig(broken), /live_config_invalid/, JSON.stringify(broken));
});

test('a configuration file others can write is refused', () => {
  const paths = layout('unsafe');
  chmodSync(paths.configPath, 0o666);
  assert.throws(() => readLiveConfig(paths.configPath), /live_config_unsafe/);
});

test('a real Pi session settles immediately while the extension distills its turns in the background', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('background');
  const { store, spawnMemory } = fakeMemory();
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  const results = [], errors = [];
  const factory = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => pi, spawnMemory,
    resolveModels: fakeModels(distillerRuntime({ before: () => { reached(); return held; } })), onResult: result => results.push(result), onError: error => errors.push(error) });
  const { session, sessionManager } = await hostSession(pi, { ...paths, factories: [factory] });
  await session.prompt('Fictional: please use amber for the dashboard.');
  await started;
  // The distiller is held inside its first model call; the user's next prompt still completes.
  await session.prompt('Fictional: and keep the sidebar narrow.');
  assert.deepEqual([results.length, store.records.size, session.messages.filter(row => row.role === 'assistant').length], [0, 0, 2]);
  release();
  await waitFor(() => results.length === 2);
  const sessions = join(paths.config.state_dir, 'sessions');
  const cursorFile = readdirSync(join(sessions, readdirSync(sessions)[0])).find(name => name.startsWith('cursor-'));
  const cursor = JSON.parse(readFileSync(join(sessions, readdirSync(sessions)[0], cursorFile), 'utf8')).cursor;
  assert.deepEqual([errors, results.map(row => row.status), store.ingests.map(row => row.length), store.records.size, cursor],
    [[], ['covered', 'covered'], [2, 2], 2, sessionManager.getLeafId()]);
  const ledger = readFileSync(join(paths.config.state_dir, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const calls = ledger.filter(row => row.kind === 'call');
  assert.deepEqual([calls.length > 0, calls.every(call => ledger.some(row => row.kind === 'usage' && row.call === call.id && row.input === 10)),
    ledger.filter(row => row.kind === 'interval').length], [true, true, 2]);
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
  assert.equal(store.closed, 1);

  const restarted = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => pi, spawnMemory,
    resolveModels: fakeModels(distillerRuntime()), onResult: result => results.push(result), onError: error => errors.push(error) });
  const resumed = await hostSession(pi, { ...paths, factories: [restarted], sessionFile: sessionManager.getSessionFile() });
  await resumed.session.prompt('Fictional: after a restart, note the narrow footer too.');
  await waitFor(() => results.length === 3);
  assert.deepEqual([errors, results[2].status, store.ingests.map(row => row.length), store.turns.size], [[], 'covered', [2, 2, 2], 3]);
  await resumed.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  resumed.session.dispose();
});

test('a missing configuration leaves the extension inactive and the host session unaffected', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('absent');
  const errors = [];
  const factory = createLiveExtension({ configPath: join(paths.root, 'none.json'), loadSdk: async () => { throw new Error('must not load'); }, onError: error => errors.push(error) });
  const { session } = await hostSession(pi, { ...paths, factories: [factory] });
  await session.prompt('Fictional prompt.');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([errors, session.messages.at(-1).role], [[], 'assistant']);
  session.dispose();
});

test('a broken configuration disables the extension once and never breaks the host session', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('broken');
  writeFileSync(paths.configPath, '{"version":1,"scope":"fiction"}', { mode: 0o600 });
  const errors = [];
  const factory = createLiveExtension({ configPath: paths.configPath, onError: error => errors.push(error.code) });
  const { session } = await hostSession(pi, { ...paths, factories: [factory] });
  await session.prompt('Fictional prompt one.');
  await waitFor(() => errors.length === 1);
  await session.prompt('Fictional prompt two.');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([errors, session.messages.filter(row => row.role === 'assistant').length], [['live_config_invalid'], 2]);
  session.dispose();
});

test('a failing Memory process is reported and the host session continues', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('memory-down');
  const errors = [];
  const factory = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => pi, resolveModels: fakeModels(distillerRuntime()),
    spawnMemory: () => ({ memory: { async init() { throw Object.assign(new Error('down'), { code: 'transport_closed' }); } }, async close() {} }),
    onError: error => errors.push(error.code) });
  const { session } = await hostSession(pi, { ...paths, factories: [factory] });
  await session.prompt('Fictional prompt.');
  await waitFor(() => errors.length === 1);
  assert.deepEqual([errors, session.messages.at(-1).role], [['transport_closed'], 'assistant']);
  session.dispose();
});

test('Pi loads the default export from its file path as an extension', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('file-load');
  const path = fileURLToPath(new URL('../pi-extension/live-extension.mjs', import.meta.url));
  const { session, resourceLoader } = await hostSession(pi, { ...paths, extensionPaths: [path] });
  await session.prompt('Fictional prompt.');
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual([loaded.errors, loaded.extensions.some(row => JSON.stringify(row.path ?? row.resolvedPath ?? '').includes('live-extension.mjs')), session.messages.at(-1).role],
    [[], true, 'assistant']);
  session.dispose();
});

const sessionDirOf = paths => { const root = join(paths.config.state_dir, 'sessions'); return join(root, readdirSync(root)[0]); };
const shutdown = async session => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };

test('shutdown during a held distillation stops it, leaks nothing and the next instance recovers the interval', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('shutdown');
  writeFileSync(paths.configPath, JSON.stringify({ ...paths.config, shutdown_grace_ms: 100 }), { mode: 0o600 });
  const { store, spawnMemory } = fakeMemory();
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  const errors = [];
  const factory = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => pi, spawnMemory,
    resolveModels: fakeModels(distillerRuntime({ before: () => { reached(); return new Promise(() => {}); } })), onError: error => errors.push(error.code) });
  const { session, sessionManager } = await hostSession(pi, { ...paths, factories: [factory] });
  await session.prompt('Fictional: held distillation.');
  await started;
  await session.prompt('Fictional: a queued second turn.');
  await shutdown(session);
  await new Promise(resolve => setTimeout(resolve, 300));
  const dir = sessionDirOf(paths);
  const usage = readFileSync(join(paths.config.state_dir, 'usage.jsonl'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual([store.spawned, store.closed, readdirSync(dir).filter(name => name.endsWith('.lock')), readdirSync(join(dir, 'work')).filter(name => name.endsWith('.jsonl')),
    readFileSync(join(paths.config.state_dir, 'usage.jsonl'), 'utf8') === usage, store.ingests.length], [1, 1, [], [], true, 1]);

  const results = [];
  const next = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => pi, spawnMemory, resolveModels: fakeModels(distillerRuntime()),
    onResult: result => results.push(result), onError: error => errors.push(error.code) });
  const resumed = await hostSession(pi, { ...paths, factories: [next], sessionFile: sessionManager.getSessionFile() });
  await resumed.session.prompt('Fictional: after the restart.');
  await waitFor(() => results.length === 1);
  // The aborted interval is retried under its own turn ID before the new turn; no source is ingested under two IDs.
  assert.deepEqual([results[0].status, results[0].results.map(row => row.disposition), store.turns.size, store.ingests.map(row => row.length)],
    ['covered', ['committed', 'committed'], 2, [2, 2, 4]]);
  await shutdown(resumed.session);
  assert.equal(store.spawned, store.closed);
});

test('a provider that ignores abort cannot write anything after shutdown or reach the host', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('zombie');
  writeFileSync(paths.configPath, JSON.stringify({ ...paths.config, shutdown_grace_ms: 50 }), { mode: 0o600 });
  const { store, spawnMemory } = fakeMemory();
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const stubborn = scriptedRuntime(async context => {
    const results = (context.messages ?? []).filter(row => row.role === 'toolResult').length;
    if (!results) { reached(); await held; return { content: [{ type: 'toolCall', id: 's', name: 'memory_search', arguments: { query: 'fiction', kinds: [] } }], stopReason: 'toolUse' }; }
    return { content: [{ type: 'text', text: '{"result":"done_nothing_qualifies","reason":"Fiction."}' }], stopReason: 'stop' };
  });
  try {
    const factory = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => pi, spawnMemory, resolveModels: fakeModels(stubborn), onError() {} });
    const { session } = await hostSession(pi, { ...paths, factories: [factory] });
    await session.prompt('Fictional: a provider that never stops.');
    await started;
    await shutdown(session);
    const journalDir = sessionDirOf(paths);
    const before = [readFileSync(join(paths.config.state_dir, 'usage.jsonl'), 'utf8'),
      readFileSync(join(journalDir, readdirSync(journalDir).find(name => name.endsWith('.jsonl'))), 'utf8')];
    release();
    await new Promise(resolve => setTimeout(resolve, 200));
    const after = [readFileSync(join(paths.config.state_dir, 'usage.jsonl'), 'utf8'),
      readFileSync(join(journalDir, readdirSync(journalDir).find(name => name.endsWith('.jsonl'))), 'utf8')];
    assert.deepEqual([after, unhandled, store.spawned === store.closed, readdirSync(journalDir).filter(name => name.endsWith('.lock'))], [before, [], true, []]);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('a session first seen with history starts after it, unless backfill is configured', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  for (const backfill of [false, true]) {
    const paths = layout(`history-${backfill}`);
    writeFileSync(paths.configPath, JSON.stringify({ ...paths.config, backfill }), { mode: 0o600 });
    const plain = await hostSession(pi, paths);
    await plain.session.prompt('Fictional history one.');
    await plain.session.prompt('Fictional history two.');
    plain.session.dispose();
    const { store, spawnMemory } = fakeMemory();
    const results = [];
    const factory = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => pi, spawnMemory, resolveModels: fakeModels(distillerRuntime()),
      onResult: result => results.push(result) });
    const resumed = await hostSession(pi, { ...paths, factories: [factory], sessionFile: plain.sessionManager.getSessionFile() });
    await resumed.session.prompt('Fictional turn after resuming.');
    await waitFor(() => results.length === 1);
    assert.deepEqual([backfill, results[0].status, store.ingests.map(row => row.length)], [backfill, 'covered', [backfill ? 6 : 2]]);
    await shutdown(resumed.session);
  }
});

test('only the configured run modes are processed', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('modes');
  const { store, spawnMemory } = fakeMemory();
  let loaded = 0;
  const factory = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => { loaded++; return pi; }, spawnMemory, resolveModels: fakeModels(distillerRuntime()) });
  const { session } = await hostSession(pi, { ...paths, factories: [factory], mode: 'print' });
  await session.prompt('Fictional one-shot prompt.');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([loaded, store.spawned, readFileSync(join(paths.config.state_dir, 'live.log'), 'utf8').includes('"mode":"print"')], [0, 0, true]);
  await shutdown(session);
});

test('live extension SDK tests run where they are required', { skip: !process.env.SOURCE_MEMORY_REQUIRE_PI_SDK }, () => {
  assert.ok(sdkPath, 'PI_SDK_MODULE must name the Pi SDK when SOURCE_MEMORY_REQUIRE_PI_SDK is set');
});
