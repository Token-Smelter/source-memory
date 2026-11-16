import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTools, LINK_ALIAS_MODES } from '../pi-extension/core.mjs';
import { createPiDistiller } from '../pi-extension/pi-runtime.mjs';
import { PassThrough } from 'node:stream';
import { createMemoryClient } from '../pi-extension/memory-client.mjs';
import { serve } from '../pi-extension/ndjson.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';
import { approvingReviewer, baselineScripts, distillerSurface, surfaceMemory } from './helpers/distiller-surface.mjs';

const MODE = LINK_ALIAS_MODES[0];
const image = `[image sha256=${'a'.repeat(64)} mime=image/png]`;
// Two user entries with identical text, a tool entry, and one entry split into two citable spans by an image.
const turn = { turn_id: 't', entries: [
  { id: 'u1', role: 'user', text: 'Fictional same text.' }, { id: 'u2', role: 'user', text: 'Fictional same text.' },
  { id: 't1', role: 'tool', text: 'Fictional tool fact.' }, { id: 'u3', role: 'user', text: `Before ${image} after.` }] };
const spanKey = span => JSON.stringify([span.turn, span.entry_id, span.start, span.end]);

/**
 * A Memory double whose packet follows the Memory process's construction: new records first in id order, then the
 * offered prior records in id order, one source per distinct span; references bind every label to its id or span.
 */
function packetMemory({ references = 'exact', extraTriggerSpans = [], priorCount = 2 } = {}) {
  const calls = [], written = new Map();
  const priors = Array.from({ length: priorCount }, (_, i) => ({ id: `prior-${i}`, kind: 'decision', text: `Fictional prior ${i}.`,
    evidence: [{ turn: `earlier-${i}`, entry_id: 'e', start: 0, end: 5 }] }));
  const memory = {
    calls,
    async searchCompact() { return compactResult({ records: priors.map(row => ({ id: row.id, kind: row.kind, text: row.text })) }); },
    async enrich(_scope, payload) { for (const row of payload.records) written.set(row.id, row); return { records: payload.records.map(row => row.id) }; },
    async cancelLinks(token) { calls.push(['cancel', token]); },
    async beginLinks(scope, trigger, recordIds, options) {
      calls.push(['offer', scope, trigger, [...recordIds], structuredClone(options)]);
      const records = [], sources = [], refRecords = [], refSources = [], spans = new Map();
      const source = (span, role) => {
        const key = spanKey(span);
        if (!spans.has(key)) {
          const ref = `s${sources.length}`;
          spans.set(key, ref);
          sources.push({ ref, role, occurred_at: '2030-01-01T00:00:00Z', text: 'Fictional excerpt.', trigger: span.turn === trigger });
          refSources.push({ ref, ...span });
        }
        return spans.get(key);
      };
      const add = (row, fresh) => {
        const ref = `r${records.length}`;
        records.push({ ref, kind: row.kind, status: 'proposed', attribution: 'fiction', text: row.text,
          evidence: row.evidence.map(span => source(span, turn.entries.find(entry => entry.id === span.entry_id)?.role ?? 'user')), newly_retained: fresh });
        refRecords.push({ ref, id: row.id });
      };
      for (const id of [...recordIds].sort()) add(written.get(id), true);
      const priorIds = options.candidateHandles.map(handle => bindings.get(handle)).sort();
      for (const id of priorIds) add(priors.find(row => row.id === id), false);
      for (const span of extraTriggerSpans) source({ turn: trigger, ...span }, 'user');
      const packet = { records, sources, retrieval: { status: 'selected', relationship_context_complete: false, completeness_guaranteed: false,
        budget_omitted: 0, omitted_prior_records: 0, omitted_prior_spans: 0, trigger_omissions: [] } };
      const bound = references === 'exact' ? { records: refRecords, sources: refSources } : references(refRecords, refSources);
      return { token: `offer-${calls.length}`, packet, ...(options.withReferences && bound !== undefined ? { references: bound } : {}) };
    },
  };
  const bindings = new Map();
  return { memory, calls, bindings };
}

