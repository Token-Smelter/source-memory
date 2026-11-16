import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTools, LINK_DECISION_MODES } from '../pi-extension/core.mjs';
import { createPiDistiller } from '../pi-extension/pi-runtime.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';

const MODE = LINK_DECISION_MODES[0];
const turn = { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fictional choice replaces the earlier fictional choice.' }] };
const retrieval = { status: 'selected', relationship_context_complete: false, completeness_guaranteed: false,
  budget_omitted: 0, omitted_prior_records: 0, omitted_prior_spans: 0, trigger_omissions: [] };
const packet = { records: [
  { ref: 'r0', kind: 'decision', text: 'Fictional new choice.', newly_retained: true, evidence: ['s0'] },
  { ref: 'r1', kind: 'decision', text: 'Fictional prior choice.', newly_retained: false, evidence: ['s1'] },
  { ref: 'r2', kind: 'observation', text: 'Fictional prior fact.', newly_retained: false, evidence: ['s2'] }],
sources: [{ ref: 's0', role: 'user', text: 'Fictional choice.', trigger: true }, { ref: 's1', role: 'user', text: 'Earlier.', trigger: false },
  { ref: 's2', role: 'tool', text: 'Fact.', trigger: false }], retrieval };
const memory = (calls = []) => ({
  async searchCompact() { return compactResult({ records: [{ id: 'prior-1', kind: 'decision', text: 'Fictional prior choice.' },
    { id: 'prior-2', kind: 'observation', text: 'Fictional prior fact.' }] }); },
  async enrich() { return {}; }, async cancelLinks() { calls.push('cancel'); },
  async beginLinks() { calls.push('offer'); return { token: `offer-${calls.length}`, packet: structuredClone(packet) }; } });
const link = (to, type = 'supersedes') => ({ from: 'r0', to, type, evidence: ['s0'], support: 'explicit' });

async function offered(linkDecisions = MODE, calls = []) {
  const tools = createTurnTools({ scope: 'fiction', turn, receipt: { id: 'turn' }, memory: memory(calls), linkDecisions });
  const found = await tools.search('fiction', []);
  await tools.record('decision', 'Fictional new choice.', ['ref-000001']);
  await tools.offer(found.records.map(row => row.id));
  return { tools, found };
}

test('with link decisions, every offered prior record needs a link or an explicit none; new records need none', async () => {
  const { tools } = await offered();
  assert.deepEqual(tools.undecidedLinks(), ['r1', 'r2']);
  tools.link(link('r1'));
  assert.deepEqual(tools.undecidedLinks(), ['r2']);
  assert.deepEqual(tools.linkNone('r2', 'related_not_stated'), { status: 'decided', undecided: [] });
  assert.deepEqual(tools.linkNone('r2', 'related_not_stated'), { status: 'decided', undecided: [] });
  assert.deepEqual(tools.stats().link_decisions, { mode: MODE, offers: 1, required: 2, linked: 1, none_unrelated: 0, none_related_not_stated: 1 });
  assert.deepEqual(JSON.parse(tools.pendingLinks().output).links.map(row => row.to), ['r1']);
});

test('a decision is final: none after a link, a link after none, or a second basis is refused without changing the proposal', async () => {
  const { tools } = await offered();
  tools.link(link('r1'));
  assert.throws(() => tools.linkNone('r1', 'unrelated'), /link_decision_conflict/);
  tools.linkNone('r2', 'unrelated');
  assert.throws(() => tools.linkNone('r2', 'related_not_stated'), /link_decision_conflict/);
  assert.throws(() => tools.link(link('r2', 'qualifies')), /link_decision_conflict/);
  assert.deepEqual(JSON.parse(tools.pendingLinks().output).links.length, 1);
});

test('none names only an offered prior record with a known basis, and only while an offer is open', async () => {
  const before = createTurnTools({ scope: 'fiction', turn, receipt: { id: 'turn' }, memory: memory(), linkDecisions: MODE });
  assert.throws(() => before.linkNone('r1', 'unrelated'), /offer_unavailable/);
  assert.deepEqual(before.undecidedLinks(), []);
  const { tools } = await offered();
  assert.throws(() => tools.linkNone('r0', 'unrelated'), /handle_not_offered/);
  assert.throws(() => tools.linkNone('r9', 'unrelated'), /handle_not_offered/);
  assert.throws(() => tools.linkNone('r1', 'similar'), /link_invalid/);
  assert.deepEqual(tools.undecidedLinks(), ['r1', 'r2']);
});

test('a later record or a re-offer closes the open offer, and the next offer needs its own decisions', async () => {
  const calls = [];
  const { tools, found } = await offered(MODE, calls);
  tools.linkNone('r1', 'unrelated');
  await tools.offer([found.records[0].id]);
  assert.deepEqual(tools.undecidedLinks(), ['r1', 'r2']);
  await tools.record('observation', 'Fictional new fact.', ['ref-000001']);
  assert.deepEqual(tools.undecidedLinks(), []);
  assert.deepEqual([calls, tools.stats().link_decisions.offers, tools.stats().link_decisions.required], [['offer', 'cancel', 'offer', 'cancel'], 2, 4]);
});

test('without the treatment nothing changes: no decisions are owed, none is refused and stats carry no decision field', async () => {
  const { tools } = await offered(null);
  assert.deepEqual(tools.undecidedLinks(), []);
  assert.throws(() => tools.linkNone('r1', 'unrelated'), /link_decisions_disabled/);
  tools.link(link('r1'));
  assert.equal(Object.hasOwn(tools.stats(), 'link_decisions'), false);
  assert.throws(() => createTurnTools({ scope: 'fiction', turn, receipt: { id: 'turn' }, memory: memory(), linkDecisions: 'unknown' }), /invalid_input/);
});

async function distill(linkDecisions, script) {
  const registered = new Map(), prompts = [], sessions = [];
  const api = { on() {}, registerTool(tool) { registered.set(tool.name, tool); } };
  class Loader { constructor(options) { this.options = options; } async reload() { this.options.extensionFactories[0](api); } }
  const manager = { getSessionId: () => 'distiller-id', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const call = async (name, args) => {
    try { return { ok: JSON.parse((await registered.get(name).execute('id', args)).content[0].text) }; }
    catch (error) { return { error: error.message }; }
  };
  const transcript = [];
  const session = { sessionId: 'distiller-id', agent: { sessionId: 'distiller-id', state: {} }, messages: [], async prompt(text) {
    prompts.push(text);
    await script(async (name, args) => { const result = await call(name, args); transcript.push([name, result]); return result; });
    this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Submitted.' }] }];
  } };
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession(options) { sessions.push(options.tools); return { session }; } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'distiller-id', async syncThrough() { return { file: '/fiction/private' }; } },
    workDir: '/fiction/work', model: {}, memory: memory(), scope: 'fiction', ...(linkDecisions === undefined ? {} : { linkDecisions }) });
  const result = await runtime.run({ throughEntryId: 'a2', turn, receipt: { id: 'turn' } });
  const descriptions = Object.fromEntries([...registered].map(([name, tool]) => [name, tool.description]));
  return { result, prompt: prompts[0], tools: sessions[0], descriptions, transcript };
}

