import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, canonical, digest, identity, normalizeEnrichment, normalizeTurn, sourceExcerpt, RELATIONS } from '../src/core.mjs';
import { applyReviewedMemoryLinks, LINK_PROPOSAL_CONTRACT, LINK_PROPOSAL_LIMITS,
  memoryLinkProposalState, proposeMemoryLinks } from '../src/link-proposals.mjs';

const SCOPE = 'fictional-link-development';
const REVIEW_CONTRACT = 'fictional-programmatic-policy/v1';
const KINDS = ['decision', 'observation', 'outcome', 'question', 'intention', 'episode', 'action'];
const route = { provider: 'fixture', model: 'deterministic-comparison-not-a-model-run' };
const clone = value => structuredClone(value);

// An inert Memory-shaped double; no Memory/Store/model client is imported or constructed.
function fixtureMemory() {
  const memory = {
    config: { scopes: { read: [SCOPE], write: [SCOPE] } },
    turns: new Map(), records: new Map(), relations: new Map(), calls: [], writes: [], intents: [],
    async ingest(scope, input) {
      authorize(this.config, scope, 'write');
      const turn = normalizeTurn(input), id = identity('turn', scope, turn.source, turn.conversation_id, turn.turn_id);
      this.turns.set(id, { id, scope, ...turn });
      return { id };
    },
    async show(scope, input) {
      authorize(this.config, scope);
      this.calls.push({ method: 'show', scope, input: clone(input) });
      if (input.kind === 'turn') return { kind: 'turn', turn: clone(this.turns.get(input.id)) };
      return { kind: 'record', record: clone(this.records.get(input.id)) };
    },
    async recall(scope, input) {
      authorize(this.config, scope);
      this.calls.push({ method: 'recall', scope, input: clone(input) });
      return { scope, status: 'ready', budget_omitted: 0, retrieval_complete: false,
        relationship_context_complete: true, channels: { chunk_vector: { status: 'unconfigured' } },
        candidate_count: this.records.size, bundles: [{ records: clone([...this.records.values()]),
          relations: [], relationship_context_complete: true, gaps: [] }] };
    },
    async enrich(scope, input) {
      authorize(this.config, scope, 'write');
      const normalized = normalizeEnrichment(input);
      assert.equal(normalized.records.length, 0, 'link application may not create or mutate records');
      for (const edge of normalized.relations) {
        for (const id of [edge.from, edge.to]) assert.equal(this.records.get(id)?.scope, scope);
        for (const span of edge.evidence) {
          const turn = this.turns.get(span.turn);
          assert.equal(turn?.scope, scope);
          sourceExcerpt(turn, span);
        }
        if (edge.type === 'outcome_of') {
          assert.deepEqual([this.records.get(edge.from).kind, this.records.get(edge.to).kind], ['outcome', 'action']);
        }
        const previous = this.relations.get(edge.id);
        if (previous) assert.equal(canonical(previous), canonical(edge));
      }
      for (const edge of normalized.relations) this.relations.set(edge.id, clone(edge));
      this.writes.push({ scope, input: clone(normalized) });
      return { records: [], relations: normalized.relations.map(edge => edge.id) };
    },
  };
  return memory;
}

// Reuse the case/build/facts/latest/elements shape; all rows are newly authored fictional development data.
function makeFixtures(memory, { kind = 'observation', oldKind = 'observation', role = 'user' } = {}) {
  return { cases: [{ id: `LINK-${kind}`, query: 'Which recorded Cedar statement relates to the latest source?',
    build: async scope => {
      const facts = [];
      for (const [index, label] of ['old', 'new'].entries()) {
        const entry = { id: `${label}-entry`, role: label === 'new' ? role : 'user',
          text: label === 'new' ? 'Correction: the Cedar badge reads Éva 🌿, not Eva. This is a recorded request, not a printed badge.'
            : 'The Cedar badge request was recorded as Eva.' };
        const stored = await memory.ingest(scope, { source: 'fictional-link-fixture', conversation_id: 'cedar-work',
          turn_id: label, occurred_at: `2032-01-0${index + 1}T12:00:00.000Z`, entries: [entry],
          ...(index ? { parent_turn_id: 'old' } : { lineage_root: true }) });
        facts.push(stored.id);
        const evidence = [{ turn: stored.id, entry_id: entry.id, start: 0, end: entry.text.length }];
        // These are pre-existing fixture records, not a claim that this module extracts new records/outcomes.
        const record = normalizeEnrichment({ records: [{ id: label, kind: index ? kind : oldKind,
          status: 'proposed', attribution: 'fictional prior extraction, not acceptance', text: entry.text, evidence }], relations: [] }).records[0];
        memory.records.set(label, { scope, ...record });
      }
      return { facts, latest: facts[1], elements: { existing: [facts[0]], newly_retained: [facts[1]] }, record_ids: ['new'] };
    } }] };
}