async function setup({ linkAliases = MODE, ...options } = {}) {
  const { memory, calls, bindings } = packetMemory(options);
  const tools = createTurnTools({ scope: 'fiction', turn, receipt: { id: 'turn' }, memory, linkAliases });
  const found = await tools.search('fiction', []);
  const priorHandles = found.records.map(row => row.id);
  const bindingRows = tools.stats().search_statuses[0].previewed_ids;
  priorHandles.forEach((handle, i) => bindings.set(handle, bindingRows[i]));
  // Same kind and text, different evidence spans: two distinct records.
  const first = await tools.record('decision', 'Fictional same choice.', ['ref-000001']);
  const second = await tools.record('decision', 'Fictional same choice.', ['ref-000002', 'ref-000003']);
  return { tools, calls, priorHandles, first: first.id, second: second.id };
}
const packetOf = calls => calls.findLast(row => row[0] === 'offer');
const pending = tools => JSON.parse(tools.pendingLinks().output).links;

test('own record ids, offered handles and current-turn labels resolve through the offer bindings to exact packet labels', async () => {
  const { tools, calls, priorHandles, first, second } = await setup();
  const offered = await tools.offer([second, priorHandles[0]]);
  const refOf = id => offered.packet.records[[...packetOf(calls)[3]].sort().indexOf(id)].ref;
  tools.link({ from: second, to: priorHandles[0], type: 'supersedes', evidence: ['ref-000002'], support: 'explicit' });
  const [link] = pending(tools);
  const secondRecord = offered.packet.records.find(row => row.ref === link.from);
  // The duplicate-text record and the identical-text entry resolve by id and by exact span, not by text.
  assert.equal(link.from, refOf(second));
  assert.notEqual(link.from, refOf(first));
  assert.deepEqual([link.evidence, secondRecord.evidence[0], link.to], [[secondRecord.evidence[0]], link.evidence[0], 'r2']);
  assert.deepEqual(packetOf(calls).slice(1, 3), ['fiction', 'turn']);
  assert.deepEqual(tools.stats().link_aliases, { mode: MODE, offer_own_records: 1, links_aliased: 1, endpoint_own_record: 1, endpoint_offered_handle: 1,
    evidence_label: 1, refused_not_in_packet: 0, refused_ambiguous: 0 });
});

test('naming own records in an offer forwards only search handles and asks for the bindings', async () => {
  const { tools, calls, priorHandles, first } = await setup();
  await tools.offer([first, priorHandles[1]]);
  assert.deepEqual(packetOf(calls)[4], { candidateHandles: [priorHandles[1]], withReferences: true });
  assert.deepEqual(tools.stats().search_statuses.at(-1).candidate_ids, ['prior-1']);
  assert.deepEqual(tools.stats().link_candidate_ids, ['prior-1']);
});

test('the two spans of one entry split by an image resolve separately; a label outside the packet fails closed', async () => {
  const { memory, bindings } = packetMemory();
  const tools = createTurnTools({ scope: 'fiction', turn, receipt: { id: 'turn' }, memory, linkAliases: MODE });
  const found = await tools.search('fiction', []);
  tools.stats().search_statuses[0].previewed_ids.forEach((id, i) => bindings.set(found.records[i].id, id));
  const labels = tools.labels().filter(row => row.text.includes('Before') || row.text.includes('after'));
  assert.equal(labels.length, 2);
  const { id } = await tools.record('observation', 'Fictional split fact.', [labels[1].ref]);
  const offered = await tools.offer([found.records[0].id]);
  tools.link({ from: id, to: found.records[0].id, type: 'qualifies', evidence: [labels[1].ref], support: 'explicit' });
  assert.deepEqual(pending(tools)[0].evidence, offered.packet.records[0].evidence);
  assert.throws(() => tools.link({ from: id, to: found.records[0].id, type: 'depends_on', evidence: [labels[0].ref], support: 'explicit' }), /link_alias_not_in_packet/);
  assert.equal(tools.stats().link_aliases.refused_not_in_packet, 1);
});

