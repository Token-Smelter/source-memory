import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIncrementalSession } from '../pi-extension/incremental.mjs';
import { createPiDistiller } from '../pi-extension/pi-runtime.mjs';
import { createInputBudget, boundPiRuntime } from '../pi-extension/budget.mjs';
import { createSoftBudget } from '../pi-extension/evaluation/soft-budget.mjs';

const sdkPath = process.env.PI_SDK_MODULE;
test('installed Pi SDK executes fictional Memory search and typed record tools through the metered runtime', { skip: !sdkPath }, async () => {
  const pi = await import(pathToFileURL(sdkPath).href);
  const directory = mkdtempSync(join(tmpdir(), 'pi-sdk-tools-'));
  try {
    const incremental = await createIncrementalSession({ source: new URL('./fixtures/pi-extension-steer.jsonl', import.meta.url).pathname,
      workDir: directory, sessionId: 'fiction-sdk-tools' });
    const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const model = { provider: 'fiction', id: 'model', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', contextWindow: 100000,
      maxTokens: 1000, input: ['text'], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const make = (content, stopReason) => ({ role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason, usage, content });
    const messages = [make([{ type: 'toolCall', id: 'search', name: 'memory_search', arguments: { query: 'fiction', kinds: [] } }], 'toolUse'),
      make([{ type: 'toolCall', id: 'invalid', name: 'memory_record', arguments: { kind: 'issue', text: 'Fiction', evidence_labels: ['ref-000001'] } }], 'toolUse'),
      make([{ type: 'toolCall', id: 'record', name: 'memory_record', arguments: { kind: 'decision', text: 'A fictional decision', evidence_labels: ['ref-000001'] } }], 'toolUse'),
      make([{ type: 'text', text: '{"disposition":"committed"}' }], 'stop')];
    const offeredTools = [];
    let offeredKinds;
    const runtime = { hasConfiguredAuth() { return true; }, streamSimple(_model, context) {
      offeredTools.push((context.tools ?? []).map(tool => tool.name));
      offeredKinds ??= context.tools?.find(tool => tool.name === 'memory_record')?.parameters?.properties?.kind?.enum;
      const message = messages.shift();
      let finish;
      const result = new Promise(resolve => { finish = resolve; });
      return { result: () => result, async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: message };
        finish(message);
        yield { type: 'done', reason: message.stopReason, message };
      } };
    } };
    const soft = createSoftBudget({ path: join(directory, 'ledger.jsonl'), capNano: '1000000', sessionKey: 'fiction', sealSha256: 'a'.repeat(64),
      routes: { 'fiction/model': { maxOutputTokens: 1000, ratesNanoPerToken: { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 }, rateEvidence: 'fiction' } } });
    const budget = createInputBudget(1000000);
    const metered = soft.wrap(boundPiRuntime(runtime, budget), () => ({ purpose: 'candidate', arm: 'candidate', checkpoint: 'a2', task_version: 'fiction', policy_version: 'fiction' }));
    const calls = [];
    const memory = { async recall() { calls.push('search'); return { status: 'no_matches', bundles: [] }; },
      async enrich(_scope, data) { calls.push(data.records[0].kind); return { records: [data.records[0].id] }; } };
    const distiller = await createPiDistiller({ pi, incremental, workDir: directory, model, modelRuntime: metered, memory, scope: 'fiction', budget });
    const result = await distiller.run({ throughEntryId: 'a2', turn: { turn_id: 'fiction', entries: [{ id: 'u', role: 'user', text: 'A fictional decision.' }] }, receipt: { id: 'turn' } });
    await new Promise(resolve => setImmediate(resolve));
    soft.close();
    assert.deepEqual([result.disposition, calls, soft.state().calls_started, offeredTools[0], offeredKinds],
      ['committed', ['search', 'decision'], 4, ['memory_search', 'memory_record', 'memory_link'],
        ['decision', 'observation', 'outcome', 'question', 'intention', 'episode', 'action']]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
