import { entryText } from '../core.mjs';
import { hash } from './seal.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** Convert frozen development cases into disjoint answerer inputs and scorer-only source packets. */
export function prepareDevelopmentCases({ cases, proofs, verified, entries, availability, sourceKey, scope, sourceSha256 }) {
  if (!Array.isArray(cases) || !Array.isArray(proofs) || !Array.isArray(verified) || !Array.isArray(entries)
    || !Array.isArray(availability) || typeof sourceKey !== 'string' || typeof scope !== 'string') throw fail('dataset_invalid');
  const source = new Map(entries.map(row => [row.id, row]));
  const available = new Map(availability.filter(row => row.source_key === sourceKey).map(row => [row.entry_id, row]));
  const selected = cases.filter(row => row?.split === 'development' && row.pre_answer_store_snapshot?.source_key === sourceKey);
  if (!selected.length) throw fail('cases_unavailable');
  return selected.map(item => {
    const checkpoint = item.pre_answer_store_snapshot;
    const proof = proofs.find(row => row.case_id === item.case_id && row.source_key === sourceKey);
    if (!proof || !verified.some(row => row.through_entry_id === checkpoint.through_entry_id && row.source_sha256 === sourceSha256
      && row.context_messages_sha256 === proof.context_messages_sha256)
      || checkpoint.source_sha256 !== sourceSha256 || checkpoint.through_entry_id !== proof.through_entry_id
      || checkpoint.context_ancestry_sha256 !== proof.ancestry_sha256 || item.query_time !== proof.query_time
      || item.selection_provenance?.candidate_outputs_used_for_selection !== false
      || item.selection_provenance?.reference_catalog_used_for_selection !== false
      || item.evidence_resolution_permissions?.returned_items_only !== true || !item.read_scopes?.includes(scope)
      || !item.evidence_resolution_permissions.scopes?.includes(scope)) throw fail('case_unverified');
    const evidence = new Map();
    const requirements = item.answer_action_requirements.map(req => {
      if (!req?.id || !req.text || !Array.isArray(req.source_evidence) || !req.source_evidence.length) throw fail('case_invalid');
      const sourceIds = req.source_evidence.map(ref => {
        const row = source.get(ref.entry_id), meta = available.get(ref.entry_id);
        if (ref.source_key !== sourceKey || ref.source_sha256 !== sourceSha256 || ref.scope !== scope
          || !proof.context_entry_ids.includes(ref.entry_id) || !row?.message || !meta?.original_evidence_candidate
          || meta.availability_status !== 'known_eligible_own_source_actor' || ref.availability_time !== meta.availability_time
          || Date.parse(meta.availability_time) > Date.parse(item.query_time)) throw fail('evidence_unverified');
        const id = hash([sourceKey, ref.entry_id]);
        const value = entryText(row);
        if (!value) throw fail('evidence_unavailable');
        evidence.set(id, { id, scope, text: value, availableAt: meta.availability_time });
        return id;
      });
      return { id: req.id, text: req.text, sourceIds: [...new Set(sourceIds)] };
    });
    const allSources = [...evidence.keys()];
    const publicCase = { id: item.case_id, request: item.request, actor: item.actor.id, queryTime: item.query_time,
      readScopes: item.read_scopes, evidenceScopes: item.evidence_resolution_permissions.scopes };
    const packet = { caseId: item.case_id, request: item.request, actor: item.actor.id, queryTime: item.query_time,
      readScopes: item.read_scopes, evidenceScopes: item.evidence_resolution_permissions.scopes,
      answerability: item.answerable_under_declared_conditions ? 'answerable' : 'unanswerable',
      acceptableUncertainty: item.acceptable_uncertainty.join('\n'), requirements, sources: [...evidence.values()],
      supportedAlternatives: item.alternative_supported_answers.map(value => ({ text: value, sourceIds: allSources })),
      forbidden: item.forbidden_unsupported_claims_or_actions, correctionChains: item.correction_chains };
    return { publicCase, packet, through: checkpoint.through_entry_id, historyGroup: item.history_group_id };
  });
}
