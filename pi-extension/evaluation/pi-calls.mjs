import { hash } from './seal.mjs';
import { METERED_RUNTIME } from './pi-wrapper.mjs';

const fail = code => Object.assign(new Error(code), { code });
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
export const ANSWERER_TOOLS = Object.freeze([
  { name: 'memory_search', description: 'Search the permitted derived-memory items.', parameters: schema({ query: string }) },
  { name: 'memory_resolve', description: 'Resolve evidence for an item returned by memory_search.', parameters: schema({ item_id: string, evidence_id: string }) },
]);
export const ANSWERER_TOOLS_SHA256 = hash(ANSWERER_TOOLS);

function check({ runtime, model, sessionId }) {
  if (runtime?.[METERED_RUNTIME] !== true || typeof runtime.streamSimple !== 'function'
    || !model?.provider || !model?.id || typeof sessionId !== 'string' || !sessionId) throw fail('metered_pi_runtime_required');
}
function resultText(message) {
  if (!Array.isArray(message?.content)) throw fail('model_output_invalid');
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}
async function call(runtime, model, context, options) {
  const stream = runtime.streamSimple(model, context, options);
  if (!stream || typeof stream.result !== 'function') throw fail('pi_stream_invalid');
  const message = await stream.result();
  if (!message || message.role !== 'assistant' || message.provider !== model.provider || message.model !== model.id
    || ['error', 'aborted', 'length', 'deferred'].includes(message.stopReason)) throw fail('model_call_incomplete');
  return message;
}

/** The respond callback consumes only the question, sealed settings and bounded tools supplied by createAnswerer. */
export function createPiAnswererResponder({ runtime, model, sessionId, expectedToolsSha256 }) {
  check({ runtime, model, sessionId });
  if (expectedToolsSha256 !== ANSWERER_TOOLS_SHA256) throw fail('answerer_tools_mismatch');
  return async ({ request, instructions, route, model: id, reasoning, inputTokens, outputTokens, modelCalls, costNano, tools }) => {
    if (hash(ANSWERER_TOOLS) !== expectedToolsSha256) throw fail('answerer_tools_mismatch');
    if (route !== model.provider || id !== model.id || typeof request !== 'string' || typeof instructions !== 'string'
      || !Number.isSafeInteger(inputTokens) || inputTokens < 1 || !/^[1-9]\d*$/.test(costNano ?? '')
      || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || !Number.isSafeInteger(modelCalls) || modelCalls < 1
      || typeof tools?.search !== 'function' || typeof tools?.resolve !== 'function') throw fail('answerer_invalid');
    const context = { systemPrompt: instructions, tools: ANSWERER_TOOLS,
      messages: [{ role: 'user', content: request, timestamp: Date.now() }] };
    let usedInput = 0, usedCost = 0n;
    for (let count = 0; count < modelCalls; count++) {
      if (usedInput >= inputTokens || usedCost >= BigInt(costNano)) throw fail('answer_budget_exceeded');
      const message = await call(runtime, model, context, { maxTokens: outputTokens, reasoning, maxRetries: 0, sessionId });
      const usage = message.usage;
      if (!['input', 'cacheRead', 'cacheWrite'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)
        || typeof usage?.cost?.total !== 'number' || !Number.isFinite(usage.cost.total) || usage.cost.total < 0) throw fail('usage_unknown');
      usedInput += usage.input + usage.cacheRead + usage.cacheWrite;
      usedCost += BigInt(Math.ceil(usage.cost.total * 1_000_000_000));
      if (usedInput > inputTokens || usedCost > BigInt(costNano)) throw fail('answer_budget_exceeded');
      context.messages.push(message);
      const calls = message.content.filter(part => part.type === 'toolCall');
      if (!calls.length) {
        if (message.stopReason !== 'stop') throw fail('answer_incomplete');
        return { text: resultText(message) };
      }
      if (message.stopReason !== 'toolUse') throw fail('answer_incomplete');
      for (const tool of calls) {
        let value;
        if (tool.name === 'memory_search' && Object.keys(tool.arguments ?? {}).join(',') === 'query'
          && typeof tool.arguments.query === 'string') value = await tools.search(tool.arguments.query);
        else if (tool.name === 'memory_resolve' && Object.keys(tool.arguments ?? {}).sort().join(',') === 'evidence_id,item_id'
          && typeof tool.arguments.item_id === 'string' && typeof tool.arguments.evidence_id === 'string') {
          value = await tools.resolve(tool.arguments.item_id, tool.arguments.evidence_id);
        } else throw fail('tool_call_invalid');
        context.messages.push({ role: 'toolResult', toolCallId: tool.id, toolName: tool.name,
          content: [{ type: 'text', text: JSON.stringify(value) }], isError: false, timestamp: Date.now() });
      }
    }
    throw fail('model_call_limit');
  };
}

/** Scoring uses a separate, tool-free Pi model call with the sealed rubric and evidence packet. */
export function createPiScorerJudge({ runtime, model, sessionId, outputTokens }) {
  check({ runtime, model, sessionId });
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1) throw fail('scorer_invalid');
  return async ({ packet, answer, trace, scorer, rubric, packetSchema }) => {
    if (scorer?.route !== model.provider || scorer?.model !== model.id || typeof scorer.instructions !== 'string') throw fail('scorer_invalid');
    const context = { systemPrompt: scorer.instructions, tools: [], messages: [{ role: 'user',
      content: JSON.stringify({ packet, answer, trace, rubric, packet_schema: packetSchema }), timestamp: Date.now() }] };
    const message = await call(runtime, model, context, { maxTokens: outputTokens, reasoning: scorer.reasoning, maxRetries: 0, sessionId });
    if (message.stopReason !== 'stop' || message.content.some(part => part.type === 'toolCall')) throw fail('scorer_output_invalid');
    try { return JSON.parse(resultText(message)); } catch { throw fail('scorer_output_invalid'); }
  };
}
