import { createHash } from 'node:crypto';
import { hash, verifySeal } from './seal.mjs';

const fail = code => Object.assign(new Error(code), { code });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const subset = (values, allowed) => Array.isArray(values) && values.length > 0 && new Set(values).size === values.length && values.every(x => allowed.includes(x));
export const CITATION_PROTOCOL = 'returned-evidence-v1';
export const UNKNOWN_ANSWER = 'I do not know based on the available memory.';
const pair = (item, evidence) => JSON.stringify([item, evidence]);
export const citationId = (item, evidence) => `citation-${hash([item, evidence])}`;
export const textSha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
export const rawEvidenceId = (id, text) => `${id}:${textSha256(text).slice(0, 16)}`;
const sameRefs = (a, b) => a.size === b.size && [...a].every(([id, scope]) => b.get(id) === scope);
const budgetCodes = new Set(['search_limit', 'item_limit', 'retrieval_bytes_limit', 'resolve_limit', 'evidence_limit']);

export function createAnswerer({ seal, expectedDigest, memory, archive, respond }) {
  if (typeof respond !== 'function' || typeof memory?.search !== 'function' || typeof memory?.resolve !== 'function' || typeof archive?.search !== 'function') throw fail('adapter_invalid');
  const spec = verifySeal(seal, expectedDigest);
  if (spec.answerer.citationProtocol !== CITATION_PROTOCOL) throw fail('citation_protocol_required');
  return {
    async run({ arm, case: input }) {
      const s = verifySeal(seal, expectedDigest);
      if (!['candidate', 'baseline', 'empty', 'reference', 'raw-only'].includes(arm)) throw fail('arm_invalid');
      if (!nonempty(input?.id) || s.cases[input.id] !== hash(input)) throw fail('case_seal_mismatch');
      if (!nonempty(input?.request) || !nonempty(input?.actor) || !Number.isFinite(Date.parse(input?.queryTime))
        || !subset(input.readScopes, s.access.readScopes) || !subset(input.evidenceScopes, s.access.evidenceScopes)) throw fail('case_access_invalid');
      const limits = s.answerer.limits;
      const access = Object.freeze({ actor: input.actor, queryTime: input.queryTime,
        readScopes: Object.freeze([...input.readScopes]), evidenceScopes: Object.freeze([...input.evidenceScopes]) });
      const storeId = { candidate: s.stores.candidate, baseline: s.baseline.storeId, reference: s.stores.reference }[arm];
      const offered = new Map(), returnedEvidence = new Map(), refusals = [];
      let searches = 0, resolves = 0, returned = 0, evidenceBytes = 0, retrievalBytes = 0, inFlight = 0, closed = false, retrievalFailed = false;
      const budgetRefusal = (tool, code) => {
        if (refusals.length >= 64) { retrievalFailed = true; return fail('answer_refusal_limit'); }
        refusals.push({ tool, code });
        return Object.assign(fail(code), { refusal_recorded: true });
      };
      const remember = (item_id, evidence_id, scope, text) => {
        const key = pair(item_id, evidence_id), previous = returnedEvidence.get(key), digest = textSha256(text);
        if (previous && (previous.scope !== scope || previous.text_sha256 !== digest)) throw fail('evidence_identity_changed');
        returnedEvidence.set(key, { item_id, evidence_id, scope, text_sha256: digest, text });
      };
      const validateAnswer = answer => {
        if (retrievalFailed) throw fail('retrieval_failed');
        if (!answer || Object.keys(answer).sort().join(',') !== 'citations,text' || !nonempty(answer.text)
          || !Array.isArray(answer.citations) || answer.citations.length > 16 || !searches) throw fail('answer_invalid');
        let serialized;
        try { serialized = JSON.stringify(answer); } catch { throw fail('answer_invalid'); }
        if (Buffer.byteLength(serialized) > limits.responseBytes) throw fail('answer_invalid');
        const seen = new Set();
        for (const citation of answer.citations) {
          if (!citation || Object.keys(citation).sort().join(',') !== 'evidence_id,item_id'
            || !nonempty(citation.item_id) || !nonempty(citation.evidence_id)) throw fail('citation_invalid');
          const key = pair(citation.item_id, citation.evidence_id);
          if (seen.has(key) || !returnedEvidence.has(key)) throw fail('citation_not_returned');
          seen.add(key);
        }
        return true;
      };
      const tools = Object.freeze({
        async search(query) {
          if (!nonempty(query) || Buffer.byteLength(query) > limits.queryBytes) throw fail('query_invalid');
          if (++searches > limits.searchCalls) throw budgetRefusal('search', 'search_limit');
          const remaining = limits.returnedItems - returned;
          if (remaining <= 0) throw budgetRefusal('search', 'item_limit');
          if (closed) throw fail('answer_closed');
          const perSearch = Math.ceil(limits.returnedItems / limits.searchCalls);
          const args = { ...access, query, limit: Math.min(remaining, perSearch) };
          inFlight++;
          try {
            const rows = arm === 'empty' ? [] : arm === 'raw-only' ? await archive.search(args) : await memory.search({ ...args, storeId });
            if (closed) throw fail('answer_closed');
            if (!Array.isArray(rows) || rows.length > args.limit) throw fail('retrieval_invalid');
            if (returned + rows.length > limits.returnedItems) throw budgetRefusal('search', 'item_limit');
            const next = new Map(), result = rows.map(row => {
              if (!nonempty(row?.id) || !nonempty(row?.text) || !access.readScopes.includes(row.scope)) throw fail('retrieval_scope_invalid');
              if (arm === 'raw-only') {
                if (!access.evidenceScopes.includes(row.scope)) throw fail('evidence_scope_invalid');
                // Raw excerpts depend on the query, so each distinct text is its own citable evidence.
                const evidenceId = rawEvidenceId(row.id, row.text);
                if (next.has(row.id)) throw fail('duplicate_item');
                next.set(row.id, new Map([...(offered.get(row.id) ?? []), [evidenceId, row.scope]]));
                return { id: row.id, scope: row.scope, text: row.text, evidence: [{ id: evidenceId, scope: row.scope }] };
              }
              if (!Array.isArray(row.evidence)) throw fail('retrieval_invalid');
              const evidence = row.evidence.filter(e => nonempty(e?.id) && access.evidenceScopes.includes(e.scope)).map(e => ({ id: e.id, scope: e.scope }));
              const refs = new Map(evidence.map(e => [e.id, e.scope]));
              // A later search may legitimately return an item again; only a changed identity or an in-response repeat is invalid.
              if (next.has(row.id) || refs.size !== evidence.length || (offered.has(row.id) && !sameRefs(offered.get(row.id), refs))) throw fail('duplicate_item');
              next.set(row.id, refs);
              return { id: row.id, scope: row.scope, text: row.text, evidence };
            });
            const bytes = result.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
            if (retrievalBytes + bytes > limits.retrievalBytes) throw budgetRefusal('search', 'retrieval_bytes_limit');
            if (arm === 'raw-only' && evidenceBytes + bytes > limits.evidenceBytes) throw budgetRefusal('search', 'evidence_limit');
            returned += rows.length; retrievalBytes += bytes;
            if (arm === 'raw-only') {
              evidenceBytes += bytes;
              for (const row of result) remember(row.id, row.evidence[0].id, row.scope, row.text);
            }
            for (const [id, refs] of next) offered.set(id, refs);
            return result;
          } catch (error) {
            if (budgetCodes.has(error?.code) && !error.refusal_recorded) throw budgetRefusal('search', error.code);
            if (!error?.refusal_recorded) retrievalFailed = true;
            throw error;
          } finally { inFlight--; }
        },
        resolve(itemId, evidenceId) {
          if (closed) throw fail('answer_closed');
          if (arm === 'raw-only' || !offered.get(itemId)?.has(evidenceId)) throw fail('not_offered');
          if (++resolves > limits.resolveCalls) throw budgetRefusal('resolve', 'resolve_limit');
          inFlight++;
          return (async () => {
            try {
              const row = await memory.resolve({ ...access, storeId, itemId, evidenceId });
              if (closed) throw fail('answer_closed');
              if (row?.id !== evidenceId || row.scope !== offered.get(itemId).get(evidenceId) || !access.evidenceScopes.includes(row.scope)
                || typeof row.text !== 'string' || !row.text.trim()) throw fail('evidence_scope_invalid');
              const bytes = Buffer.byteLength(row.text);
              if (evidenceBytes + bytes > limits.evidenceBytes) throw budgetRefusal('resolve', 'evidence_limit');
              remember(itemId, evidenceId, row.scope, row.text);
              evidenceBytes += bytes;
              return { id: row.id, scope: row.scope, text: row.text };
            } catch (error) {
              if (budgetCodes.has(error?.code) && !error.refusal_recorded) throw budgetRefusal('resolve', error.code);
              if (!error?.refusal_recorded) retrievalFailed = true;
              throw error;
            } finally { inFlight--; }
          })();
        },
      });
      let answer;
      try {
        answer = await respond({ request: input.request, instructions: s.answerer.instructions, route: s.answerer.route,
          model: s.answerer.model, reasoning: s.answerer.reasoning, outputTokens: limits.outputTokens,
          inputTokens: limits.inputTokens, modelCalls: limits.modelCalls, formatRepairCalls: limits.formatRepairCalls ?? 1,
          repairInstruction: s.answerer.repair_instruction ?? null, costNano: limits.costNano, tools, validateAnswer });
        if (inFlight) throw fail('outstanding_tool_calls');
      } finally { closed = true; }
      if (!answer || typeof answer.text !== 'string' || Buffer.byteLength(answer.text) > limits.responseBytes) throw fail('answer_invalid');
      try { answer = structuredClone(answer); } catch { throw fail('answer_invalid'); }
      validateAnswer(answer);
      const abstained = answer.citations.length === 0;
      const citedEvidence = answer.citations.map(row => {
        const evidence = returnedEvidence.get(pair(row.item_id, row.evidence_id));
        return { citation_id: citationId(row.item_id, row.evidence_id), ...evidence };
      });
      return { caseId: input.id, answer: { text: abstained ? UNKNOWN_ANSWER : answer.text, citations: structuredClone(answer.citations) },
        condition: arm, diagnostic: ['reference', 'raw-only'].includes(arm),
        trace: { caseId: input.id, caseDigest: s.cases[input.id], sealDigest: seal.digest,
          context: { request: input.request, actor: input.actor, queryTime: input.queryTime, readScopes: [...input.readScopes], evidenceScopes: [...input.evidenceScopes] },
          searchCalls: searches, resolveCalls: resolves, returnedItems: returned, returnedItemIds: [...offered.keys()], evidenceBytes, retrievalBytes,
          citations: structuredClone(answer.citations), returnedEvidence: [...returnedEvidence.values()].map(({ text: _text, ...row }) => row),
          citedEvidence, budgetRefusals: refusals, model_text_sha256: textSha256(answer.text), host_replaced_text: abstained && answer.text !== UNKNOWN_ANSWER,
          abstention: abstained ? (refusals.length ? 'host_enforced_after_budget_refusal' : 'host_enforced_no_citations') : 'not_enforced' }, sealDigest: seal.digest };
    },
  };
}