function proposedLink(packet, { type = 'qualifies', support = 'explicit', evidenceRole } = {}) {
  const from = packet.records.find(row => row.newly_retained), to = packet.records.find(row => !row.newly_retained);
  const evidence = packet.sources.find(row => row.trigger && (!evidenceRole || row.role === evidenceRole));
  return { type, from: from.ref, to: to.ref, evidence: [evidence.ref], support };
}

async function setup(options = {}) {
  const memory = fixtureMemory();
  const item = makeFixtures(memory, options).cases[0];
  const value = await item.build(SCOPE);
  const request = { memory, scope: SCOPE, turn: value.latest, record_ids: value.record_ids, review_contract: REVIEW_CONTRACT,
    before_append: async plan => {
      memory.intents.push(clone(plan));
      return acceptedIntent(plan);
    } };
  return { memory, value, request };
}

const comparison = make => async input => ({ text: JSON.stringify({ links: [make(input.packet)] }), route });
const acceptedIntent = plan => ({ accepted: true, operation_id: plan.operation_id,
  append_sha256: plan.append_sha256, receipt_ref: 'fictional-durable-intent-001' });
const reviewFor = (result, approved = [0]) => ({ contract: LINK_PROPOSAL_CONTRACT, scope: SCOPE,
  review_contract: result.review_contract, operation_id: result.operation_id,
  context_sha256: result.context_sha256, semantic_proposal_sha256: result.semantic_proposal_sha256,
  proposal_sha256: result.proposal_sha256,
  reviewer: REVIEW_CONTRACT, decision_ref: 'fixture-review-001', approved });
const apply = (request, result, review = reviewFor(result), before_append = request.before_append) => applyReviewedMemoryLinks({
  memory: request.memory, scope: request.scope, result, review, before_append, signal: request.signal });

for (const kind of KINDS) {
  test(`link_pipeline_${kind}_retains_existing_kind_and_requires_separate_review`, async () => {
    const { memory, request } = await setup({ kind });
    const original = canonical([...memory.records]);
    let compareInput;
    const result = await proposeMemoryLinks({ ...request, compare: async input => {
      compareInput = input;
      return comparison(packet => proposedLink(packet))(input);
    } });
    const pending = { writes: memory.writes.length, status: result.review_status, semantic_truth: result.semantic_truth };
    const written = await apply(request, result);
    assert.deepEqual({ pending, kind: result.packet.records.find(row => row.newly_retained).kind,
      unchanged: canonical([...memory.records]) === original, append: written.enrichment.records,
      endpoints: written.enrichment.relations.map(row => [row.from, row.to]),
      sameScopes: memory.calls.every(row => row.scope === SCOPE) && memory.writes.every(row => row.scope === SCOPE),
      compareContract: compareInput.contract, desiredOutput: compareInput.desired_output_bytes,
      safetyCeiling: compareInput.output_bytes }, {
      pending: { writes: 0, status: 'pending', semantic_truth: 'NOT_VERIFIED' }, kind, unchanged: true, append: [],
      endpoints: [['new', 'old']], sameScopes: true, compareContract: LINK_PROPOSAL_CONTRACT,
      desiredOutput: 2048, safetyCeiling: 16384 });
  });
}

for (const type of RELATIONS) {
  test(`reviewed_${type}_appends_original_spans_and_model_policy_attribution`, async () => {
    const { request, memory } = await setup(type === 'outcome_of' ? { kind: 'outcome', oldKind: 'action' } : {});
    const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet, { type })) });
    const written = await apply(request, result);
    const edge = written.enrichment.relations[0];
    const span = memory.records.get('new').evidence[0];
    const entry = memory.turns.get(span.turn).entries[0];
    assert.deepEqual({ type: edge.type, evidence: edge.evidence, direction: [edge.from, edge.to],
      modelAttributed: edge.attribution.includes(`${route.provider}/${route.model}`),
      reviewAttributed: edge.attribution.includes('fictional-programmatic-policy/v1'),
      compact: Buffer.byteLength(result.raw_output) < LINK_PROPOSAL_LIMITS.desired_output_bytes,
      unicodeBytesDiffer: Buffer.byteLength(entry.text) !== entry.text.length }, {
      type, evidence: [span], direction: ['new', 'old'], modelAttributed: true, reviewAttributed: true,
      compact: true, unicodeBytesDiffer: true });
  });
}

