import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTools, LINK_DECISION_MODES } from '../pi-extension/core.mjs';
import { createPiDistiller } from '../pi-extension/pi-runtime.mjs';
import { validateLinkProposals } from '../src/link-proposals.mjs';
import { approvingReviewer, baselineScripts, distillerSurface, surfaceDigest, surfaceMemory, surfaceTurn } from './helpers/distiller-surface.mjs';

// The baseline surface (prompt, tools, descriptions, schemas, every tool response and the run result, without and with a
// reviewed link), computed on the code before T2 existed; any baseline change must update it knowingly.
const BASELINE_SURFACE_SHA256 = '7494d26a2326ee311f3bd1d12e0acd4f97c05ddb646a2b73a11d1e3ce26219a6';

const MODE = LINK_DECISION_MODES[0];
const turn = surfaceTurn;
const memory = calls => surfaceMemory({ calls });
const link = (to, type = 'supersedes', from = 'r0', evidence = ['s0']) => ({ from, to, type, evidence, support: 'explicit' });

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

async function distill(linkDecisions, script, extra = {}) {
  const { runs, registry } = await distillerSurface(createPiDistiller, { options: linkDecisions === undefined ? {} : { linkDecisions }, scripts: [script], ...extra });
  return { ...runs[0], descriptions: Object.fromEntries(registry.map(row => [row.name, row.description])) };
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

test('with link decisions, a link the Memory process would refuse after submit is refused now and decides nothing', async () => {
  const { tools } = await offered();
  assert.throws(() => tools.link(link('r2', 'qualifies', 'r1')), /link_endpoint_not_offered/);
  assert.throws(() => tools.link(link('r1', 'supersedes', 'r0', ['s1'])), /link_trigger_evidence_required/);
  assert.throws(() => tools.link(link('r1', 'outcome_of')), /invalid_outcome_relation/);
  assert.deepEqual([tools.undecidedLinks(), tools.pendingLinks(), tools.stats().link_decisions.linked], [['r1', 'r2'], null, 0]);
  tools.link(link('r1'));
  assert.throws(() => tools.link(link('r1')), /duplicate_link_proposal/);
  assert.deepEqual(JSON.parse(tools.pendingLinks().output).links.length, 1);
  // Without the treatment these choices are still deferred to the Memory process, as before.
  const plain = (await offered(null)).tools;
  plain.link(link('r2', 'qualifies', 'r1'));
  plain.link(link('r1', 'supersedes', 'r0', ['s1']));
  assert.equal(JSON.parse(plain.pendingLinks().output).links.length, 2);
});

test('the default surface is byte-identical to the baseline before T2, with and without a reviewed link', async () => {
  const surface = await distillerSurface(createPiDistiller, { scripts: baselineScripts, reviewer: approvingReviewer });
  assert.deepEqual([surface.runs[1].result.link.receipt.status, surfaceDigest(surface)], ['written', BASELINE_SURFACE_SHA256]);
  const unset = await distillerSurface(createPiDistiller, { options: { linkDecisions: null }, scripts: baselineScripts, reviewer: approvingReviewer });
  assert.equal(surfaceDigest(unset), BASELINE_SURFACE_SHA256);
});

test('a treated link is reviewed and applied through the real proposal validator, and each checkpoint resets its decisions', async () => {
  const calls = [];
  const linked = async call => {
    await writeAndOffer(call);
    await call('memory_link', link('r1'));
    await call('memory_link_none', { handle: 'r2', basis: 'unrelated' });
    await submit(call);
  };
  const refusing = async call => { await writeAndOffer(call); await submit(call); await submit(call); await call('memory_link_none', { handle: 'r1', basis: 'unrelated' });
    await call('memory_link_none', { handle: 'r2', basis: 'unrelated' }); await submit(call); };
  const { runs } = await distillerSurface(createPiDistiller, { options: { linkDecisions: MODE }, scripts: [refusing, linked, refusing],
    memory: surfaceMemory({ calls, validate: validateLinkProposals }), reviewer: approvingReviewer });
  const row = run => run.result.search_limitations.statuses.at(-1);
  assert.deepEqual([runs[1].result.link.receipt, row(runs[1])], [{ status: 'written', approved: [0] }, { surface: 'link-decisions', mode: MODE, offers: 1,
    required: 2, linked: 1, none_unrelated: 1, none_related_not_stated: 0, undecided_open: 0, undecided_at_submit: 0, submit_refusals: 0 }]);
  assert.deepEqual([row(runs[0]), row(runs[2])].map(value => [value.submit_refusals, value.none_unrelated, value.undecided_at_submit]), [[2, 2, 0], [2, 2, 0]]);
  assert.deepEqual(calls.filter(name => ['finish', 'apply'].includes(name)), ['finish', 'apply']);
});
