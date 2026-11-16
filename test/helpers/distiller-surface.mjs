import { createHash } from 'node:crypto';
import { compactResult } from './compact-fixture.mjs';

/** Fictional single-turn fixtures for exercising the distiller's tool surface without a model. */
export const surfaceTurn = { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fictional choice replaces the earlier fictional choice.' }] };
const retrieval = { status: 'selected', relationship_context_complete: false, completeness_guaranteed: false,
  budget_omitted: 0, omitted_prior_records: 0, omitted_prior_spans: 0, trigger_omissions: [] };
export const surfacePacket = { records: [
  { ref: 'r0', kind: 'decision', text: 'Fictional new choice.', newly_retained: true, evidence: ['s0'] },
  { ref: 'r1', kind: 'decision', text: 'Fictional prior choice.', newly_retained: false, evidence: ['s1'] },
  { ref: 'r2', kind: 'observation', text: 'Fictional prior fact.', newly_retained: false, evidence: ['s2'] }],
sources: [{ ref: 's0', role: 'user', text: 'Fictional choice.', trigger: true }, { ref: 's1', role: 'user', text: 'Earlier.', trigger: false },
  { ref: 's2', role: 'tool', text: 'Fact.', trigger: false }], retrieval };

export function surfaceMemory({ calls = [], validate = null } = {}) {
  return {
    async searchCompact() { return compactResult({ records: [{ id: 'prior-1', kind: 'decision', text: 'Fictional prior choice.' },
      { id: 'prior-2', kind: 'observation', text: 'Fictional prior fact.' }] }); },
    async enrich() { return {}; }, async cancelLinks() { calls.push('cancel'); },
    async beginLinks() { calls.push('offer'); return { token: `offer-${calls.length}`, packet: structuredClone(surfacePacket) }; },
    // Stands in for the Memory process, which runs the same proposal validator after submit.
    async finishLinks(token, output) {
      calls.push('finish');
      const checked = validate ? validate(output, surfacePacket) : { proposals: [], unresolved: [] };
      return { contract: 'fiction', review_contract: 'fiction', operation_id: 'op', context_sha256: 'c', semantic_proposal_sha256: 's',
        proposal_sha256: 'p', ...checked };
    },
    async applyLinks(token, review) { calls.push('apply'); return { status: 'written', approved: review.approved }; },
  };
}

/**
 * Runs the distiller once per script with a fake Pi session that calls the registered tools directly, and returns what a
 * treatment could change: the checkpoint prompt, the tool list, every registered tool's description and schema, each tool
 * response and the run result.
 */
export async function distillerSurface(createPiDistiller, { options = {}, scripts, memory = surfaceMemory(), reviewer = null }) {
  const registered = new Map(), prompts = [], toolLists = [];
  const api = { on() {}, registerTool(tool) { registered.set(tool.name, tool); } };
  class Loader { constructor(loaderOptions) { this.options = loaderOptions; } async reload() { this.options.extensionFactories[0](api); } }
  const manager = { getSessionId: () => 'distiller-id', branch() {}, buildSessionContext: () => ({ messages: [] }) };
  const call = async (name, args) => {
    try { return { ok: JSON.parse((await registered.get(name).execute('id', args)).content[0].text) }; }
    catch (error) { return { error: error.message }; }
  };
  let transcript = [];
  let script = null;
  const session = () => ({ sessionId: 'distiller-id', agent: { sessionId: 'distiller-id', state: {} }, messages: [], async prompt(text) {
    prompts.push(text);
    await script(async (name, args) => { const result = await call(name, args); transcript.push([name, result]); return result; });
    this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Submitted.' }] }];
  } });
  const pi = { SessionManager: { open: () => manager }, SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: Loader,
    async createAgentSession(sessionOptions) { toolLists.push(sessionOptions.tools); return { session: session() }; } };
  const runtime = await createPiDistiller({ pi, incremental: { sessionId: 'distiller-id', async syncThrough() { return { file: '/fiction/private' }; } },
    workDir: '/fiction/work', model: { provider: 'fiction', id: 'fiction' }, memory, scope: 'fiction', reviewer, ...options });
  const runs = [];
  for (const next of scripts) {
    script = next;
    transcript = [];
    const result = await runtime.run({ throughEntryId: 'a2', turn: surfaceTurn, receipt: { id: 'turn' } });
    runs.push({ prompt: prompts.at(-1), tools: toolLists.at(-1), transcript, result });
  }
  const registry = [...registered].map(([name, tool]) => ({ name, description: tool.description, parameters: tool.parameters }));
  return { runs, registry };
}

export const surfaceDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The baseline scenarios whose surface is pinned: one checkpoint without a link, one with a reviewed link. */
export const baselineScripts = [
  async call => {
    const found = await call('memory_search', { query: 'fiction', kinds: [] });
    await call('memory_record', { kind: 'decision', text: 'Fictional new choice.', evidence_labels: ['ref-000001'] });
    await call('memory_link_offer', { handles: found.ok.records.map(row => row.id) });
    await call('memory_submit', { result: 'done_with_writes', reason: 'Fiction.' });
  },
  async call => {
    const found = await call('memory_search', { query: 'fiction', kinds: [] });
    await call('memory_record', { kind: 'decision', text: 'Fictional new choice.', evidence_labels: ['ref-000001'] });
    await call('memory_link_offer', { handles: found.ok.records.map(row => row.id) });
    await call('memory_link', { from: 'r0', to: 'r1', type: 'supersedes', evidence: ['s0'], support: 'explicit' });
    await call('memory_submit', { result: 'done_with_writes', reason: 'Fiction.' });
  },
];
export const approvingReviewer = { async review() { return { approved: [0], reviewer: 'fiction', decision_ref: 'fiction' }; } };
