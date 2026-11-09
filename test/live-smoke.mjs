import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, identity } from '../src/core.mjs';
import { Memory } from '../src/memory.mjs';
import { createLiveExtension } from '../pi-extension/live-extension.mjs';
import { distillerRuntime, fakeModels, hostSession } from './helpers/fake-pi.mjs';

const waitFor = async (predicate, ms = 120000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('live_smoke_wait_timeout'); await new Promise(resolve => setTimeout(resolve, 25)); }
};

/**
 * End-to-end: a real Pi SDK session loads the live extension, which spawns the real scoped Memory process against the
 * disposable Neo4j, distills each settled turn with a scripted offline model, and survives a restart without overlap.
 */
export async function runLiveSmoke({ database, scratch, sdkPath }) {
  const pi = await import(pathToFileURL(sdkPath).href);
  const root = join(scratch, 'live-smoke');
  for (const dir of ['', 'agent', 'sessions', 'state']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const embed = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    res.end(JSON.stringify({ model: input.model, data: input.input.map((value, index) => ({ index, embedding: /amber/i.test(value) ? [1, 0, 0] : [0, 0, 1] })) }));
  });
  embed.listen(0, '127.0.0.1');
  await once(embed, 'listening');
  const memoryConfig = { neo4j: database, scopes: { read: ['live-smoke'], write: ['live-smoke'] }, index_on_write: false,
    embedding: { url: `http://127.0.0.1:${embed.address().port}/embed`, model: 'fixture-only', dimensions: 3 } };
  const memoryConfigPath = join(root, 'memory.json');
  writeFileSync(memoryConfigPath, JSON.stringify(memoryConfig), { mode: 0o600 });
  const configPath = join(root, 'live.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, scope: 'live-smoke', state_dir: join(root, 'state'), memory: { config: memoryConfigPath },
    distiller: { model: 'fiction/model' }, budget: { input_tokens_per_day: 1000000, max_intervals_per_day: 10 } }), { mode: 0o600 });
  const paths = { cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions') };
  const results = [], errors = [];
  const extension = () => createLiveExtension({ configPath, resolveModels: fakeModels(distillerRuntime()),
    loadSdk: async () => pi, onResult: result => results.push(result), onError: error => errors.push(error.code ?? error.message) });
  const reader = new Memory(memoryConfig);
  try {
    const first = await hostSession(pi, { ...paths, factories: [extension()] });
    await first.session.prompt('Fictional: use amber for the release dashboard.');
    await waitFor(() => results.length + errors.length >= 1);
    await first.session.prompt('Fictional: the sidebar stays narrow.');
    await waitFor(() => results.length + errors.length >= 2);
    await first.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    first.session.dispose();

    const second = await hostSession(pi, { ...paths, factories: [extension()], sessionFile: first.sessionManager.getSessionFile() });
    await second.session.prompt('Fictional: after a restart, the footer stays small.');
    await waitFor(() => results.length + errors.length >= 3);
    await second.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    second.session.dispose();

    const status = await reader.status('live-smoke');
    const sessions = join(root, 'state', 'sessions');
    const dir = join(sessions, readdirSync(sessions)[0]);
    const journal = readFileSync(join(dir, readdirSync(dir).find(name => name.endsWith('.jsonl'))), 'utf8').trim().split('\n').map(JSON.parse);
    const ingests = journal.filter(row => row.type === 'begin').map(row => [row.cursor, row.through]);
    // Replaying a retained turn under its deterministic ID is a no-op in the real store.
    const [cursor, through] = ingests[0];
    const uid = identity('turn', 'live-smoke', 'pi-memory', first.sessionManager.getSessionId(), digest(['pi-memory-turn/v1', cursor, through]));
    const stored = await reader.show('live-smoke', { kind: 'turn', id: uid });
    const replay = await reader.ingest('live-smoke', stored.turn);
    assert.deepEqual([errors, results.map(row => row.status), status.turns, status.records, new Set(ingests.map(row => row[1])).size, replay.replayed],
      [[], ['covered', 'covered', 'covered'], 3, 3, 3, true]);
    assert.deepEqual(ingests.slice(1).map(row => row[0]), ingests.slice(0, -1).map(row => row[1]));
  } finally {
    await reader.close();
    embed.closeAllConnections();
    await new Promise(resolve => embed.close(resolve));
  }
}