for (const support of ['ambiguous', 'unsupported', 'chronology_only']) {
  test(`link_${support}_remains_unresolved_without_append`, async () => {
    const { request, memory } = await setup();
    const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet, { support })) });
    const written = await apply(request, result, reviewFor(result, []));
    assert.deepEqual({ proposals: result.proposals.length, reason: result.unresolved[0].reason,
      written: written.status, writes: memory.writes.length }, { proposals: 0, reason: support, written: 'not_written', writes: 0 });
  });
}

test('assistant_only_evidence_remains_an_uncommitted_interpretation', async () => {
  const { request, memory } = await setup({ role: 'assistant' });
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  assert.deepEqual({ proposed: result.proposals.length, assistantOnly: result.unresolved[0].assistant_only,
    reason: result.unresolved[0].reason, writes: memory.writes.length }, {
    proposed: 0, assistantOnly: true, reason: 'source_authority_unestablished', writes: 0 });
});

test('empty_model_delta_does_not_claim_no_other_history_or_write', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: async () => ({ text: '{"links":[]}', route }) });
  assert.deepEqual({ proposals: result.proposals, writes: memory.writes,
    guaranteed: result.packet.retrieval.completeness_guaranteed, channels: result.packet.retrieval.channels }, {
    proposals: [], writes: [], guaranteed: false, channels: { chunk_vector: { status: 'unconfigured' } } });
});

const invalidOutputs = [
  ['invented_record_id', packet => ({ ...proposedLink(packet), from: 'new' }), 'link_endpoint_not_offered'],
  ['invented_span_id', packet => ({ ...proposedLink(packet), evidence: ['unknown-span'] }), 'link_evidence_not_offered'],
  ['model_source_retranscription', packet => ({ ...proposedLink(packet), text: 'Model-authored source' }), 'link_output_shape'],
  ['model_hash', packet => ({ ...proposedLink(packet), sha256: 'invented' }), 'link_output_shape'],
  ['unsupported_relation', packet => ({ ...proposedLink(packet), type: 'answers' }), 'invalid_relation'],
  ['self_relation', packet => { const link = proposedLink(packet); return { ...link, to: link.from }; }, 'link_endpoint_not_offered'],
  ['missing_trigger_evidence', packet => ({ ...proposedLink(packet), evidence: [packet.sources.find(row => !row.trigger).ref] }), 'link_trigger_evidence_required'],
  ['invalid_outcome_endpoints', packet => proposedLink(packet, { type: 'outcome_of' }), 'invalid_outcome_relation'],
];
for (const [name, make, code] of invalidOutputs) {
  test(`proposal_${name}_rejects_entire_delta_without_write`, async () => {
    const { request, memory } = await setup();
    await assert.rejects(proposeMemoryLinks({ ...request, compare: comparison(make) }), { code });
    assert.equal(memory.writes.length, 0);
  });
}

test('duplicate_delta_refuses_without_partial_append', async () => {
  const { request, memory } = await setup();
  await assert.rejects(proposeMemoryLinks({ ...request, compare: async ({ packet }) => {
    const link = proposedLink(packet);
    return { text: JSON.stringify({ links: [link, link] }), route };
  } }), { code: 'duplicate_link_proposal' });
  assert.equal(memory.writes.length, 0);
});

for (const permission of ['read', 'write']) {
  test(`unauthorized_${permission}_scope_never_retrieves_or_compares`, async () => {
    const { request, memory } = await setup();
    memory.config.scopes[permission] = [];
    let compared = false;
    await assert.rejects(proposeMemoryLinks({ ...request, compare: async () => { compared = true; } }), { code: 'scope_denied' });
    assert.deepEqual([memory.calls.length, compared, memory.writes.length], [0, false, 0]);
  });
}

