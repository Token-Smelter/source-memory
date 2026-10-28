import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHarness } from '../pi-extension/bridge-harness.mjs';
import { createSliceSession } from '../pi-extension/slice-runtime.mjs';
import { createInputBudget } from '../pi-extension/budget.mjs';

const source = fileURLToPath(new URL('./fixtures/pi-extension-steer.jsonl', import.meta.url));
const entries = readFileSync(source, 'utf8').trim().split('\n').slice(1).map(JSON.parse);

test('one fictional slice passes the gate, shared replay, fake Pi routing and memory process interface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-slice-'));
  try {
    const calls = [];
    const model = { provider: 'fake', id: 'haiku', api: 'fake', contextWindow: 1000 };
    const hostRuntime = { getModels: () => [model], async checkAuth() { return true; }, streamSimple() { calls.push('model'); } };
    const pi = { ModelRuntime: { async create() { return hostRuntime; } }, SessionManager: { open(file) {
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
      return { getSessionId: () => rows[0].id, branch() {}, buildSessionContext: () => ({ messages: [] }) };
    } }, async createAgentSession({ sessionManager, modelRuntime, model: selected }) {
      let subscriber = () => {};
      return { session: { sessionId: sessionManager.getSessionId(), agent: { sessionId: sessionManager.getSessionId(), state: {} }, messages: [],
        subscribe(fn) { subscriber = fn; }, async prompt() {
          modelRuntime.streamSimple(selected, {});
          const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'fiction' }], usage: { input: 10, cacheRead: 3, cacheWrite: 0, output: 2 } };
          this.messages.push(message); subscriber({ type: 'turn_end', message });
        } } };
    } };
    const docker = { gateway: '172.30.0.1', async createNetwork() { return 'net'; }, async createDatabase() { return 'db'; },
      async createDriver() { return 'driver'; }, async removeContainer() {}, async removeNetwork() {} };
    const gate = { ok: true, targets: [{ host: '127.0.0.1', port: 27690, outcome: 'error' },
      { host: '172.30.0.1', port: 27690, outcome: 'timeout' }, { host: '172.17.0.2', port: 27690, outcome: 'error' }] };
    const memory = { async init() { calls.push('init'); }, async ingest(_scope, turn) { calls.push(turn.source); return { id: 'turn' }; },
      async recall() { return { status: 'ready', bundles: [] }; } };
    const budget = createInputBudget(20000000);
    const result = await runHarness({ docker, relay: { async open() { return { async close() {} }; } }, isolation: async () => gate, memory,
      sessionFactory: async () => [{ session: await createSliceSession({ pi, source, entries, conversationId: 'fiction', workDir: dir,
        scope: 'private', memory, modelId: 'fake/haiku', reviewerId: 'fake/haiku', budget }), leaves: ['a2', 'a3'] }],
      cases: [{ id: 'case', query: 'fiction', asker_conversation_id: 'other' }] });
    assert.deepEqual([result.status, calls, budget.used(), result.replayed[0].results.length],
      ['complete', ['init', 'pi-memory', 'model', 'pi-memory', 'model'], 26, 2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
