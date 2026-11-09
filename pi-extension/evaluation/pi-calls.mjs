import { hash } from './seal.mjs';
import { METERED_RUNTIME } from './pi-wrapper.mjs';
import { GROUNDING_PROTOCOL } from './rubric.mjs';

const fail = code => Object.assign(new Error(code), { code });
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' }, strings = { type: 'array', items: string };
const grades = { type: 'string', enum: ['pass', 'fail', 'uncertain'] };
const clauseProperties = { id: string, text: string, requirementIds: strings, sourceIds: strings,
  action: { type: 'boolean' }, judgments: schema({ support: grades, authority: grades, scope: grades, time: grades, uncertainty: grades }),
  alternative: { anyOf: [{ type: 'null' }, schema({ rationale: string, sourceIds: strings })] },
  relation: { anyOf: [{ type: 'null' }, schema({ required: { type: 'boolean' }, recoverable: { anyOf: [{ type: 'boolean' }, { type: 'null' }] }, itemIds: strings })] } };
const judgmentSchema = schema({ clauses: { type: 'array', items: schema(clauseProperties) } });
const groundedJudgmentSchema = schema({ clauses: { type: 'array', items: schema({ ...clauseProperties, citationIds: strings,
  abstention: { type: 'boolean' } }) } });
export const ANSWERER_TOOLS = Object.freeze([
  { name: 'memory_search', description: 'Search permitted derived-memory items; after the fixed item budget is spent, later searches return a budget-exhausted result.', parameters: schema({ query: string }) },
  { name: 'memory_resolve', description: 'Resolve evidence for an item returned by memory_search.', parameters: schema({ item_id: string, evidence_id: string }) },
  { name: 'submit_answer', description: 'Submit the final answer after using any necessary retrieval tools.', parameters: schema({ answer: string }) },
]);
export const ANSWERER_CITED_TOOLS = Object.freeze([
  ANSWERER_TOOLS[0], ANSWERER_TOOLS[1],
  { name: 'submit_answer', description: 'Submit the final answer with citations to evidence actually returned by the tools.',
    parameters: schema({ answer: string, citations: { type: 'array', maxItems: 16, items: schema({ item_id: string, evidence_id: string }) } }) },
]);
export const SCORER_TOOLS = Object.freeze([{ name: 'submit_score', description: 'Submit the complete clause-level judgment.', parameters: judgmentSchema }]);
export const SCORER_GROUNDED_TOOLS = Object.freeze([{ name: 'submit_score', description: 'Submit the complete clause-level judgment, including cited evidence IDs.', parameters: groundedJudgmentSchema }]);
export const ANSWERER_TOOLS_SHA256 = hash(ANSWERER_TOOLS);
export const ANSWERER_CITED_TOOLS_SHA256 = hash(ANSWERER_CITED_TOOLS);
export const ANSWERER_TOOLS_V2_SHA256 = hash([{ ...ANSWERER_TOOLS[0], description: 'Search the permitted derived-memory items.' }, ...ANSWERER_TOOLS.slice(1)]);
export const SCORER_TOOLS_SHA256 = hash(SCORER_TOOLS);
export const SCORER_GROUNDED_TOOLS_SHA256 = hash(SCORER_GROUNDED_TOOLS);
export const ANSWERER_FORMAT_SUFFIX = ' Submit the final answer with the submit_answer tool.';
export const ANSWERER_BUDGET_SUFFIX = ' If the item budget is exhausted, answer from retrieved items or state uncertainty.';
export const ANSWERER_CITATION_SUFFIX = ' Search the permitted memory before answering. If no relevant information supports an answer, say you do not know; never guess. Cite only evidence actually returned by memory_resolve using its item_id and evidence_id. If memory_search directly returns raw evidence without evidence handles, use the returned id as both item_id and evidence_id. If no evidence supports an answer, submit an empty citations array.';
export const SCORER_FORMAT_SUFFIX = ' Submit the complete judgment with the submit_score tool.';
export const ANSWERER_REPAIR = 'The previous output was not a valid final submission. Call submit_answer with the complete answer; do not change its substance merely to fix formatting.';
export const ANSWERER_CITED_REPAIR = 'The previous submission was invalid. Search before answering and submit the answer with citations only to evidence actually returned by the tools; if none supports an answer, submit no citations and say you do not know.';
export const SCORER_REPAIR = 'The previous submission was invalid. Call submit_score with the complete judgment matching the schema and supplied IDs; retain substantive judgments unless correction is required for validity.';
export const SCORER_GROUNDED_REPAIR = 'The previous submission was invalid. Call submit_score with the complete judgment and supplied reference and cited-evidence IDs. Factual support passes only when both reference and cited evidence support the clause. The exact canonical unknown may be a nonfactual abstention with no citation IDs. Otherwise choose fail or uncertain.';
export const SCORER_SPECIFIC_REPAIR = 'For clause {clause_id}: support=pass requires at least one packet source ID; if no packet source supports the clause, choose fail or uncertain. Submit the complete judgment with submit_score.';
export const SCORER_MULTI_REPAIR = 'For each clause in {clause_ids}: support=pass requires at least one packet source ID; if no packet source supports the clause, choose fail or uncertain. Submit the complete judgment with submit_score.';

