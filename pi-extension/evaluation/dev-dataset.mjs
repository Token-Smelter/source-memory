import { createHash } from 'node:crypto';
import { hash } from './seal.mjs';

export const BLOCK_EVIDENCE_CONTRACT = 'block-evidence/v1';
const fail = code => Object.assign(new Error(code), { code });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reviews = new WeakMap();
const selectedIndices = value => Array.isArray(value) && value.length > 0 && value.every(Number.isSafeInteger)
  && value.every(index => index >= 0) && new Set(value).size === value.length ? [...value].sort((a, b) => a - b) : null;
const approvalKey = (caseId, locationType, locationId, ref, indices, blockIndex) => hash([
  caseId, locationType, locationId, ref.source_key, ref.source_sha256, ref.entry_id, ref.scope, indices, blockIndex,
]);

/** Verify a metadata-only occurrence map against independently supplied dataset and review pins. */
export function verifyToolCallReview({ bytes, expectedSha256, datasetManifestSha256, sourceReviewSha256 }) {
  if (!Buffer.isBuffer(bytes) || !digest(expectedSha256) || !digest(datasetManifestSha256) || !digest(sourceReviewSha256)
    || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw fail('toolcall_review_unverified');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw fail('toolcall_review_unverified'); }
  if (value?.schema !== 'source-memory-dev-v2-block-evidence-metadata/v1'
    || value.development_manifest_sha256 !== datasetManifestSha256 || value.source_review_sha256 !== sourceReviewSha256
    || !Array.isArray(value.selected_toolcall_occurrences)) throw fail('toolcall_review_unverified');
  const approvals = new Set();
  for (const row of value.selected_toolcall_occurrences) {
    const indices = selectedIndices(row?.selected_indices);
    if (!nonempty(row?.case_id) || !['requirement', 'correction_chain'].includes(row?.location_type)
      || (row.location_type === 'requirement' ? !nonempty(row.location_id) : !Number.isSafeInteger(row.location_id) || row.location_id < 0)
      || !nonempty(row.source_key) || !digest(row.source_sha256) || !nonempty(row.entry_id) || !nonempty(row.scope)
      || !indices || !Number.isSafeInteger(row.selected_toolcall_index) || !indices.includes(row.selected_toolcall_index)) throw fail('toolcall_review_unverified');
    const key = approvalKey(row.case_id, row.location_type, row.location_id, row, indices, row.selected_toolcall_index);
    if (approvals.has(key)) throw fail('toolcall_review_unverified');
    approvals.add(key);
  }
  const token = Object.freeze({ sha256: expectedSha256, datasetManifestSha256, sourceReviewSha256 });
  reviews.set(token, { approvals, used: new Set() });
  return token;
}

export function toolCallReviewSummary(token) {
  const review = reviews.get(token);
  if (!review) throw fail('toolcall_review_unverified');
  return { sha256: token.sha256, datasetManifestSha256: token.datasetManifestSha256,
    sourceReviewSha256: token.sourceReviewSha256, approved: review.approvals.size, used: review.used.size };
}

function evidenceText({ row, ref, item, locationType, locationId, toolCallReview, usedApprovals }) {
  const content = row?.message?.content, indices = selectedIndices(ref?.citable_content_block_indices);
  if (!Array.isArray(content) || !indices || indices.some(index => index >= content.length)) throw fail('evidence_indices_invalid');
  const pieces = [];
  for (const index of indices) {
    const block = content[index];
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw fail('evidence_block_forbidden');
    if (['text', 'input_text', 'output_text'].includes(block.type)) {
      if (typeof block.text !== 'string') throw fail('evidence_block_forbidden');
      if (block.text) pieces.push(block.text);
      continue;
    }
    if (!['toolCall', 'tool_use'].includes(block.type)) throw fail('evidence_block_forbidden');
    const review = reviews.get(toolCallReview);
    const key = approvalKey(item.case_id, locationType, locationId, ref, indices, index);
    if (!review || !review.approvals.has(key) || item.semantic_review?.review_sha256 !== toolCallReview.sourceReviewSha256
      || item.semantic_review?.verdict !== 'keep') throw fail('toolcall_review_unverified');
    const args = block.arguments ?? block.input ?? block.args;
    if (args === undefined || args === null) throw fail('evidence_block_forbidden');
    let encoded;
    try { encoded = JSON.stringify(args); } catch { throw fail('evidence_block_forbidden'); }
    if (typeof encoded !== 'string') throw fail('evidence_block_forbidden');
    pieces.push(`${nonempty(block.name) ? block.name : 'tool'} ${encoded}`);
    usedApprovals.add(key);
  }
  const text = pieces.join('\n');
  if (!text.trim()) throw fail('evidence_unavailable');
  return { text, indices };
}