test('foreign_record_hydration_refuses_before_model_egress', async () => {
  const { request, memory } = await setup();
  memory.records.get('old').scope = 'fictional-other-person';
  let compared = false;
  await assert.rejects(proposeMemoryLinks({ ...request, compare: async () => { compared = true; } }), { code: 'link_record_binding_mismatch' });
  assert.deepEqual([compared, memory.writes.length], [false, 0]);
});

test('missing_retained_source_refuses_before_model_egress', async () => {
  const { request, memory, value } = await setup();
  memory.turns.delete(value.facts[0]);
  await assert.rejects(proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) }), { code: 'link_source_binding_mismatch' });
  assert.equal(memory.writes.length, 0);
});

test('known_incomplete_retrieval_stops_comparison', async () => {
  const { request, memory } = await setup();
  memory.recall = async () => ({ scope: SCOPE, status: 'budget_limited', budget_omitted: 1,
    relationship_context_complete: false, bundles: [] });
  await assert.rejects(proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) }), { code: 'link_retrieval_incomplete' });
});

test('known_partial_channel_stops_even_when_overall_status_is_ready', async () => {
  const { request, memory } = await setup();
  const recall = memory.recall.bind(memory);
  memory.recall = async (...args) => ({ ...await recall(...args), channels: { record_vector: { status: 'partial' } } });
  await assert.rejects(proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) }), { code: 'link_retrieval_incomplete' });
});

for (const field of ['contract', 'scope', 'review_contract', 'operation_id', 'context_sha256',
  'semantic_proposal_sha256', 'proposal_sha256']) {
  test(`review_changed_${field}_cannot_authorize_append`, async () => {
    const { request, memory } = await setup();
    const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
    const review = { ...reviewFor(result), [field]: 'different' };
    await assert.rejects(apply(request, result, review), { code: 'link_review_required' });
    assert.equal(memory.writes.length, 0);
  });
}

test('serialized_or_forged_result_is_not_an_apply_capability', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  await assert.rejects(apply(request, JSON.parse(JSON.stringify(result))), { code: 'link_plan_binding_mismatch' });
  assert.equal(memory.writes.length, 0);
});

test('changed_record_after_comparison_refuses_all_appends', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  memory.records.get('old').text = 'Changed record interpretation.';
  await assert.rejects(apply(request, result), { code: 'link_record_changed' });
  assert.equal(memory.writes.length, 0);
});

test('changed_source_after_comparison_refuses_all_appends', async () => {
  const { request, memory, value } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  memory.turns.get(value.facts[0]).entries[0].text += ' changed';
  await assert.rejects(apply(request, result), { code: 'link_source_changed' });
  assert.equal(memory.writes.length, 0);
});

test('mixed_valid_invalid_review_selection_cannot_partially_write', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  await assert.rejects(apply(request, result, reviewFor(result, [0, 99])), { code: 'invalid_input' });
  assert.equal(memory.writes.length, 0);
});

test('same_review_replay_uses_the_same_host_assigned_relation_identity', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  const first = await apply(request, result), second = await apply(request, result);
  assert.deepEqual([first.enrichment, memory.relations.size], [second.enrichment, 1]);
});

for (const stage of ['retrieval', 'comparison', 'before_append']) {
  test(`cancellation_${stage}_prevents_append`, async () => {
    const { request, memory } = await setup();
    const controller = new AbortController();
    request.signal = controller.signal;
    const recall = memory.recall.bind(memory), show = memory.show.bind(memory);
    memory.recall = async (...args) => { const out = await recall(...args); if (stage === 'retrieval') controller.abort(); return out; };
    const compare = async input => {
      if (stage === 'comparison') controller.abort();
      return comparison(packet => proposedLink(packet))(input);
    };
    if (stage === 'before_append') {
      const result = await proposeMemoryLinks({ ...request, compare });
      memory.show = async (...args) => { const out = await show(...args); controller.abort(); return out; };
      await assert.rejects(apply(request, result), { code: 'link_proposal_aborted' });
    } else await assert.rejects(proposeMemoryLinks({ ...request, compare }), { code: 'link_proposal_aborted' });
    assert.equal(memory.writes.length, 0);
  });
}

test('comparison_controller_failure_does_not_write_or_reroute', async () => {
  const { request, memory } = await setup();
  let attempts = 0;
  await assert.rejects(proposeMemoryLinks({ ...request, compare: async () => { attempts++; throw new Error('fictional_controller_closed'); } }), /fictional_controller_closed/);
  assert.deepEqual([attempts, memory.writes.length], [1, 0]);
});

