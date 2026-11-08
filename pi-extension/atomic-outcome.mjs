import { randomUUID } from 'node:crypto';
import { digest, normalizeEnrichment } from '../src/core.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** Reference handles and proposals remain process-local; a serialized proposal is not a write capability. */
export function createAtomicOutcomes({ memory, beforeAppend }) {
  const offers = new Map(), offerByIdentity = new Map(), pending = new Map();
  const show = async (scope, kind, id) => {
    const result = await memory.show(scope, { kind, id });
    return kind === 'turn' ? result?.turn : result?.record;
  };
  return {
    offer(scope, trigger, recalled) {
      if (typeof trigger !== 'string' || !trigger) return recalled;
      const copy = structuredClone(recalled);
      for (const bundle of copy.bundles ?? []) for (const record of bundle.records ?? []) {
        if (record.kind !== 'action' || typeof record.id !== 'string') continue;
        const key = JSON.stringify([scope, trigger, record.id]);
        let handle = offerByIdentity.get(key);
        if (!handle) {
          if (offers.size >= 1024) throw fail('outcome_offer_limit');
          handle = `action-${randomUUID()}`;
          offers.set(handle, { scope, trigger, id: record.id, key });
          offerByIdentity.set(key, handle);
        }
        record.action_handle = handle;
      }
      return copy;
    },
    async begin({ scope, trigger, outcome, new_action: newAction, action_handle: actionHandle }) {
      if (typeof trigger !== 'string' || !trigger || !outcome || Boolean(newAction) === Boolean(actionHandle)) throw fail('outcome_referent_required');
      if (pending.size >= 64) throw fail('outcome_offer_limit');
      const source = await show(scope, 'turn', trigger);
      if (!source || source.source !== 'pi-memory') throw fail('source_invalid');
      let action, prior = false;
      if (newAction) {
        if (newAction.kind !== 'action') throw fail('invalid_outcome_relation');
        action = newAction;
      } else {
        const offer = offers.get(actionHandle);
        if (!offer || offer.scope !== scope || offer.trigger !== trigger) throw fail('action_handle_not_offered');
        action = await show(scope, 'record', offer.id);
        if (!action || action.kind !== 'action') throw fail('invalid_outcome_relation');
        prior = true;
      }
      if (outcome.kind !== 'outcome' || !Array.isArray(outcome.evidence)
        || outcome.evidence.some(span => span.turn !== trigger)
        || (!prior && (!Array.isArray(action.evidence) || action.evidence.some(span => span.turn !== trigger)))) throw fail('record_not_from_trigger');
      const edge = { id: `pi-memory-outcome-edge-${digest(['pi-memory-outcome-edge/v1', scope, outcome.id, action.id, outcome.evidence])}`,
        type: 'outcome_of', from: outcome.id, to: action.id, attribution: 'Pi distiller proposal; not operator acceptance', evidence: outcome.evidence };
      const payload = normalizeEnrichment({ records: prior ? [outcome] : [action, outcome], relations: [edge] });
      const evidence = await memory.evidence(scope, [...outcome.evidence, ...action.evidence]);
      if (!Array.isArray(evidence) || evidence.some(row => /\[image sha256=[a-f0-9]{64} mime=/.test(row.text ?? ''))) throw fail('image_not_citable');
      const packet = { records: [{ ref: 'outcome', kind: 'outcome', text: outcome.text, newly_retained: true },
        { ref: 'action', kind: 'action', text: action.text, newly_retained: !prior }],
      sources: evidence.map((row, index) => ({ ref: `s${index}`, role: row.role, text: row.text })) };
      const proposal = { contract: 'pi-memory-atomic-outcome/v1', scope, trigger, requires_review: prior, packet,
        proposals: [{ from: 'outcome', to: 'action', type: 'outcome_of', evidence: outcome.evidence.map((_, i) => `s${i}`) }] };
      const contextSha = digest({ scope, trigger, source, action, payload });
      const proposalSha = digest({ proposal, contextSha });
      const operationId = `pi-memory-atomic-outcome-${digest([scope, trigger, payload])}`;
      const token = randomUUID();
      pending.set(token, { scope, trigger, payload, action, source, prior, contextSha, proposalSha, operationId, claimed: false });
      return { token, proposal: { ...proposal, context_sha256: contextSha, proposal_sha256: proposalSha, operation_id: operationId } };
    },
    async apply({ scope, token, review }) {
      const slot = pending.get(token);
      if (!slot || slot.scope !== scope || slot.claimed) throw fail('outcome_offer_unavailable');
      slot.claimed = true;
      try {
        if (slot.prior && (!review || review.proposal_sha256 !== slot.proposalSha || typeof review.reviewer !== 'string'
          || !review.reviewer.startsWith('separate:') || typeof review.decision_ref !== 'string' || !review.decision_ref
          || !Array.isArray(review.approved) || review.approved.length !== 1 || review.approved[0] !== 0)) throw fail('outcome_review_refused');
        const source = await show(scope, 'turn', slot.trigger);
        const action = slot.prior ? await show(scope, 'record', slot.action.id) : slot.action;
        if (digest({ scope, trigger: slot.trigger, source, action, payload: slot.payload }) !== slot.contextSha) throw fail('outcome_context_changed');
        if (typeof beforeAppend !== 'function') throw fail('link_append_preparation_required');
        const appendSha = digest(slot.payload);
        const accepted = await beforeAppend({ operation_id: slot.operationId, append_sha256: appendSha, scope, trigger: slot.trigger });
        if (accepted?.accepted !== true || accepted.operation_id !== slot.operationId || accepted.append_sha256 !== appendSha) throw fail('outcome_intent_refused');
        const result = await memory.enrich(scope, slot.payload);
        if (!Array.isArray(result?.records) || !Array.isArray(result?.relations)
          || slot.payload.records.some(row => !result.records.includes(row.id)) || !result.relations.includes(slot.payload.relations[0].id)) throw fail('outcome_write_unknown');
        return { status: 'written', records: result.records, relations: result.relations, indexing: result.indexing ?? null, operation_id: slot.operationId };
      } finally { pending.delete(token); }
    },
    cancel(token) { return { cancelled: pending.delete(token) }; },
    release(scope, trigger) {
      for (const [handle, offer] of offers) if (offer.scope === scope && offer.trigger === trigger) {
        offers.delete(handle); offerByIdentity.delete(offer.key);
      }
    },
    close() { offers.clear(); offerByIdentity.clear(); pending.clear(); },
  };
}
