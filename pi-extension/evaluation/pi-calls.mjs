import { hash } from './seal.mjs';
import { METERED_RUNTIME } from './pi-wrapper.mjs';

const fail = code => Object.assign(new Error(code), { code });
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' }, strings = { type: 'array', items: string };
const grades = { type: 'string', enum: ['pass', 'fail', 'uncertain'] };
const judgmentSchema = schema({ clauses: { type: 'array', items: schema({ id: string, text: string, requirementIds: strings, sourceIds: strings,
  action: { type: 'boolean' }, judgments: schema({ support: grades, authority: grades, scope: grades, time: grades, uncertainty: grades }),
  alternative: { anyOf: [{ type: 'null' }, schema({ rationale: string, sourceIds: strings })] },
  relation: { anyOf: [{ type: 'null' }, schema({ required: { type: 'boolean' }, recoverable: { anyOf: [{ type: 'boolean' }, { type: 'null' }] }, itemIds: strings })] } }) } });
export const ANSWERER_TOOLS = Object.freeze([
  { name: 'memory_search', description: 'Search permitted derived-memory items; after the fixed item budget is spent, later searches return a budget-exhausted result.', parameters: schema({ query: string }) },
  { name: 'memory_resolve', description: 'Resolve evidence for an item returned by memory_search.', parameters: schema({ item_id: string, evidence_id: string }) },
  { name: 'submit_answer', description: 'Submit the final answer after using any necessary retrieval tools.', parameters: schema({ answer: string }) },
]);
export const SCORER_TOOLS = Object.freeze([{ name: 'submit_score', description: 'Submit the complete clause-level judgment.', parameters: judgmentSchema }]);
export const ANSWERER_TOOLS_SHA256 = hash(ANSWERER_TOOLS);
export const ANSWERER_TOOLS_V2_SHA256 = hash([{ ...ANSWERER_TOOLS[0], description: 'Search the permitted derived-memory items.' }, ...ANSWERER_TOOLS.slice(1)]);
export const SCORER_TOOLS_SHA256 = hash(SCORER_TOOLS);
export const ANSWERER_FORMAT_SUFFIX = ' Submit the final answer with the submit_answer tool.';
export const ANSWERER_BUDGET_SUFFIX = ' If the item budget is exhausted, answer from retrieved items or state uncertainty.';
export const SCORER_FORMAT_SUFFIX = ' Submit the complete judgment with the submit_score tool.';
export const ANSWERER_REPAIR = 'The previous output was not a valid final submission. Call submit_answer with the complete answer; do not change its substance merely to fix formatting.';
export const SCORER_REPAIR = 'The previous submission was invalid. Call submit_score with the complete judgment matching the schema and supplied IDs; retain substantive judgments unless correction is required for validity.';

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
function validScore(value) {
  const dimensions = ['support', 'authority', 'scope', 'time', 'uncertainty'];
  return exact(value, ['clauses']) && Array.isArray(value.clauses) && value.clauses.every(c => exact(c,
    ['id', 'text', 'requirementIds', 'sourceIds', 'action', 'judgments', 'alternative', 'relation'])
    && typeof c.id === 'string' && c.id.trim() && typeof c.text === 'string' && c.text.trim() && typeof c.action === 'boolean'
    && Array.isArray(c.requirementIds) && c.requirementIds.every(x => typeof x === 'string')
    && Array.isArray(c.sourceIds) && c.sourceIds.every(x => typeof x === 'string') && exact(c.judgments, dimensions)
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
  if (expectedToolsSha256 !== ANSWERER_TOOLS_SHA256 || typeof onRaw !== 'function') throw fail('answerer_tools_mismatch');
  return async ({ request, instructions, route, model: id, reasoning, inputTokens, outputTokens, modelCalls, formatRepairCalls = 1,
    repairInstruction = null, costNano, tools }) => {
    if (hash(ANSWERER_TOOLS) !== expectedToolsSha256) throw fail('answerer_tools_mismatch');
    if (route !== model.provider || id !== model.id || typeof request !== 'string' || typeof instructions !== 'string'
      || !Number.isSafeInteger(inputTokens) || inputTokens < 1 || !/^[1-9]\d*$/.test(costNano ?? '')
      || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || !Number.isSafeInteger(modelCalls) || modelCalls < 1
      || formatRepairCalls !== 1 || (repairInstruction !== null && repairInstruction !== ANSWERER_REPAIR)
      || typeof tools?.search !== 'function' || typeof tools?.resolve !== 'function') throw fail('answerer_invalid');
    const context = { systemPrompt: instructions, tools: ANSWERER_TOOLS, messages: [{ role: 'user', content: request, timestamp: Date.now() }] };
    let usedInput = 0, usedCost = 0n, repairs = 0;
    for (let count = 0; count < modelCalls + 1; count++) {
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
        if (tool.name === 'submit_answer' && calls.length === 1 && index === 0 && exact(args, ['answer'])
          && typeof args.answer === 'string' && args.answer.trim() && Buffer.byteLength(args.answer) <= 32000 && !invalid) return { text: args.answer };
        if (tool.name === 'memory_search' && exact(args, ['query']) && typeof args.query === 'string' && !invalid) {
          try { context.messages.push(toolResult(tool, await tools.search(args.query))); }
          catch (error) {
            if (error?.code !== 'item_limit') throw error;
            context.messages.push(toolResult(tool, { status: 'item_budget_exhausted',
              instruction: 'Answer from retrieved items or state uncertainty.' }));
          }
        } else if (tool.name === 'memory_resolve' && exact(args, ['item_id', 'evidence_id'])
          && typeof args.item_id === 'string' && typeof args.evidence_id === 'string' && !invalid) {
          context.messages.push(toolResult(tool, await tools.resolve(args.item_id, args.evidence_id)));
        } else { invalid = true; context.messages.push(toolResult(tool, { error: 'invalid_submission' }, true)); }
      }
      if (invalid) {
        if (repairs++) throw fail('answer_output_invalid');
        context.messages.push({ role: 'user', content: ANSWERER_REPAIR, timestamp: Date.now() });
      }
    }
    throw fail('model_call_limit');
  };
}