test('model_output_over_safety_ceiling_is_rejected', async () => {
  const { request } = await setup();
  await assert.rejects(proposeMemoryLinks({ ...request, compare: async () => ({ text: ' '.repeat(16385), route }) }), { code: 'link_output_too_large' });
});

test('candidate_count_bound_refuses_before_comparison', async () => {
  const { request, memory } = await setup();
  const original = memory.records.get('old');
  for (let index = 0; index < 32; index++) memory.records.set(`extra-${index}`, { ...clone(original), id: `extra-${index}` });
  await assert.rejects(proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) }), { code: 'link_candidate_bound' });
});

test('model_prompt_bound_refuses_without_silent_source_truncation', async () => {
  const { request, memory } = await setup();
  const original = memory.records.get('old');
  for (let index = 0; index < 8; index++) memory.records.set(`large-${index}`, {
    ...clone(original), id: `large-${index}`, text: 'fictional '.repeat(1500) });
  await assert.rejects(proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) }), { code: 'link_prompt_bound' });
});

test('evidence_span_count_bound_refuses_before_comparison', async () => {
  const { request, memory, value } = await setup();
  const source = memory.turns.get(value.facts[0]);
  source.entries = Array.from({ length: 129 }, (_, index) => ({ id: `span-${index}`, role: 'user',
    text: `Fictional separate source span ${index}.`, occurred_at: null }));
  memory.records.delete('old');
  for (let index = 0; index < 9; index++) {
    const entries = source.entries.slice(index * 16, (index + 1) * 16);
    memory.records.set(`span-record-${index}`, { id: `span-record-${index}`, scope: SCOPE,
      kind: 'observation', status: 'proposed', attribution: 'fictional extraction', text: 'Separate retained source spans.',
      evidence: entries.map(entry => ({ turn: source.id, entry_id: entry.id, start: 0, end: entry.text.length })) });
  }
  await assert.rejects(proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) }), { code: 'link_evidence_bound' });
});

test('source_turn_count_bound_refuses_before_comparison', async () => {
  const { request, memory } = await setup();
  memory.records.delete('old');
  for (let record = 0; record < 8; record++) {
    const evidence = [];
    for (let index = 0; index < 16; index++) {
      const stored = await memory.ingest(SCOPE, { source: 'fictional-source-bound', conversation_id: `c-${record}-${index}`,
        turn_id: 'root', lineage_root: true, entries: [{ id: 'u', role: 'user', text: 'Fictional bounded source.' }] });
      evidence.push({ turn: stored.id, entry_id: 'u', start: 0, end: 25 });
    }
    memory.records.set(`many-turns-${record}`, { id: `many-turns-${record}`, scope: SCOPE,
      kind: 'observation', status: 'proposed', attribution: 'fictional extraction', text: 'Many separate retained sources.', evidence });
  }
  await assert.rejects(proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) }), { code: 'link_source_bound' });
});

test('relation_evidence_aggregate_cannot_exceed_store_bound', async () => {
  const { request, memory, value } = await setup();
  const old = memory.turns.get(value.facts[0]), recent = memory.turns.get(value.latest);
  old.entries = [0, 1].map(index => ({ id: `long-${index}`, role: 'user', text: 'x'.repeat(12000), occurred_at: null }));
  recent.entries[0].text = 'y'.repeat(12000);
  memory.records.get('old').evidence = old.entries.map(entry => ({ turn: old.id, entry_id: entry.id, start: 0, end: entry.text.length }));
  memory.records.get('new').evidence[0].end = 12000;
  await assert.rejects(proposeMemoryLinks({ ...request, compare: async ({ packet }) => ({
    text: JSON.stringify({ links: [{ ...proposedLink(packet), evidence: packet.sources.map(row => row.ref) }] }), route }) }), { code: 'evidence_too_large' });
});

test('model_proposal_count_bound_refuses_entire_output', async () => {
  const { request } = await setup();
  await assert.rejects(proposeMemoryLinks({ ...request, compare: async ({ packet }) => ({
    text: JSON.stringify({ links: Array.from({ length: 17 }, () => proposedLink(packet)) }), route }) }), { code: 'link_output_shape' });
});

