import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIncrementalSession } from '../pi-extension/incremental.mjs';
import { createPiDistiller } from '../pi-extension/pi-runtime.mjs';
import { createInputBudget, boundPiRuntime } from '../pi-extension/budget.mjs';
import { createSoftBudget } from '../pi-extension/evaluation/soft-budget.mjs';

const sdkPath = process.env.PI_SDK_MODULE;
test('installed Pi SDK runs the fictional distiller with a fake provider and soft metering', { skip: !sdkPath }, async () => {
  const pi = await import(pathToFileURL(sdkPath).href);
  const directory = mkdtempSync(join(tmpdir(), 'pi-sdk-offline-'));
  try {
    const source = new URL('./fixtures/pi-extension-steer.jsonl', import.meta.url).pathname;
    const incremental = await createIncrementalSession({ source, workDir: directory, sessionId: 'fiction-sdk-session' });
    const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const model = { provider: 'fiction', id: 'model', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', contextWindow: 100000,
      maxTokens: 1000, input: ['text'], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const make = (content, stopReason) => ({ role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason, usage, content });
    const messages = [make([{ type: 'toolCall', id: 's', name: 'memory_search', arguments: { query: 'fiction', kinds: [] } }], 'toolUse'),
      make([{ type: 'text', text: '{"result":"done_nothing_qualifies","reason":"No useful change."}' }], 'stop')];
    const runtime = { hasConfiguredAuth() { return true; }, streamSimple() {
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
    const tokenBudget = createInputBudget(1000000);
    const metered = soft.wrap(boundPiRuntime(runtime, tokenBudget), () => ({ purpose: 'candidate', arm: 'candidate', checkpoint: 'a2', task_version: 'fiction', policy_version: 'fiction' }));
    const distiller = await createPiDistiller({ pi, incremental, workDir: directory, model, modelRuntime: metered,
      memory: { async recall() { return { status: 'no_matches', bundles: [] }; } }, scope: 'fiction', budget: tokenBudget });
    const result = await distiller.run({ throughEntryId: 'a2', turn: { turn_id: 'fiction', entries: [] }, receipt: { id: 'fiction' } });
    await new Promise(resolve => setImmediate(resolve));
    soft.close();
    assert.deepEqual([result.disposition, soft.state().calls_started, readFileSync(join(directory, 'ledger.jsonl'), 'utf8').includes('"outcome":"received"')],
      ['abstained', 2, true]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