/** Convert frozen development cases into disjoint answerer inputs and block-scoped scorer packets. */
export function prepareDevelopmentCases({ cases, proofs, verified, entries, availability, sourceKey, scope, sourceSha256, toolCallReview = null }) {
  if (!Array.isArray(cases) || !Array.isArray(proofs) || !Array.isArray(verified) || !Array.isArray(entries)
    || !Array.isArray(availability) || !nonempty(sourceKey) || !nonempty(scope) || !digest(sourceSha256)
    || (toolCallReview !== null && !reviews.has(toolCallReview))) throw fail('dataset_invalid');
  const source = new Map();
  for (const row of entries) if (nonempty(row?.id)) {
    if (source.has(row.id)) throw fail('dataset_invalid');
    source.set(row.id, row);
  }
  const available = new Map();
  for (const row of availability) if (row.source_key === sourceKey) {
    if (!nonempty(row.entry_id) || available.has(row.entry_id)) throw fail('dataset_invalid');
    available.set(row.entry_id, row);
  }
  const selected = cases.filter(row => row?.split === 'development' && row.pre_answer_store_snapshot?.source_key === sourceKey);
  if (!selected.length) throw fail('cases_unavailable');
  const usedApprovals = new Set();
  const prepared = selected.map(item => {
    const checkpoint = item.pre_answer_store_snapshot;
    const matched = proofs.filter(row => row.case_id === item.case_id && row.source_key === sourceKey), proof = matched[0];
    if (matched.length !== 1 || !Array.isArray(proof?.context_entry_ids) || !Number.isFinite(Date.parse(item.query_time))
      || !verified.some(row => row.through_entry_id === checkpoint.through_entry_id && row.source_sha256 === sourceSha256
        && row.context_messages_sha256 === proof.context_messages_sha256)
      || checkpoint.source_sha256 !== sourceSha256 || checkpoint.through_entry_id !== proof.through_entry_id
      || checkpoint.context_ancestry_sha256 !== proof.ancestry_sha256 || item.query_time !== proof.query_time
      || item.selection_provenance?.candidate_outputs_used_for_selection !== false
      || item.selection_provenance?.reference_catalog_used_for_selection !== false
      || item.evidence_resolution_permissions?.returned_items_only !== true || !item.read_scopes?.includes(scope)
      || !item.evidence_resolution_permissions.scopes?.includes(scope)) throw fail('case_unverified');
    if (!Array.isArray(item.answer_action_requirements) || !Array.isArray(item.correction_chains)) throw fail('case_invalid');
    const evidence = new Map();
    const resolveEvidence = (ref, locationType, locationId) => {
      const row = source.get(ref?.entry_id), meta = available.get(ref?.entry_id);
      if (ref?.source_key !== sourceKey || ref.source_sha256 !== sourceSha256 || ref.scope !== scope
        || !proof.context_entry_ids.includes(ref.entry_id) || !row?.message || !meta?.original_evidence_candidate
        || meta.availability_status !== 'known_eligible_own_source_actor' || ref.availability_time !== meta.availability_time
        || !Number.isFinite(Date.parse(meta.availability_time)) || Date.parse(meta.availability_time) > Date.parse(item.query_time)) throw fail('evidence_unverified');
      const selected = evidenceText({ row, ref, item, locationType, locationId, toolCallReview, usedApprovals });
      const id = hash([BLOCK_EVIDENCE_CONTRACT, sourceKey, sourceSha256, ref.entry_id, scope, selected.indices]);
      evidence.set(id, { id, scope, text: selected.text, availableAt: meta.availability_time });
      return id;
    };
    const requirements = item.answer_action_requirements.map(req => {
      if (!nonempty(req?.id) || !nonempty(req.text) || !Array.isArray(req.source_evidence) || !req.source_evidence.length) throw fail('case_invalid');
      return { id: req.id, text: req.text, sourceIds: [...new Set(req.source_evidence.map(ref => resolveEvidence(ref, 'requirement', req.id)))] };
    });
    const correctionChains = item.correction_chains.map((chain, index) => {
      if (!nonempty(chain?.stage) || !Array.isArray(chain.source_evidence) || !chain.source_evidence.length) throw fail('case_invalid');
      return { stage: chain.stage, sourceIds: [...new Set(chain.source_evidence.map(ref => resolveEvidence(ref, 'correction_chain', index)))] };
    });
    const allSources = [...evidence.keys()];
    const publicCase = { id: item.case_id, request: item.request, actor: item.actor.id, queryTime: item.query_time,
      readScopes: item.read_scopes, evidenceScopes: item.evidence_resolution_permissions.scopes };
    const packet = { evidenceContract: BLOCK_EVIDENCE_CONTRACT, caseId: item.case_id, request: item.request, actor: item.actor.id, queryTime: item.query_time,
      readScopes: item.read_scopes, evidenceScopes: item.evidence_resolution_permissions.scopes,
      answerability: item.answerable_under_declared_conditions ? 'answerable' : 'unanswerable',
      acceptableUncertainty: item.acceptable_uncertainty.join('\n'), requirements, sources: [...evidence.values()],
      supportedAlternatives: item.alternative_supported_answers.map(value => ({ text: value, sourceIds: allSources })),
      forbidden: item.forbidden_unsupported_claims_or_actions, correctionChains };
    return { publicCase, packet, through: checkpoint.through_entry_id, historyGroup: item.history_group_id };
  });
  if (toolCallReview) for (const key of usedApprovals) reviews.get(toolCallReview).used.add(key);
  return prepared;
}
