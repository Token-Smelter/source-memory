import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compactResult } from './helpers/compact-fixture.mjs';
import { distillerRuntime, fakeModels, hostSession } from './helpers/fake-pi.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'pi-live-extension-'));
chmodSync(scratch, 0o700);
// The default export reads this at import; it must never see an operator's real configuration.
process.env.SOURCE_MEMORY_PI_LIVE_CONFIG = join(scratch, 'absent.json');
const { createLiveExtension, parseLiveConfig } = await import('../pi-extension/live-extension.mjs');
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
    { ...base, scope: 'two scopes' }, { ...base, version: 2 }]) assert.throws(() => parseLiveConfig(broken), /live_config_invalid/);
});

test('a real Pi session settles immediately while the extension distills its turns in the background', { skip: !sdkPath }, async () => {
  const pi = await loadPi();
  const paths = layout('background');
  const { store, spawnMemory } = fakeMemory();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const results = [], errors = [];
  const factory = createLiveExtension({ configPath: paths.configPath, loadSdk: async () => pi, spawnMemory,
    resolveModels: fakeModels(distillerRuntime({ before: () => held })), onResult: result => results.push(result), onError: error => errors.push(error) });
  const { session, sessionManager } = await hostSession(pi, { ...paths, factories: [factory] });
  await session.prompt('Fictional: please use amber for the dashboard.');
  assert.deepEqual([results.length, store.records.size], [0, 0]);
  release();
  await waitFor(() => results.length === 1);
  await session.prompt('Fictional: and keep the sidebar narrow.');
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