export function answererBudgetFormatCompatible(previous, current) {
  if (previous?.version !== 'answerer-r2-v2' || previous.tools_sha256 !== ANSWERER_TOOLS_V2_SHA256
    || current?.version !== 'answerer-r2-v3' || current.tools_sha256 !== ANSWERER_TOOLS_SHA256
    || current.instructions !== previous.instructions + ANSWERER_BUDGET_SUFFIX) return false;
  const a = structuredClone(previous), b = structuredClone(current);
  for (const key of ['version', 'tools_sha256', 'instructions']) { delete a[key]; delete b[key]; }
  return hash(a) === hash(b);
}

function check({ runtime, model, sessionId }) {
  if (runtime?.[METERED_RUNTIME] !== true || typeof runtime.streamSimple !== 'function'
    || !model?.provider || !model?.id || typeof sessionId !== 'string' || !sessionId) throw fail('metered_pi_runtime_required');
}
async function call(runtime, model, context, options, onRaw, metadata) {
  const stream = runtime.streamSimple(model, context, options);
  if (!stream || typeof stream.result !== 'function') throw fail('pi_stream_invalid');
  const message = await stream.result();
  await onRaw({ ...metadata, message: structuredClone(message) });
  if (!message || message.role !== 'assistant' || message.provider !== model.provider || message.model !== model.id
    || ['error', 'aborted', 'deferred'].includes(message.stopReason) || !Array.isArray(message.content)) throw fail('model_call_incomplete');
  return message;
}
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function validScore(value, grounded = false) {
  const dimensions = ['support', 'authority', 'scope', 'time', 'uncertainty'];
  return exact(value, ['clauses']) && Array.isArray(value.clauses) && value.clauses.every(c => exact(c,
    ['id', 'text', 'requirementIds', 'sourceIds', 'action', 'judgments', 'alternative', 'relation', ...(grounded ? ['citationIds', 'abstention'] : [])])
    && typeof c.id === 'string' && c.id.trim() && typeof c.text === 'string' && c.text.trim() && typeof c.action === 'boolean'
    && Array.isArray(c.requirementIds) && c.requirementIds.every(x => typeof x === 'string')
    && Array.isArray(c.sourceIds) && c.sourceIds.every(x => typeof x === 'string')
    && (!grounded || (Array.isArray(c.citationIds) && c.citationIds.every(x => typeof x === 'string') && typeof c.abstention === 'boolean')) && exact(c.judgments, dimensions)
    && dimensions.every(key => ['pass', 'fail', 'uncertain'].includes(c.judgments[key]))
    && (c.alternative === null || (exact(c.alternative, ['rationale', 'sourceIds']) && typeof c.alternative.rationale === 'string'
      && Array.isArray(c.alternative.sourceIds) && c.alternative.sourceIds.every(x => typeof x === 'string')))
    && (c.relation === null || (exact(c.relation, ['required', 'recoverable', 'itemIds']) && typeof c.relation.required === 'boolean'
      && [true, false, null].includes(c.relation.recoverable) && Array.isArray(c.relation.itemIds) && c.relation.itemIds.every(x => typeof x === 'string'))));
}
function toolResult(tool, value, isError = false) {
  return { role: 'toolResult', toolCallId: tool.id, toolName: tool.name,
    content: [{ type: 'text', text: JSON.stringify(value) }], isError, timestamp: Date.now() };
}