const writeAndOffer = async call => {
  const found = await call('memory_search', { query: 'fiction', kinds: [] });
  await call('memory_record', { kind: 'decision', text: 'Fictional new choice.', evidence_labels: ['ref-000001'] });
  return call('memory_link_offer', { handles: found.ok.records.map(row => row.id) });
};
const submit = call => call('memory_submit', { result: 'done_with_writes', reason: 'Fiction.' });

test('the treatment adds only its tool surface: the prompt is unchanged and the default tools are byte-identical', async () => {
  const base = await distill(undefined, async call => { await writeAndOffer(call); await submit(call); });
  const unset = await distill(null, async call => { await writeAndOffer(call); await submit(call); });
  const treated = await distill(MODE, async call => {
    await writeAndOffer(call);
    await call('memory_link_none', { handle: 'r1', basis: 'unrelated' });
    await call('memory_link_none', { handle: 'r2', basis: 'unrelated' });
    await submit(call);
  });
  assert.deepEqual([unset.prompt, unset.tools, unset.descriptions], [base.prompt, base.tools, base.descriptions]);
  assert.equal(treated.prompt, base.prompt);
  assert.deepEqual(treated.tools.filter(name => name !== 'memory_link_none'), base.tools);
  assert.deepEqual([base.tools.includes('memory_link_none'), Object.hasOwn(base.descriptions, 'memory_link_none'), treated.tools.at(-2)], [false, false, 'memory_link_none']);
  for (const name of ['memory_link_offer', 'memory_submit']) assert.ok(treated.descriptions[name].startsWith(`${base.descriptions[name]} `));
  for (const name of ['memory_search', 'memory_fetch', 'memory_record', 'memory_link']) assert.equal(treated.descriptions[name], base.descriptions[name]);
  assert.equal(base.transcript[2][1].ok.decision_required, undefined);
  assert.deepEqual(treated.transcript[2][1].ok.decision_required, ['r1', 'r2']);
  assert.equal(base.result.search_limitations.statuses.some(row => row.surface === 'link-decisions'), false);
  await assert.rejects(distill('unknown', async () => {}), /runtime_invalid/);
});

test('memory_submit is refused while a decision is owed, then accepted once every offered prior record is decided', async () => {
  const { result, transcript } = await distill(MODE, async call => {
    await writeAndOffer(call);
    await call('memory_link_none', { handle: 'r1', basis: 'unrelated' });
    await submit(call);
    await call('memory_link_none', { handle: 'r2', basis: 'related_not_stated' });
    await submit(call);
  });
  const submits = transcript.filter(([name]) => name === 'memory_submit').map(([, row]) => row);
  assert.match(submits[0].error, /^link_decisions_missing: r2 /);
  assert.deepEqual(submits[1].ok, { status: 'submitted' });
  assert.deepEqual([result.disposition, result.search_limitations.statuses.at(-1)], ['committed', { surface: 'link-decisions', mode: MODE, offers: 1, required: 2,
    linked: 0, none_unrelated: 1, none_related_not_stated: 1, undecided_open: 0, undecided_at_submit: 0, submit_refusals: 1 }]);
});

test('the refusal is bounded: after two refusals memory_submit is accepted and the omissions are recorded', async () => {
  const { result, transcript } = await distill(MODE, async call => {
    await writeAndOffer(call);
    for (let i = 0; i < 3; i++) await submit(call);
  });
  const submits = transcript.filter(([name]) => name === 'memory_submit').map(([, row]) => row.error ? 'refused' : row.ok.status);
  assert.deepEqual(submits, ['refused', 'refused', 'submitted']);
  assert.deepEqual(result.search_limitations.statuses.at(-1), { surface: 'link-decisions', mode: MODE, offers: 1, required: 2,
    linked: 0, none_unrelated: 0, none_related_not_stated: 0, undecided_open: 2, undecided_at_submit: 2, submit_refusals: 2 });
});
