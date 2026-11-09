import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiDistiller, DISTILLER_GUIDANCE } from '../pi-extension/pi-runtime.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';

async function promptFor(guidance) {
  const registered = new Map(), prompts = [];
  const api = { on() {}, registerTool(tool) { registered.set(tool.name, tool); } };
  class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0](api); } }
  const manager = { getSessionId: () => 'distiller-id', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const session = { sessionId: 'distiller-id', agent: { sessionId: 'distiller-id', state: {} }, messages: [], async prompt(text) {
    prompts.push(text);
    await registered.get('memory_search').execute('s', { query: 'fiction', kinds: [] });
    this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"result":"done_nothing_qualifies","reason":"Fiction."}' }] }];
  } };
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession() { return { session }; } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'distiller-id', async syncThrough() { return { file: '/fiction/private' }; } },
    workDir: '/fiction/work', model: {}, memory: { async searchCompact() { return compactResult(); } }, scope: 'private', guidance });
  await runtime.run({ throughEntryId: 'a2', turn: { turn_id: 't', entries: [] }, receipt: { id: 'turn' } });
  return prompts[0];
}

for (const key of ['typed-records-and-links-v2', 'typed-records-and-links-v3']) test(`${key} guidance is appended to the checkpoint instructions only when sealed; the default prompt is unchanged`, async () => {
  const base = await promptFor(null), guided = await promptFor(key);
  const text = DISTILLER_GUIDANCE[key];
  const split = guided.indexOf(`\n${text}\n`);
  assert.deepEqual([base.includes(text), split > 0, guided.slice(0, split) + guided.slice(split + text.length + 2)], [false, true, base]);
  await assert.rejects(promptFor('unknown'), /runtime_invalid/);
});