/** The answerer sees the request, sealed settings and bounded retrieval tools only. */
export function createPiAnswererResponder({ runtime, model, sessionId, expectedToolsSha256, onRaw = async () => {} }) {
  check({ runtime, model, sessionId });
  const cited = expectedToolsSha256 === ANSWERER_CITED_TOOLS_SHA256;
  const answererTools = cited ? ANSWERER_CITED_TOOLS : ANSWERER_TOOLS;
  const repair = cited ? ANSWERER_CITED_REPAIR : ANSWERER_REPAIR;
  if ((!cited && expectedToolsSha256 !== ANSWERER_TOOLS_SHA256) || typeof onRaw !== 'function') throw fail('answerer_tools_mismatch');
  return async ({ request, instructions, route, model: id, reasoning, inputTokens, outputTokens, modelCalls, formatRepairCalls = 1,
    repairInstruction = null, costNano, tools, validateAnswer }) => {
    if (hash(answererTools) !== expectedToolsSha256) throw fail('answerer_tools_mismatch');
    if (route !== model.provider || id !== model.id || typeof request !== 'string' || typeof instructions !== 'string'
      || !Number.isSafeInteger(inputTokens) || inputTokens < 1 || !/^[1-9]\d*$/.test(costNano ?? '')
      || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || !Number.isSafeInteger(modelCalls) || modelCalls < 1
      || formatRepairCalls !== 1 || (repairInstruction !== null && repairInstruction !== repair)
      || typeof tools?.search !== 'function' || typeof tools?.resolve !== 'function' || (cited && typeof validateAnswer !== 'function')) throw fail('answerer_invalid');
    const context = { systemPrompt: instructions, tools: structuredClone(answererTools), messages: [{ role: 'user', content: request, timestamp: Date.now() }] };
    let usedInput = 0, usedCost = 0n, repairs = 0;
    for (let count = 0; count < modelCalls + 1; count++) {
      if (hash(context.tools) !== expectedToolsSha256) throw fail('answerer_tools_mismatch');
      if (count >= modelCalls && repairs === 0) throw fail('model_call_limit');
      if (usedInput >= inputTokens || usedCost >= BigInt(costNano)) throw fail('answer_budget_exceeded');
      const message = await call(runtime, model, context, { maxTokens: outputTokens, reasoning, maxRetries: 0, sessionId }, onRaw,
        { role: 'answerer', attempt: count + 1 });
      const usage = message.usage;
      if (!['input', 'cacheRead', 'cacheWrite'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)
        || typeof usage?.cost?.total !== 'number' || !Number.isFinite(usage.cost.total) || usage.cost.total < 0) throw fail('usage_unknown');
      usedInput += usage.input + usage.cacheRead + usage.cacheWrite;
      usedCost += BigInt(Math.ceil(usage.cost.total * 1_000_000_000));
      if (usedInput > inputTokens || usedCost > BigInt(costNano)) throw fail('answer_budget_exceeded');
      context.messages.push(message);
      const calls = message.content.filter(part => part.type === 'toolCall');
      let invalid = message.stopReason !== 'toolUse' || !calls.length;
      for (const [index, tool] of calls.entries()) {
        const args = tool.arguments;
        if (tool.name === 'submit_answer' && calls.length === 1 && index === 0 && !invalid) {
          if (!cited && exact(args, ['answer']) && typeof args.answer === 'string' && args.answer.trim()
            && Buffer.byteLength(args.answer) <= 32000) return { text: args.answer };
          if (cited && exact(args, ['answer', 'citations'])) {
            const value = { text: args.answer, citations: args.citations };
            try { validateAnswer(value); return value; }
            catch (problem) {
              if (!['answer_invalid', 'citation_invalid', 'citation_not_returned'].includes(problem?.code)) throw problem;
              invalid = true; context.messages.push(toolResult(tool, { error: problem.code }, true)); continue;
            }
          }
        }
        if (tool.name === 'memory_search' && exact(args, ['query']) && typeof args.query === 'string' && !invalid) {
          try { context.messages.push(toolResult(tool, await tools.search(args.query))); }
          catch (error) {
            const budgets = { item_limit: 'item_budget_exhausted', search_limit: 'search_budget_exhausted',
              retrieval_bytes_limit: 'retrieval_bytes_budget_exhausted', evidence_limit: 'evidence_budget_exhausted' };
            if (!budgets[error?.code]) throw error;
            context.messages.push(toolResult(tool, { status: budgets[error.code],
              instruction: 'Answer from retrieved items or state uncertainty.' }));
          }
        } else if (tool.name === 'memory_resolve' && exact(args, ['item_id', 'evidence_id'])
          && typeof args.item_id === 'string' && typeof args.evidence_id === 'string' && !invalid) {
          try { context.messages.push(toolResult(tool, await tools.resolve(args.item_id, args.evidence_id))); }
          catch (error) {
            if (!['resolve_limit', 'evidence_limit'].includes(error?.code)) throw error;
            context.messages.push(toolResult(tool, { status: error.code === 'resolve_limit' ? 'resolve_budget_exhausted' : 'evidence_budget_exhausted',
              instruction: 'Answer from retrieved evidence or state uncertainty.' }));
          }
        } else { invalid = true; context.messages.push(toolResult(tool, { error: 'invalid_submission' }, true)); }
      }
      if (invalid) {
        if (repairs++) throw fail('answer_output_invalid');
        context.messages.push({ role: 'user', content: repair, timestamp: Date.now() });
      }
    }
    throw fail('model_call_limit');
  };
}