/** A scorer submits one structured judgment, with at most one validation-only repair. */
export function createPiScorerJudge({ runtime, model, sessionId, outputTokens, onRaw = async () => {} }) {
  check({ runtime, model, sessionId });
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || typeof onRaw !== 'function') throw fail('scorer_invalid');
  return async ({ packet, answer, trace, scorer, rubric, packetSchema, validate }) => {
    if (scorer?.route !== model.provider || scorer?.model !== model.id || typeof scorer.instructions !== 'string'
      || (scorer.tools_sha256 !== undefined && scorer.tools_sha256 !== SCORER_TOOLS_SHA256)
      || (scorer.formatRepairCalls !== undefined && scorer.formatRepairCalls !== 1)
      || (scorer.repair_instruction !== undefined && scorer.repair_instruction !== SCORER_REPAIR)) throw fail('scorer_invalid');
    const context = { systemPrompt: scorer.instructions, tools: SCORER_TOOLS, messages: [{ role: 'user',
      content: JSON.stringify({ packet, answer, trace, rubric, packet_schema: packetSchema }), timestamp: Date.now() }] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const message = await call(runtime, model, context, { maxTokens: outputTokens, reasoning: scorer.reasoning, maxRetries: 0, sessionId }, onRaw,
        { role: 'scorer', attempt: attempt + 1 });
      context.messages.push(message);
      const calls = message.content.filter(part => part.type === 'toolCall');
      const submission = message.stopReason === 'toolUse' && calls.length === 1 && calls[0].name === 'submit_score' ? calls[0] : null;
      let valid = Boolean(submission && validScore(submission.arguments));
      if (valid && typeof validate === 'function') {
        try { validate(submission.arguments); }
        catch (error) {
          if (!['judgment_invalid', 'alternative_unlinked', 'relation_invalid', 'relation_trace_missing'].includes(error?.code)) throw error;
          valid = false;
        }
      }
      if (valid) return submission.arguments;
      if (attempt) throw fail('scorer_output_invalid');
      for (const tool of calls) context.messages.push(toolResult(tool, { error: 'invalid_submission' }, true));
      context.messages.push({ role: 'user', content: SCORER_REPAIR, timestamp: Date.now() });
    }
    throw fail('scorer_output_invalid');
  };
}