test('ambiguous or inconsistent bindings fail closed and close the offer', async () => {
  const duplicate = await setup({ references: (records, sources) => ({ records, sources: sources.map(row => ({ ...row, turn: 'turn', entry_id: 'u1', start: 0, end: 20 })) }) });
  await duplicate.tools.offer([duplicate.priorHandles[0]]);
  assert.throws(() => duplicate.tools.link({ from: duplicate.first, to: duplicate.priorHandles[0], type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' }), /link_alias_ambiguous/);
  for (const references of [() => undefined, (records, sources) => ({ records: records.slice(1), sources }),
    (records, sources) => ({ records: records.map((row, i) => i === 0 ? { ...row, id: 'pi-memory-record-other-turn' } : row), sources }),
    (records, sources) => ({ records: records.map(row => ({ ...row, id: records[0].id })), sources })]) {
    const broken = await setup({ references });
    await assert.rejects(broken.tools.offer([broken.priorHandles[0]]), /offer_invalid/);
    assert.equal(broken.calls.at(-1)[0], 'cancel');
    assert.throws(() => broken.tools.link({ from: broken.first, to: broken.priorHandles[0], type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' }), /offer_unavailable/);
  }
});

test('handles outside the open offer still fail as before: unoffered, prior ids, other turns, stale offers', async () => {
  const { tools, calls, priorHandles, first } = await setup();
  await assert.rejects(tools.offer(['pi-memory-record-from-another-turn']), /handle_not_offered/);
  await assert.rejects(tools.offer(['prior-0']), /handle_not_offered/);
  const offered = await tools.offer([priorHandles[0]]);
  const firstLabel = offered.packet.records[[...packetOf(calls)[3]].sort().indexOf(first)].evidence[0];
  assert.throws(() => tools.link({ from: first, to: priorHandles[1], type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' }), /handle_not_offered/);
  assert.throws(() => tools.link({ from: first, to: 'prior-0', type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' }), /handle_not_offered/);
  assert.throws(() => tools.link({ from: first, to: priorHandles[0], type: 'supersedes', evidence: ['ref-000099'], support: 'explicit' }), /handle_not_offered/);
  assert.throws(() => tools.link({ from: first, to: priorHandles[0], type: 'supersedes', evidence: ['A quoted sentence.'], support: 'explicit' }), /handle_not_offered/);
  // An alias and its canonical label for the same span are one piece of evidence, not two.
  assert.throws(() => tools.link({ from: first, to: priorHandles[0], type: 'supersedes', evidence: ['ref-000001', firstLabel], support: 'explicit' }), /link_invalid/);
  await tools.record('observation', 'Fictional later fact.', ['ref-000003']);
  assert.throws(() => tools.link({ from: first, to: priorHandles[0], type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' }), /offer_unavailable/);
});

test('only aliased links are validated when made; canonical-only links keep the deferred baseline check', async () => {
  const { tools, priorHandles, first } = await setup();
  await tools.offer(priorHandles);
  assert.throws(() => tools.link({ from: priorHandles[0], to: priorHandles[1], type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' }), /link_endpoint_not_offered/);
  assert.deepEqual([tools.pendingLinks(), tools.stats().link_aliases.links_aliased], [null, 0]);
  // Canonical labels only: a prior-to-prior link and one citing only earlier-turn evidence are deferred, as on the baseline.
  tools.link({ from: 'r2', to: 'r3', type: 'supersedes', evidence: ['s0'], support: 'explicit' });
  tools.link({ from: 'r0', to: 'r2', type: 'supersedes', evidence: ['s3'], support: 'explicit' });
  // An aliased link is checked on its own, so the deferred ones do not refuse it; repeating a kept link is refused.
  tools.link({ from: first, to: priorHandles[1], type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' });
  assert.throws(() => tools.link({ from: first, to: priorHandles[1], type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' }), /duplicate_link_proposal/);
  assert.deepEqual([pending(tools).length, tools.stats().link_aliases.links_aliased], [3, 1]);
});

test('the client forwards the bindings request unchanged, so the Memory process can refuse a non-true value', async () => {
  const inbound = new PassThrough(), outbound = new PassThrough(), stopped = new AbortController(), seen = [];
  const server = serve({ input: inbound, output: outbound, signal: stopped.signal, handlers: {
    async beginLinks(args) { seen.push(Object.hasOwn(args, 'with_references') ? args.with_references : 'absent'); return { token: 't', packet: {} }; } } });
  const client = createMemoryClient({ input: outbound, output: inbound, timeoutMs: 1000 });
  try {
    for (const withReferences of [undefined, true, false, 'yes', 1, null]) await client.beginLinks('fiction', 'turn', ['record'], { withReferences });
    await client.beginLinks('fiction', 'turn', ['record']);
    assert.deepEqual(seen, ['absent', true, false, 'yes', 1, null, 'absent']);
  } finally { client.close(); stopped.abort(); inbound.end(); outbound.end(); await server; }
});

test('without the treatment, held handles are refused exactly as before and no bindings are requested', async () => {
  const { tools, calls, priorHandles, first } = await setup({ linkAliases: null });
  await assert.rejects(tools.offer([first, priorHandles[0]]), /handle_not_offered/);
  await tools.offer(priorHandles);
  assert.deepEqual(packetOf(calls)[4], { candidateHandles: priorHandles });
  assert.throws(() => tools.link({ from: first, to: 'r2', type: 'supersedes', evidence: ['s0'], support: 'explicit' }), /handle_not_offered/);
  assert.throws(() => tools.link({ from: 'r0', to: priorHandles[0], type: 'supersedes', evidence: ['s0'], support: 'explicit' }), /handle_not_offered/);
  assert.throws(() => tools.link({ from: 'r0', to: 'r2', type: 'supersedes', evidence: ['ref-000001'], support: 'explicit' }), /handle_not_offered/);
  // A prior-to-prior link is still deferred to the Memory process without the treatment.
  tools.link({ from: 'r2', to: 'r3', type: 'supersedes', evidence: ['s0'], support: 'explicit' });
  assert.equal(Object.hasOwn(tools.stats(), 'link_aliases'), false);
  assert.throws(() => createTurnTools({ scope: 'fiction', turn, receipt: { id: 'turn' }, memory: {}, linkAliases: 'other' }), /invalid_input/);
});

test('the treated distiller keeps the baseline prompt, tools and descriptions and records one alias row', async () => {
  const base = await distillerSurface(createPiDistiller, { scripts: baselineScripts, reviewer: approvingReviewer });
  const memory = surfaceMemory();
  const beginLinks = memory.beginLinks;
  memory.beginLinks = async (...args) => {
    const result = await beginLinks(...args);
    return { ...result, references: { records: result.packet.records.map(row => ({ ref: row.ref, id: row.newly_retained ? args[2][0] : `prior-${row.ref}` })),
      sources: result.packet.sources.map((row, i) => ({ ref: row.ref, turn: i ? `earlier-${i}` : 'turn', entry_id: 'u', start: 0, end: 55 })) } };
  };
  const treated = await distillerSurface(createPiDistiller, { options: { linkAliases: MODE }, scripts: baselineScripts.slice(0, 1), memory, reviewer: approvingReviewer });
  assert.deepEqual([treated.runs[0].prompt, treated.runs[0].tools, treated.registry], [base.runs[0].prompt, base.runs[0].tools, base.registry]);
  assert.deepEqual(treated.runs[0].result.search_limitations.statuses.at(-1), { surface: 'link-aliases', mode: MODE, offer_own_records: 0, links_aliased: 0,
    endpoint_own_record: 0, endpoint_offered_handle: 0, evidence_label: 0, refused_not_in_packet: 0, refused_ambiguous: 0 });
  await assert.rejects(distillerSurface(createPiDistiller, { options: { linkAliases: 'other' }, scripts: [] }), /runtime_invalid/);
});