test('host_reference_tables_and_pending_result_are_serializable_not_model_authored', async () => {
  const { request } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  const serialized = JSON.parse(JSON.stringify(result));
  assert.deepEqual({ recordIds: serialized.references.records.map(row => row.id).sort(),
    validSourceHandles: serialized.references.sources.every(row => /^s\d+$/.test(row.ref) && row.turn.startsWith('turn_')),
    outputKeys: Object.keys(JSON.parse(serialized.raw_output)).sort(),
    frozen: Object.isFrozen(result) && Object.isFrozen(result.proposals),
    semanticTruth: serialized.semantic_truth }, {
    recordIds: ['new', 'old'], validSourceHandles: true, outputKeys: ['links'], frozen: true, semanticTruth: 'NOT_VERIFIED' });
});

test('canonical_operation_and_edges_ignore_model_order_format_route_and_review_labels', async () => {
  const { request, memory } = await setup();
  memory.records.set('new-extra', { ...clone(memory.records.get('new')), id: 'new-extra' });
  request.record_ids = ['new', 'new-extra'];
  const make = packet => {
    const link = proposedLink(packet);
    const evidence = packet.sources.map(row => row.ref);
    return [{ ...link, evidence }, { ...link, type: 'contradicts', evidence }];
  };
  const first = await proposeMemoryLinks({ ...request, compare: async ({ packet }) => ({
    text: JSON.stringify({ links: make(packet) }), route }) });
  request.record_ids.reverse();
  memory.records = new Map([...memory.records].reverse());
  const second = await proposeMemoryLinks({ ...request, compare: async ({ packet }) => ({
    text: JSON.stringify({ links: make(packet).reverse().map(row => ({ support: row.support,
      evidence: [...row.evidence].reverse(), to: row.to, from: row.from, type: row.type })) }, null, 2),
    route: { provider: 'different-fixture-provider', model: 'another-synthetic-attempt' } }) });
  const plans = [];
  const refuse = async plan => { plans.push(clone(plan)); return { ...acceptedIntent(plan), accepted: false }; };
  await assert.rejects(apply(request, first, reviewFor(first, [0, 1]), refuse), { code: 'link_append_preparation_refused' });
  await assert.rejects(apply(request, second, { ...reviewFor(second, [1, 0]),
    reviewer: 'different-arbitrary-review-label', decision_ref: 'different-attempt-label' }, refuse), { code: 'link_append_preparation_refused' });
  assert.deepEqual({ contextStable: first.context_sha256 === second.context_sha256,
    semanticStable: first.semantic_proposal_sha256 === second.semantic_proposal_sha256,
    operationStable: first.operation_id === second.operation_id, rawDifferent: first.proposal_sha256 !== second.proposal_sha256,
    edgeIdsStable: canonical(plans[0].edge_ids) === canonical(plans[1].edge_ids),
    exactMetadataDifferent: plans[0].append_sha256 !== plans[1].append_sha256, writes: memory.writes.length }, {
    contextStable: true, semanticStable: true, operationStable: true, rawDifferent: true,
    edgeIdsStable: true, exactMetadataDifferent: true, writes: 0 });
});

test('changed_semantic_proposal_changes_operation_and_edge_identity', async () => {
  const { request } = await setup();
  const first = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  const second = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet, { type: 'contradicts' })) });
  const plans = [];
  const refuse = async plan => { plans.push(clone(plan)); return { ...acceptedIntent(plan), accepted: false }; };
  for (const result of [first, second]) {
    await assert.rejects(apply(request, result, reviewFor(result), refuse), { code: 'link_append_preparation_refused' });
  }
  assert.deepEqual([first.context_sha256 === second.context_sha256,
    first.semantic_proposal_sha256 !== second.semantic_proposal_sha256,
    first.operation_id !== second.operation_id, plans[0].edge_ids[0] !== plans[1].edge_ids[0]], [true, true, true, true]);
});

test('review_contract_version_is_part_of_the_operation_and_edge_identity', async () => {
  const { request } = await setup();
  const compare = comparison(packet => proposedLink(packet));
  const first = await proposeMemoryLinks({ ...request, compare });
  const second = await proposeMemoryLinks({ ...request, review_contract: 'fictional-programmatic-policy/v2', compare });
  const plans = [];
  const refuse = async plan => { plans.push(clone(plan)); return { ...acceptedIntent(plan), accepted: false }; };
  for (const result of [first, second]) {
    await assert.rejects(apply(request, result, reviewFor(result), refuse), { code: 'link_append_preparation_refused' });
  }
  assert.deepEqual([first.context_sha256 === second.context_sha256,
    first.semantic_proposal_sha256 === second.semantic_proposal_sha256,
    first.operation_id !== second.operation_id, plans[0].edge_ids[0] !== plans[1].edge_ids[0]], [true, true, true, true]);
});

