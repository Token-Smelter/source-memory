import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';

const rows = readFileSync(new URL('./fixtures/pi-extension-steer.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const loadCore = () => import('../pi-extension/core.mjs');
const loadTransport = () => import('../pi-extension/ndjson.mjs');
function fixture() {
  const calls = [];
  return { entries: rows.slice(1), conversation_id: 'fictional', scopes: ['private'],
    memory: { async ingest(scope, turn) { calls.push({ scope, turn }); return { id: 'turn-fiction', replayed: false }; } },
    distiller: { async run(input) { calls.push({ distill: input }); return { status: 'complete', usage: {} }; } }, calls };
}

test('cursor-bounded turn includes original and steered entries without live identity collision', async () => {
  const { distillThrough } = await loadCore();
  const session = fixture();
  const result = await distillThrough(session, 'a2', null);
  assert.deepEqual([session.calls[0].turn.source, session.calls[0].turn.entries.map(row => row.id), result.cursor],
    ['pi-memory', ['u1', 'a1', 't1', 'u2', 'a2'], 'a2']);
});

test('custom message is omitted with its ID and cannot become a source evidence label', async () => {
  const { distillThrough, createTurnTools } = await loadCore();
  const session = fixture();
  session.entries = [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Fiction' } },
    { type: 'custom_message', id: 'advice', parentId: 'u', content: 'Earlier model advice' },
    { type: 'message', id: 'a', parentId: 'advice', message: { role: 'assistant', content: 'Done', stopReason: 'stop' } }];
  const result = await distillThrough(session, 'a', null);
  const tools = createTurnTools({ scope: 'private', turn: session.calls[0].turn, receipt: { id: 'turn' }, memory: {} });
  assert.deepEqual([session.calls[0].turn.entries.map(row => row.id), result.omissions, tools.labels().length],
    [['u', 'a'], { custom_message: { count: 1, entry_ids: ['advice'] } }, 2]);
});

test('next cursor consumes only the same-branch suffix', async () => {
  const { distillThrough } = await loadCore();
  const session = fixture();
  await distillThrough(session, 'a3', 'a2');
  assert.deepEqual(session.calls[0].turn.entries.map(row => row.id), ['u3', 'a3']);
});

test('missing cursor and unfinished reply refuse without any side effect', async () => {
  const { distillThrough } = await loadCore();
  const session = fixture();
  await assert.rejects(distillThrough(session, 'a3', 'missing'), /cursor_unresolved/);
  await assert.rejects(distillThrough(session, 'a1', null), /turn_incomplete/);
  assert.equal(session.calls.length, 0);
});

test('scope list is required and multiple scopes refuse pending cross-scope policy', async () => {
  const { distillThrough } = await loadCore();
  const session = fixture();
  session.scopes = ['one', 'two'];
  await assert.rejects(distillThrough(session, 'a2', null), /scope_unresolved/);
  assert.equal(session.calls.length, 0);
});

test('a failed distiller does not return an advanced cursor', async () => {
  const { distillThrough } = await loadCore();
  const session = fixture();
  session.distiller.run = async () => { throw new Error('fake model failed'); };
  await assert.rejects(distillThrough(session, 'a2', null));
});

test('link choices accept only handles from the exact offer packet', async () => {
  const { createLinkChoices } = await loadCore();
  const choices = createLinkChoices({ records: [{ ref: 'r0' }, { ref: 'r1' }], sources: [{ ref: 's0' }] });
  assert.throws(() => choices.add({ from: 'r0', to: 'r-forged', type: 'qualifies', evidence: ['s0'], support: 'explicit' }), /handle_not_offered/);
});

test('record tool creates deterministic source-backed evidence only for current labels', async () => {
  const { createTurnTools } = await loadCore();
  const appended = [];
  const memory = { async enrich(scope, payload) { appended.push({ scope, payload }); return { retained: true }; } };
  const options = { scope: 'private', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fictional evidence' }] }, receipt: { id: 'turn-id' }, memory };
  const one = createTurnTools(options);
  const two = createTurnTools(options);
  await assert.rejects(one.record('decision', 'A choice', ['ref-999999']), /label_not_offered/);
  const first = await one.record('decision', 'A choice', ['ref-000001']);
  const second = await two.record('decision', 'A choice', ['ref-000001']);
  assert.deepEqual([first.id, appended[0].payload.records[0].evidence, first.id === second.id],
    [second.id, [{ turn: 'turn-id', entry_id: 'u', start: 0, end: 18 }], true]);
});

test('link tool uses current offer handles and never invokes raw relation writes', async () => {
  const { createTurnTools } = await loadCore();
  const writes = [];
  const memory = { async enrich(_scope, payload) { writes.push(payload); return {}; },
    async beginLinks() { return { token: 'offered', packet: { records: [{ ref: 'r0' }, { ref: 'r1' }], sources: [{ ref: 's0' }] } }; } };
  const tools = createTurnTools({ scope: 'private', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fiction' }] }, receipt: { id: 'turn-id' }, memory });
  await tools.record('decision', 'Choice', ['ref-000001']);
  await tools.offer();
  assert.throws(() => tools.link({ from: 'r0', to: 'r-other', type: 'qualifies', evidence: ['s0'], support: 'explicit' }), /handle_not_offered/);
  assert.equal(writes.every(payload => payload.relations.length === 0), true);
});

test('pending Memory proposal exposes exact offer, accepts compare, and retains the in-process apply object', async () => {
  const { createMemoryHandlers } = await import('../pi-extension/memory-process.mjs');
  const candidate = { token: 'same-object', proposals: [{ from: 'r1', to: 'r0' }] };
  let applied;
  const linkModule = { async proposeMemoryLinks({ compare }) {
    const comparison = await compare({ packet: { records: [{ ref: 'r0' }, { ref: 'r1' }], sources: [{ ref: 's0' }] } });
    assert.equal(JSON.parse(comparison.text).links.length, 1);
    return candidate;
  }, async applyReviewedMemoryLinks({ result }) { applied = result; return { status: 'written' }; } };
  const handlers = createMemoryHandlers({ memory: {}, scopes: ['private'], linkModule, beforeAppend: async () => ({ accepted: true }) });
  const offered = await handlers.beginLinks({ scope: 'private', turn: 'turn', record_ids: ['record'], review_contract: 'fictional' }, { signal: new AbortController().signal });
  const result = await handlers.finishLinks({ token: offered.token, output: JSON.stringify({ links: [{ type: 'qualifies', from: 'r1', to: 'r0', evidence: ['s0'], support: 'explicit' }] }), route: { provider: 'fiction', model: 'fake' } });
  const receipt = await handlers.applyLinks({ token: offered.token, review: { reviewer: 'separate' } });
  assert.deepEqual([result.proposals.length, applied === candidate, receipt.status], [1, true, 'written']);
});

test('cancelling a pending offer settles it without leaving the protocol blocked', async () => {
  const { createMemoryHandlers } = await import('../pi-extension/memory-process.mjs');
  const linkModule = { async proposeMemoryLinks({ compare }) { await compare({ packet: { records: [], sources: [] } }); return {}; } };
  const handlers = createMemoryHandlers({ memory: {}, scopes: ['private'], linkModule, beforeAppend: async () => ({}) });
  const offered = await handlers.beginLinks({ scope: 'private', turn: 'turn', record_ids: ['record'], review_contract: 'fictional' }, { signal: new AbortController().signal });
  assert.deepEqual(await handlers.cancelLinks({ token: offered.token }), { cancelled: true });
  await assert.rejects(handlers.finishLinks({ token: offered.token, output: '{"links":[]}', route: {} }), /offer_unavailable/);
});

test('Memory process denies cross-scope and direct relation writes', async () => {
  const { createMemoryHandlers } = await import('../pi-extension/memory-process.mjs');
  let calls = 0;
  const handlers = createMemoryHandlers({ memory: { async enrich() { calls++; } }, scopes: ['private'] });
  await assert.rejects(handlers.enrich({ scope: 'other', input: { records: [], relations: [] } }), /scope_denied/);
  await assert.rejects(handlers.enrich({ scope: 'private', input: { records: [], relations: [{ id: 'edge', type: 'qualifies', from: 'a', to: 'b', attribution: 'fake', evidence: [{ turn: 't', entry_id: 'e', start: 0, end: 1 }] }] } }), /raw_link_refused/);
  assert.equal(calls, 0);
});

test('Memory process rejects a record citing a different turn before writes', async () => {
  const { createMemoryHandlers } = await import('../pi-extension/memory-process.mjs');
  let calls = 0;
  const handlers = createMemoryHandlers({ memory: { async enrich() { calls++; } }, scopes: ['private'] });
  const input = { records: [{ id: 'record', kind: 'decision', text: 'Fiction', status: 'proposed', attribution: 'fiction',
    evidence: [{ turn: 'other-turn', entry_id: 'u', start: 0, end: 2 }] }], relations: [] };
  await assert.rejects(handlers.enrich({ scope: 'private', trigger: 'current-turn', input }), /record_not_from_trigger/);
  assert.equal(calls, 0);
});

test('incremental fake Pi distiller reopens the same private session and branches at each source leaf', async () => {
  const { createPiDistiller } = await import('../pi-extension/pi-runtime.mjs');
  const calls = [];
  const incremental = { sessionId: 'distiller-id', async syncThrough(id) { calls.push(['sync', id]); return { file: '/fiction/private' }; } };
  const manager = { getSessionId: () => 'distiller-id', branch(id) { calls.push(['branch', id]); this.leaf = id; },
    buildSessionContext() { return { messages: [{ role: 'user', content: this.leaf }] }; } };
  const makeSession = () => ({ sessionId: 'distiller-id', agent: { sessionId: 'distiller-id', state: {} }, messages: [],
    async prompt() { calls.push(['prompt', this.agent.state.messages[0].content]); this.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }]; } });
  const pi = { SessionManager: { open: () => { calls.push(['open']); return manager; } }, async createAgentSession() { return { session: makeSession() }; } };
  const runtime = await createPiDistiller({ pi, incremental, workDir: '/fiction/work', model: {}, memory: {}, scope: 'private', createOptions: {} });
  for (const id of ['a2', 'a3']) await runtime.run({ throughEntryId: id, turn: { turn_id: id, entries: [] }, receipt: { id: 'turn' } });
  assert.deepEqual(calls, [['sync', 'a2'], ['open'], ['branch', 'a2'], ['prompt', 'a2'], ['sync', 'a3'], ['open'], ['branch', 'a3'], ['prompt', 'a3']]);
});

for (const mode of ['separate', 'self_review']) {
  test(`Pi tool proposals require an explicitly labelled ${mode} reviewer call`, async () => {
    const { createPiDistiller } = await import('../pi-extension/pi-runtime.mjs');
    const registered = new Map();
    const calls = [];
    const api = { on() {}, registerTool(tool) { registered.set(tool.name, tool); } };
    class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0](api); } }
    const manager = { getSessionId: () => 'distiller-id', branch() {}, buildSessionContext: () => ({ messages: [] }) };
    const result = { contract: 'source-memory-links/v2', review_contract: 'fictional', operation_id: 'operation', context_sha256: 'a',
      semantic_proposal_sha256: 'b', proposal_sha256: 'c', proposals: [{}] };
    const memory = { async enrich() {}, async beginLinks() { return { token: 'offer', packet: { records: [{ ref: 'r0', kind: 'decision', text: 'A' },
      { ref: 'r1', kind: 'decision', text: 'B' }], sources: [{ ref: 's0', role: 'user', trigger: true, text: 'Fiction' }] } }; },
    async finishLinks(_token, output) { calls.push(['compare', JSON.parse(output).links.length]); return result; },
    async applyLinks(_token, review) { calls.push(['apply', review.reviewer]); return { status: 'written' }; } };
    const session = { sessionId: 'distiller-id', agent: { sessionId: 'distiller-id', state: {} }, messages: [], async prompt() {
      await registered.get('memory_record').execute('1', { kind: 'decision', text: 'Choice', evidence_labels: ['ref-000001'] });
      await registered.get('memory_search').execute('2', { query: 'Choice', kinds: ['decision'] });
      await registered.get('memory_link').execute('3', { from: 'r0', to: 'r1', type: 'qualifies', evidence: ['s0'], support: 'explicit' });
      this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] }];
    } };
    const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
      async createAgentSession() { return { session }; } };
    const reviewer = { async review({ mode: selected }) { calls.push(['review', selected]); return { reviewer: 'fake-reviewer', decision_ref: 'fake-decision', approved: [0] }; } };
    const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'distiller-id', async syncThrough() { return { file: '/fiction/private' }; } },
      workDir: '/fiction/work', model: { provider: 'fiction', id: 'fake' }, memory, scope: 'private', reviewer, reviewMode: mode });
    await runtime.run({ throughEntryId: 'a2', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fiction' }] }, receipt: { id: 'turn' } });
    assert.deepEqual(calls, [['compare', 1], ['review', mode], ['apply', `${mode}:fake-reviewer`]]);
  });
}