/** Re-score a retained answer with one specific rule-only correction request. */
export function createPiScorerSpecificRepair({ runtime, model, sessionId, outputTokens, onRaw = async () => {} }) {
  check({ runtime, model, sessionId });
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || typeof onRaw !== 'function') throw fail('scorer_invalid');
  return async ({ packet, answer, trace, scorer, rubric, packetSchema, validate, previousMessage, clauseId, clauseIds = clauseId ? [clauseId] : [] }) => {
    if (scorer?.route !== model.provider || scorer?.model !== model.id || typeof scorer.instructions !== 'string'
      || scorer.groundingProtocol === GROUNDING_PROTOCOL
      || !Array.isArray(clauseIds) || !clauseIds.length || new Set(clauseIds).size !== clauseIds.length
      || clauseIds.some(id => typeof id !== 'string' || !id || id.length > 256) || !Array.isArray(previousMessage?.content)) throw fail('scorer_invalid');
    const calls = previousMessage.content.filter(part => part.type === 'toolCall');
    const prior = calls.length === 1 && calls[0].name === 'submit_score' ? calls[0] : null;
    const invalid = prior?.arguments?.clauses?.filter(row => row.judgments?.support === 'pass'
      && Array.isArray(row.sourceIds) && row.sourceIds.length === 0) ?? [];
    if (invalid.length !== clauseIds.length || invalid.some(row => !clauseIds.includes(row.id))) throw fail('scorer_repair_unbound');
    const previous = structuredClone(previousMessage);
    const instruction = clauseIds.length === 1 ? SCORER_SPECIFIC_REPAIR.replace('{clause_id}', JSON.stringify(clauseIds[0]))
      : SCORER_MULTI_REPAIR.replace('{clause_ids}', JSON.stringify(clauseIds));
    const context = { systemPrompt: scorer.instructions, tools: SCORER_TOOLS, messages: [
      { role: 'user', content: JSON.stringify({ packet, answer, trace, rubric, packet_schema: packetSchema }), timestamp: Date.now() },
      previous, toolResult(prior, { error: 'invalid_submission' }, true), { role: 'user', content: instruction, timestamp: Date.now() }] };
    const message = await call(runtime, model, context, { maxTokens: outputTokens, reasoning: scorer.reasoning, maxRetries: 0, sessionId }, onRaw,
      { role: 'scorer', attempt: 1, repair: 'specific-rule' });
    const submitted = message.content.filter(part => part.type === 'toolCall');
    if (message.stopReason !== 'toolUse' || submitted.length !== 1 || submitted[0].name !== 'submit_score' || !validScore(submitted[0].arguments)) throw fail('scorer_output_invalid');
    try { if (typeof validate === 'function') validate(submitted[0].arguments); }
    catch (error) {
      if (!['judgment_invalid', 'alternative_unlinked', 'relation_invalid', 'relation_trace_missing'].includes(error?.code)) throw error;
      throw fail('scorer_output_invalid');
    }
    return submitted[0].arguments;
  };
}