test('concurrent_apply_claims_capability_synchronously_and_appends_once', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let callbacks = 0;
  const before = async plan => { callbacks++; await gate; return acceptedIntent(plan); };
  const first = apply(request, result, reviewFor(result), before);
  try {
    assert.equal(memoryLinkProposalState(result).state, 'applying');
    await assert.rejects(apply(request, result, reviewFor(result), before), { code: 'link_append_in_progress' });
    release();
    await first;
  } finally { release(); }
  assert.deepEqual([memoryLinkProposalState(result).state, callbacks, memory.writes.length], ['committed', 1, 1]);
});

for (const failure of ['refused', 'throws', 'wrong_operation', 'wrong_payload', 'ambiguous']) {
  test(`durable_callback_${failure}_cannot_invoke_enrichment`, async () => {
    const { request, memory } = await setup();
    const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
    const before = async plan => {
      if (failure === 'throws') throw new Error('fictional-durability-uncertain');
      const ack = acceptedIntent(plan);
      if (failure === 'refused') ack.accepted = false;
      if (failure === 'wrong_operation') ack.operation_id = 'another-operation';
      if (failure === 'wrong_payload') ack.append_sha256 = 'another-payload';
      if (failure === 'ambiguous') ack.unknown = true;
      return ack;
    };
    await assert.rejects(apply(request, result, reviewFor(result), before));
    const state = memoryLinkProposalState(result);
    assert.deepEqual([state.state, state.enrichment_invoked, memory.writes.length], ['pending', false, 0]);
  });
}

test('missing_durable_callback_cannot_append', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  await assert.rejects(apply(request, result, reviewFor(result), null), { code: 'link_append_preparation_required' });
  assert.deepEqual([memoryLinkProposalState(result).state, memory.writes.length], ['pending', 0]);
});

test('durable_callback_observes_frozen_exact_plan_before_any_store_write', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  let observed;
  await apply(request, result, reviewFor(result), async plan => {
    observed = { state: memoryLinkProposalState(result).state, writes: memory.writes.length,
      frozen: Object.isFrozen(plan) && Object.isFrozen(plan.enrichment.relations),
      exactBytes: canonical(plan.enrichment) === plan.enrichment_json,
      exactHash: digest(plan.enrichment_json) === plan.append_sha256,
      exactIds: canonical(plan.edge_ids) === canonical(plan.enrichment.relations.map(row => row.id)) };
    return acceptedIntent(plan);
  });
  assert.deepEqual(observed, { state: 'applying', writes: 0, frozen: true, exactBytes: true, exactHash: true, exactIds: true });
});

test('accepted_intent_then_cancel_is_proved_uninvoked_and_cannot_change_frozen_payload', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  const controller = new AbortController();
  request.signal = controller.signal;
  await assert.rejects(apply(request, result, reviewFor(result), async plan => {
    controller.abort();
    return acceptedIntent(plan);
  }), { code: 'link_proposal_aborted' });
  const state = memoryLinkProposalState(result);
  request.signal = new AbortController().signal;
  await assert.rejects(apply(request, result, { ...reviewFor(result), decision_ref: 'changed-after-intent' }),
    { code: 'link_prepared_payload_changed' });
  assert.deepEqual([state.state, state.enrichment_invoked, state.receipt_ref, memory.writes.length],
    ['pending', false, 'fictional-durable-intent-001', 0]);
});

test('committed_receipt_replay_does_not_compare_prepare_or_append_again', async () => {
  const { request, memory } = await setup();
  let comparisons = 0;
  const result = await proposeMemoryLinks({ ...request, compare: async input => {
    comparisons++;
    return comparison(packet => proposedLink(packet))(input);
  } });
  const first = await apply(request, result);
  const second = await apply(request, result, { ...reviewFor(result), decision_ref: 'arbitrary-retry-label' }, null);
  assert.deepEqual({ state: memoryLinkProposalState(result).state, comparisons, intents: memory.intents.length,
    writes: memory.writes.length, replayed: second.replayed, sameReceipt: canonical(first.receipt) === canonical(second.receipt),
    originalReview: second.review.decision_ref }, {
    state: 'committed', comparisons: 1, intents: 1, writes: 1, replayed: true, sameReceipt: true, originalReview: 'fixture-review-001' });
});

