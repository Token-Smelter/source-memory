import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareDevelopmentCases, verifyToolCallReview, toolCallReviewSummary, BLOCK_EVIDENCE_CONTRACT } from '../pi-extension/evaluation/dev-dataset.mjs';
import { validatePacket } from '../pi-extension/evaluation/scorer.mjs';

const source = 'a'.repeat(64), context = 'b'.repeat(64), ancestry = 'c'.repeat(64), time = '2030-01-01T00:00:00Z';
const manifestSha = 'd'.repeat(64), reviewSha = 'e'.repeat(64);
const content = [
  { type: 'text', text: 'Fictional first block.' },
  { type: 'thinking', thinking: 'Private fictional reasoning.' },
  { type: 'text', text: 'Fictional third block.' },
  { type: 'toolCall', name: 'fiction_tool', arguments: { setting: 'amber' } },
  { type: 'toolCall', name: 'other_tool', arguments: { setting: 'unselected' } },
  { type: 'image', data: 'AAAA', mimeType: 'image/png' },
];
const ref = indices => ({ source_key: 'session', source_sha256: source, entry_id: 'u', scope: 'scope', availability_time: time,
  origin_class: 'fiction', citable_content_block_indices: indices });

function fixture({ requirementIndices = [0], chainIndices = null, review = undefined } = {}) {
  const item = { split: 'development', case_id: 'fiction', request: 'Question', actor: { id: 'actor' }, query_time: time,
    read_scopes: ['scope'], evidence_resolution_permissions: { returned_items_only: true, scopes: ['scope'] },
    pre_answer_store_snapshot: { source_key: 'session', source_sha256: source, through_entry_id: 'u', context_ancestry_sha256: ancestry },
    selection_provenance: { candidate_outputs_used_for_selection: false, reference_catalog_used_for_selection: false },
    semantic_review: { review_sha256: reviewSha, verdict: 'keep', corrections_applied: [] },
    answer_action_requirements: [{ id: 'requirement', text: 'Secret expected answer', source_evidence: [ref(requirementIndices)] }],
    acceptable_uncertainty: ['unknown'], answerable_under_declared_conditions: true, alternative_supported_answers: [],
    forbidden_unsupported_claims_or_actions: [], history_group_id: 'group',
    correction_chains: chainIndices ? [{ stage: 'fictional stage', source_evidence: [ref(chainIndices)] }] : [] };
  return { cases: [item], proofs: [{ case_id: 'fiction', source_key: 'session', through_entry_id: 'u', context_messages_sha256: context,
    ancestry_sha256: ancestry, query_time: time, context_entry_ids: ['u'] }],
    verified: [{ through_entry_id: 'u', source_sha256: source, context_messages_sha256: context }],
    entries: [{ id: 'u', message: { role: 'assistant', content: structuredClone(content) } }],
    availability: [{ source_key: 'session', entry_id: 'u', original_evidence_candidate: true, availability_status: 'known_eligible_own_source_actor', availability_time: time }],
    sourceKey: 'session', scope: 'scope', sourceSha256: source, ...(review === undefined ? {} : { toolCallReview: review }) };
}
function reviewMap(occurrences) {
  const value = { schema: 'source-memory-dev-v2-block-evidence-metadata/v1', development_manifest_sha256: manifestSha,
    source_review_sha256: reviewSha, selected_toolcall_occurrences: occurrences, contains_case_text_or_answers: false };
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}
const occurrence = (indices, toolIndex, locationType = 'requirement', locationId = 'requirement') => ({ case_id: 'fiction',
  location_type: locationType, location_id: locationId, source_key: 'session', entry_id: 'u', selected_indices: indices,
  selected_toolcall_index: toolIndex, scope: 'scope', source_sha256: source });
const verify = map => verifyToolCallReview({ bytes: map.bytes, expectedSha256: map.sha, datasetManifestSha256: manifestSha, sourceReviewSha256: reviewSha });

test('answerer case receives no labels and scorer evidence is exactly the selected block', () => {
  const [result] = prepareDevelopmentCases(fixture());
  assert.deepEqual([JSON.stringify(result.publicCase).includes('Secret expected answer'), result.packet.requirements[0].text,
    result.packet.sources.map(row => row.text), result.packet.evidenceContract], [false, 'Secret expected answer', ['Fictional first block.'], BLOCK_EVIDENCE_CONTRACT]);
  validatePacket(result.packet);
});

test('distinct selections from one entry have distinct identities and no unselected text', () => {
  const [first] = prepareDevelopmentCases(fixture({ requirementIndices: [0] }));
  const [third] = prepareDevelopmentCases(fixture({ requirementIndices: [2] }));
  const [both] = prepareDevelopmentCases(fixture({ requirementIndices: [2, 0] }));
  assert.notEqual(first.packet.sources[0].id, third.packet.sources[0].id);
  assert.notEqual(both.packet.sources[0].id, first.packet.sources[0].id);
  assert.deepEqual([third.packet.sources[0].text, both.packet.sources[0].text], ['Fictional third block.', 'Fictional first block.\nFictional third block.']);
  assert.ok(!JSON.stringify(both.packet).includes('Private fictional reasoning'));
});

