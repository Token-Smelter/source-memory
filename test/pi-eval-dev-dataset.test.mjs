import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDevelopmentCases } from '../pi-extension/evaluation/dev-dataset.mjs';

function fixture() {
  const source = 'a'.repeat(64), context = 'b'.repeat(64), ancestry = 'c'.repeat(64), time = '2030-01-01T00:00:00Z';
  const item = { split: 'development', case_id: 'fiction', request: 'Question', actor: { id: 'actor' }, query_time: time,
    read_scopes: ['scope'], evidence_resolution_permissions: { returned_items_only: true, scopes: ['scope'] },
    pre_answer_store_snapshot: { source_key: 'session', source_sha256: source, through_entry_id: 'u', context_ancestry_sha256: ancestry },
    selection_provenance: { candidate_outputs_used_for_selection: false, reference_catalog_used_for_selection: false },
    answer_action_requirements: [{ id: 'requirement', text: 'Secret expected answer', source_evidence: [{ source_key: 'session', source_sha256: source,
      entry_id: 'u', scope: 'scope', availability_time: time }] }], acceptable_uncertainty: ['unknown'],
    answerable_under_declared_conditions: true, alternative_supported_answers: [], forbidden_unsupported_claims_or_actions: [], correction_chains: [], history_group_id: 'group' };
  return { cases: [item], proofs: [{ case_id: 'fiction', source_key: 'session', through_entry_id: 'u', context_messages_sha256: context,
    ancestry_sha256: ancestry, query_time: time, context_entry_ids: ['u'] }],
    verified: [{ through_entry_id: 'u', source_sha256: source, context_messages_sha256: context }],
    entries: [{ id: 'u', message: { role: 'user', content: 'fictional source evidence' } }],
    availability: [{ source_key: 'session', entry_id: 'u', original_evidence_candidate: true, availability_status: 'known_eligible_own_source_actor', availability_time: time }],
    sourceKey: 'session', scope: 'scope', sourceSha256: source };
}

test('development conversion keeps labels and source evidence out of the answerer case', () => {
  const [result] = prepareDevelopmentCases(fixture());
  assert.deepEqual([JSON.stringify(result.publicCase).includes('Secret expected answer'), result.packet.requirements[0].text,
    result.packet.sources[0].text], [false, 'Secret expected answer', 'fictional source evidence']);
});

test('development conversion refuses evidence outside the verified checkpoint ancestry', () => {
  const input = fixture();
  input.proofs[0].context_entry_ids = [];
  assert.throws(() => prepareDevelopmentCases(input), /evidence_unverified/);
});