test('Pi reviewer is a separate call that approves only valid offered indices', async () => {
  const { createPiReviewer } = await import('../pi-extension/reviewer.mjs');
  let calls = 0;
  const session = { messages: [], async prompt() { calls++; this.messages = [{ role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: JSON.stringify({ verdicts: [{ index: 0, verdict: 'approve', reason: 'fiction' }] }) }] }]; } };
  const pi = { SessionManager: { inMemory: () => ({}) }, async createAgentSession() { return { session }; } };
  const reviewer = createPiReviewer({ pi, workDir: '/fiction', model: { provider: 'fake', id: 'reviewer' } });
  const result = await reviewer.review({ mode: 'separate', proposal: { proposal_sha256: 'a', packet: {}, proposals: [{ from: 'r1', to: 'r0' }] } });
  assert.deepEqual([calls, result.reviewer, result.approved], [1, 'fake/reviewer', [0]]);
});

test('Anthropic breakpoint uses the history block and respects the breakpoint cap', async () => {
  const { addHistoryBreakpoint } = await import('../pi-extension/pi-runtime.mjs');
  const payload = { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'history' }] },
    { role: 'user', content: [{ type: 'text', text: 'task', cache_control: { type: 'ephemeral' } }] }] };
  assert.equal(addHistoryBreakpoint(payload).added, true);
  assert.deepEqual(payload.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(addHistoryBreakpoint({ system: Array(4).fill({ cache_control: {} }), messages: payload.messages }).reason, 'breakpoint_limit');
});

test('agent_settled enqueues background work without awaiting a stalled distiller', async () => {
  const { registerPiMemory } = await import('../pi-extension/index.mjs');
  const hooks = new Map();
  let started = false;
  registerPiMemory({ on: (name, handler) => hooks.set(name, handler) }, {
    async prepare() { started = true; return new Promise(() => {}); }, onError() {} });
  const handler = hooks.get('agent_settled');
  await Promise.race([handler({}, { sessionManager: { getLeafId: () => 'a2', getEntries: () => rows.slice(1), getSessionId: () => 's' } }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('blocked')), 100))]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, true);
});

test('pending NDJSON compare can be cancelled without blocking another request', async () => {
  const { createClient, serve } = await loadTransport();
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const stopped = new AbortController();
  const server = serve({ input: toServer, output: toClient, signal: stopped.signal,
    handlers: { compare: async (_args, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
      ping: async () => 'pong' } });
  const client = createClient({ input: toClient, output: toServer, timeoutMs: 500 });
  const controller = new AbortController();
  const pending = client.request('compare', {}, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /cancel/);
  assert.equal(await client.request('ping', {}), 'pong');
  client.close(); stopped.abort(); toServer.end(); toClient.end(); await server;
});