test('the same exact selection in a requirement and correction chain shares one source identity', () => {
  const [result] = prepareDevelopmentCases(fixture({ requirementIndices: [0], chainIndices: [0] }));
  assert.deepEqual([result.packet.sources.length, result.packet.correctionChains[0].sourceIds, result.packet.correctionChains[0].stage],
    [1, result.packet.requirements[0].sourceIds, 'fictional stage']);
  validatePacket(result.packet);
});

test('correction chains are resolved to their own block-scoped evidence', () => {
  const [result] = prepareDevelopmentCases(fixture({ requirementIndices: [0], chainIndices: [2] }));
  const chainSource = result.packet.sources.find(row => row.id === result.packet.correctionChains[0].sourceIds[0]);
  assert.equal(chainSource.text, 'Fictional third block.');
});

for (const [name, indices] of [['missing', undefined], ['null', null], ['empty', []], ['duplicate', [0, 0]], ['fractional', [0.5]],
  ['string', ['0']], ['negative', [-1]], ['out-of-range', [6]]]) {
  test(`${name} block indices are refused`, () => {
    const input = fixture({ requirementIndices: indices });
    if (indices === undefined) delete input.cases[0].answer_action_requirements[0].source_evidence[0].citable_content_block_indices;
    assert.throws(() => prepareDevelopmentCases(input), /evidence_indices_invalid/);
  });
}

for (const [name, index] of [['thinking', 1], ['image', 5]]) test(`${name} blocks are never citable`, () => {
  assert.throws(() => prepareDevelopmentCases(fixture({ requirementIndices: [0, index] })), /evidence_block_forbidden/);
});

test('invalid correction-chain indices are refused', () => {
  assert.throws(() => prepareDevelopmentCases(fixture({ chainIndices: [] })), /evidence_indices_invalid/);
});

test('a reviewed selected tool call contributes only its own arguments', () => {
  const review = verify(reviewMap([occurrence([2, 3], 3)]));
  const [result] = prepareDevelopmentCases(fixture({ requirementIndices: [2, 3], review }));
  assert.equal(result.packet.sources[0].text, 'Fictional third block.\nfiction_tool {"setting":"amber"}');
  assert.ok(!JSON.stringify(result.packet).includes('unselected'));
  assert.deepEqual([toolCallReviewSummary(review).approved, toolCallReviewSummary(review).used], [1, 1]);
});

test('tool-call evidence fails closed without exact review provenance', () => {
  assert.throws(() => prepareDevelopmentCases(fixture({ requirementIndices: [3] })), /toolcall_review_unverified/);
  const otherSet = verify(reviewMap([occurrence([2, 3], 3)]));
  assert.throws(() => prepareDevelopmentCases(fixture({ requirementIndices: [3], review: otherSet })), /toolcall_review_unverified/);
  const otherLocation = verify(reviewMap([occurrence([3], 3, 'correction_chain', 0)]));
  assert.throws(() => prepareDevelopmentCases(fixture({ requirementIndices: [3], review: otherLocation })), /toolcall_review_unverified/);
  const exact = verify(reviewMap([occurrence([3], 3)]));
  const input = fixture({ requirementIndices: [3], review: exact });
  input.cases[0].semantic_review.verdict = 'revise';
  assert.throws(() => prepareDevelopmentCases(input), /toolcall_review_unverified/);
  assert.equal(toolCallReviewSummary(exact).used, 0);
});

test('a forged, rebound or tampered review map is refused', () => {
  const map = reviewMap([occurrence([3], 3)]);
  assert.throws(() => verifyToolCallReview({ bytes: map.bytes, expectedSha256: 'f'.repeat(64), datasetManifestSha256: manifestSha,
    sourceReviewSha256: reviewSha }), /toolcall_review_unverified/);
  assert.throws(() => verifyToolCallReview({ bytes: map.bytes, expectedSha256: map.sha, datasetManifestSha256: 'f'.repeat(64),
    sourceReviewSha256: reviewSha }), /toolcall_review_unverified/);
  const bad = reviewMap([occurrence([2], 3)]);
  assert.throws(() => verify(bad), /toolcall_review_unverified/);
  assert.throws(() => prepareDevelopmentCases(fixture({ requirementIndices: [3], review: { ...verify(map) } })), /dataset_invalid/);
});

test('evidence outside the verified checkpoint ancestry is refused', () => {
  const input = fixture();
  input.proofs[0].context_entry_ids = [];
  assert.throws(() => prepareDevelopmentCases(input), /evidence_unverified/);
});
