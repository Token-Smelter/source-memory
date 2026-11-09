import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIncrementalSession } from '../pi-extension/incremental.mjs';
import { createPiDistiller } from '../pi-extension/pi-runtime.mjs';
import { createInputBudget, boundPiRuntime } from '../pi-extension/budget.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';

const sdkPath = process.env.PI_SDK_MODULE;
test('a prior-action outcome review inside a distiller tool call shares the input budget without an unknown gap', { skip: !sdkPath }, async () => {
  const pi = await import(pathToFileURL(sdkPath).href);
  const directory = mkdtempSync(join(tmpdir(), 'pi-sdk-nested-'));
  try {
    const incremental = await createIncrementalSession({ source: new URL('./fixtures/pi-extension-steer.jsonl', import.meta.url).pathname,
      workDir: directory, sessionId: 'fiction-sdk-nested' });
    const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const model = { provider: 'fiction', id: 'model', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', contextWindow: 100000,
      maxTokens: 1000, input: ['text'], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const make = (content, stopReason) => ({ role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason, usage, content });
    let actionHandle;
    const messages = [() => make([{ type: 'toolCall', id: 'search', name: 'memory_search', arguments: { query: 'fiction', kinds: [] } }], 'toolUse'),
      () => make([{ type: 'toolCall', id: 'record', name: 'memory_record', arguments: { kind: 'outcome', text: 'Fictional result', evidence_labels: ['ref-000001'],
        action_handle: actionHandle } }], 'toolUse'),
      () => make([{ type: 'toolCall', id: 'submit', name: 'memory_submit', arguments: { result: 'done_with_writes', reason: 'Supported change.' } }], 'toolUse'),
      () => make([{ type: 'text', text: 'Submitted.' }], 'stop')];
    const runtime = { hasConfiguredAuth() { return true; }, streamSimple() {
      const message = messages.shift()();
      let finish;
      const result = new Promise(resolve => { finish = resolve; });
      return { result: () => result, async *[Symbol.asyncIterator]() { yield { type: 'start', partial: message }; finish(message); yield { type: 'done', reason: message.stopReason, message }; } };
    } };
    const budget = createInputBudget(1000000), bounded = boundPiRuntime(runtime, budget);
    const search = compactResult({ records: [{ id: 'prior-action', kind: 'action', text: 'Fictional prior action' }] });
    actionHandle = 'action-fiction';
    search.surface.records[0].action_handle = actionHandle;
    let reviewed = false, applied = null, pending = null;
    const reviewer = { async review() {
      budget.beforeCall();
      budget.record({ input: 5, cacheRead: 0, cacheWrite: 0, output: 1 });
      reviewed = true;
      return { reviewer: 'fiction-reviewer', decision_ref: 'fiction-decision', approved: [0] };
    } };
    const memory = { async searchCompact() { return search; },
      async beginOutcome(_scope, _trigger, outcome) { pending = outcome.id; return { token: 'fiction', proposal: { requires_review: true, proposal_sha256: 'a'.repeat(64) } }; },
      async applyOutcome(_scope, _token, review) { applied = review; return { status: 'written', records: ['prior-action', pending] }; } };
    const distiller = await createPiDistiller({ pi, incremental, workDir: directory, model, modelRuntime: bounded, memory, scope: 'fiction', budget, reviewer });
    const result = await distiller.run({ throughEntryId: 'a2', turn: { turn_id: 'fiction', entries: [{ id: 'u', role: 'user', text: 'A fictional result.' }] }, receipt: { id: 'turn' } })
    ;
    assert.deepEqual([result.disposition, reviewed, applied.reviewer, budget.reason(), budget.started(), budget.receipts().length],
      ['committed', true, 'separate:fiction-reviewer', null, 5, 5]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
