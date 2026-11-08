import { hash, verifySeal } from './seal.mjs';

const fail = code => Object.assign(new Error(code), { code });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const subset = (values, allowed) => Array.isArray(values) && values.length > 0 && new Set(values).size === values.length && values.every(x => allowed.includes(x));

export function createAnswerer({ seal, expectedDigest, memory, archive, respond }) {
  if (typeof respond !== 'function' || typeof memory?.search !== 'function' || typeof memory?.resolve !== 'function' || typeof archive?.search !== 'function') throw fail('adapter_invalid');
  verifySeal(seal, expectedDigest);
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
      const offered = new Map();
      let searches = 0, resolves = 0, returned = 0, evidenceBytes = 0, retrievalBytes = 0, inFlight = 0, closed = false;
      const tools = Object.freeze({
        async search(query) {
          if (!nonempty(query) || Buffer.byteLength(query) > limits.queryBytes) throw fail('query_invalid');
          if (++searches > limits.searchCalls) throw fail('search_limit');
          const remaining = limits.returnedItems - returned;
          if (remaining <= 0) throw fail('item_limit');
          if (closed) throw fail('answer_closed');
          const perSearch = Math.ceil(limits.returnedItems / limits.searchCalls);
          const args = { ...access, query, limit: Math.min(remaining, perSearch) };
          inFlight++;
          try {
            const rows = arm === 'empty' ? [] : arm === 'raw-only' ? await archive.search(args) : await memory.search({ ...args, storeId });
            if (closed) throw fail('answer_closed');
            if (!Array.isArray(rows) || rows.length > args.limit) throw fail('retrieval_invalid');
            if (returned + rows.length > limits.returnedItems) throw fail('item_limit');
            const next = new Map(), result = rows.map(row => {
              if (!nonempty(row?.id) || !nonempty(row?.text) || !access.readScopes.includes(row.scope)) throw fail('retrieval_scope_invalid');
              if (arm === 'raw-only') {
                if (!access.evidenceScopes.includes(row.scope)) throw fail('evidence_scope_invalid');
                return { id: row.id, scope: row.scope, text: row.text };
              }
              if (!Array.isArray(row.evidence)) throw fail('retrieval_invalid');
              const evidence = row.evidence.filter(e => nonempty(e?.id) && access.evidenceScopes.includes(e.scope)).map(e => ({ id: e.id, scope: e.scope }));
              if (offered.has(row.id) || next.has(row.id) || new Set(evidence.map(e => e.id)).size !== evidence.length) throw fail('duplicate_item');
              next.set(row.id, new Map(evidence.map(e => [e.id, e.scope])));
              return { id: row.id, scope: row.scope, text: row.text, evidence };
            });
            const bytes = result.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
            if (retrievalBytes + bytes > limits.retrievalBytes) throw fail('retrieval_bytes_limit');
            if (arm === 'raw-only' && evidenceBytes + bytes > limits.evidenceBytes) throw fail('evidence_limit');
            returned += rows.length; retrievalBytes += bytes;
            if (arm === 'raw-only') evidenceBytes += bytes;
            for (const [id, refs] of next) offered.set(id, refs);
            return result;
          } finally { inFlight--; }
        },
        resolve(itemId, evidenceId) {
          if (closed) throw fail('answer_closed');
          if (arm === 'raw-only' || !offered.get(itemId)?.has(evidenceId)) throw fail('not_offered');
          if (++resolves > limits.resolveCalls) throw fail('resolve_limit');
          inFlight++;
          return (async () => {
            try {
              const row = await memory.resolve({ ...access, storeId, itemId, evidenceId });
              if (closed) throw fail('answer_closed');
              if (row?.id !== evidenceId || row.scope !== offered.get(itemId).get(evidenceId) || !access.evidenceScopes.includes(row.scope) || typeof row.text !== 'string') throw fail('evidence_scope_invalid');
              const bytes = Buffer.byteLength(row.text);
              if (evidenceBytes + bytes > limits.evidenceBytes) throw fail('evidence_limit');
              evidenceBytes += bytes;
              return { id: row.id, scope: row.scope, text: row.text };
            } finally { inFlight--; }
          })();
        },
      });
      let answer;
      try {
        answer = await respond({ request: input.request, instructions: s.answerer.instructions, route: s.answerer.route,
          model: s.answerer.model, reasoning: s.answerer.reasoning, outputTokens: limits.outputTokens,
          inputTokens: limits.inputTokens, modelCalls: limits.modelCalls, formatRepairCalls: limits.formatRepairCalls ?? 1,
          repairInstruction: s.answerer.repair_instruction ?? null, costNano: limits.costNano, tools });
        if (inFlight) throw fail('outstanding_tool_calls');
      } finally { closed = true; }
      if (!answer || typeof answer.text !== 'string' || Buffer.byteLength(answer.text) > limits.responseBytes) throw fail('answer_invalid');
      return { caseId: input.id, answer: { text: answer.text }, condition: arm, diagnostic: ['reference', 'raw-only'].includes(arm),
        trace: { caseId: input.id, caseDigest: s.cases[input.id], sealDigest: seal.digest,
          context: { request: input.request, actor: input.actor, queryTime: input.queryTime, readScopes: [...input.readScopes], evidenceScopes: [...input.evidenceScopes] },
          searchCalls: searches, resolveCalls: resolves, returnedItems: returned, returnedItemIds: [...offered.keys()], evidenceBytes, retrievalBytes }, sealDigest: seal.digest };
    },
  };
}