for (const effectBeforeError of [false, true]) {
  test(`enrich_error_${effectBeforeError ? 'after' : 'before'}_observed_effect_holds_unknown_without_retry`, async () => {
    const { request, memory } = await setup();
    const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
    const enrich = memory.enrich.bind(memory);
    let invocations = 0;
    memory.enrich = async (...args) => {
      invocations++;
      if (effectBeforeError) await enrich(...args);
      throw new Error('fictional-lost-receipt');
    };
    await assert.rejects(apply(request, result), { code: 'link_append_unknown' });
    await assert.rejects(apply(request, result, { ...reviewFor(result), decision_ref: 'fresh-retry-label' }),
      { code: 'link_append_unknown' });
    const state = memoryLinkProposalState(result);
    assert.deepEqual([state.state, state.enrichment_invoked, invocations, memory.intents.length, memory.writes.length],
      ['unknown', true, 1, 1, effectBeforeError ? 1 : 0]);
  });
}

for (const mismatch of ['records', 'missing', 'extra', 'duplicate', 'false_ok', 'ambiguous_status',
  'null_ok', 'zero_ok', 'string_ok', 'undefined_ok', 'array_envelope', 'null_envelope', 'non_plain_envelope']) {
  test(`ambiguous_append_receipt_${mismatch}_is_terminal_unknown`, async () => {
    const { request, memory } = await setup();
    const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
    const enrich = memory.enrich.bind(memory);
    memory.enrich = async (...args) => {
      const receipt = await enrich(...args);
      if (mismatch === 'records') receipt.records.push('unexpected-record');
      if (mismatch === 'missing') receipt.relations = [];
      if (mismatch === 'extra') receipt.relations.push('unexpected-edge');
      if (mismatch === 'duplicate') receipt.relations.push(receipt.relations[0]);
      if (mismatch === 'false_ok') receipt.ok = false;
      if (mismatch === 'ambiguous_status') receipt.status = 'unknown';
      if (mismatch === 'null_ok') receipt.ok = null;
      if (mismatch === 'zero_ok') receipt.ok = 0;
      if (mismatch === 'string_ok') receipt.ok = 'x';
      if (mismatch === 'undefined_ok') receipt.ok = undefined;
      if (mismatch === 'array_envelope') return Object.assign([], receipt);
      if (mismatch === 'null_envelope') return null;
      if (mismatch === 'non_plain_envelope') return Object.assign(Object.create({ fictional: true }), receipt);
      return receipt;
    };
    await assert.rejects(apply(request, result), { code: 'link_append_unknown' });
    assert.deepEqual([memoryLinkProposalState(result).state, memory.writes.length], ['unknown', 1]);
  });
}

test('known_append_receipt_with_deferred_or_unavailable_indexing_still_commits', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  const enrich = memory.enrich.bind(memory);
  memory.enrich = async (...args) => ({ ...await enrich(...args), ok: true,
    indexing: { status: 'unavailable', reason: 'fictional_index_only_outage' } });
  const written = await apply(request, result);
  assert.deepEqual([written.state, memoryLinkProposalState(result).state, memory.writes.length], ['committed', 'committed', 1]);
});

test('a_consumed_result_cannot_commit_a_different_approved_selection', async () => {
  const { request, memory } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  await apply(request, result);
  await assert.rejects(apply(request, result, reviewFor(result, [])), { code: 'link_result_consumed' });
  assert.equal(memory.writes.length, 1);
});

test('state_readback_is_read_only_and_not_a_serialized_write_capability', async () => {
  const { request } = await setup();
  const result = await proposeMemoryLinks({ ...request, compare: comparison(packet => proposedLink(packet)) });
  const state = memoryLinkProposalState(result);
  assert.throws(() => { state.state = 'committed'; }, TypeError);
  assert.throws(() => memoryLinkProposalState(JSON.parse(JSON.stringify(result))), { code: 'link_plan_binding_mismatch' });
  assert.equal(memoryLinkProposalState(result).state, 'pending');
});