/** A scorer submits one structured judgment, with at most one validation-only repair. */
export function createPiScorerJudge({ runtime, model, sessionId, outputTokens, onRaw = async () => {} }) {
  check({ runtime, model, sessionId });
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || typeof onRaw !== 'function') throw fail('scorer_invalid');
  return async ({ packet, answer, trace, scorer, rubric, packetSchema, validate }) => {
    const grounded = scorer?.groundingProtocol === GROUNDING_PROTOCOL;
    const scorerTools = grounded ? SCORER_GROUNDED_TOOLS : SCORER_TOOLS;
    const expectedTools = grounded ? SCORER_GROUNDED_TOOLS_SHA256 : SCORER_TOOLS_SHA256;
    const repair = grounded ? SCORER_GROUNDED_REPAIR : SCORER_REPAIR;
    if (scorer?.route !== model.provider || scorer?.model !== model.id || typeof scorer.instructions !== 'string'
      || (grounded ? scorer.tools_sha256 !== expectedTools : scorer.tools_sha256 !== undefined && scorer.tools_sha256 !== expectedTools)
      || (scorer.formatRepairCalls !== undefined && scorer.formatRepairCalls !== 1)
      || (scorer.repair_instruction !== undefined && scorer.repair_instruction !== repair)) throw fail('scorer_invalid');
    const context = { systemPrompt: scorer.instructions, tools: structuredClone(scorerTools), messages: [{ role: 'user',
      content: JSON.stringify({ packet, answer, trace, rubric, packet_schema: packetSchema }), timestamp: Date.now() }] };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (hash(context.tools) !== expectedTools) throw fail('scorer_tools_mismatch');
      const message = await call(runtime, model, context, { maxTokens: outputTokens, reasoning: scorer.reasoning, maxRetries: 0, sessionId }, onRaw,
        { role: 'scorer', attempt: attempt + 1 });
      context.messages.push(message);
      const calls = message.content.filter(part => part.type === 'toolCall');
      const submission = message.stopReason === 'toolUse' && calls.length === 1 && calls[0].name === 'submit_score' ? calls[0] : null;
      let valid = Boolean(submission && validScore(submission.arguments, grounded));
      if (valid && typeof validate === 'function') {
        try { validate(submission.arguments); }
        catch (error) {
          if (!['judgment_invalid', 'alternative_unlinked', 'relation_invalid', 'relation_trace_missing'].includes(error?.code)) throw error;
          valid = false;
        }
      }
      if (valid) return submission.arguments;
      if (attempt) throw Object.assign(fail('scorer_output_invalid'), { last_message: structuredClone(message) });
      for (const tool of calls) context.messages.push(toolResult(tool, { error: 'invalid_submission' }, true));
      context.messages.push({ role: 'user', content: repair, timestamp: Date.now() });
    }
    throw fail('scorer_output_invalid');
  };
}
