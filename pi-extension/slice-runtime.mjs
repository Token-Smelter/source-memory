import { createIncrementalSession } from './incremental.mjs';
import { createPiDistiller } from './pi-runtime.mjs';
import { createPiReviewer } from './reviewer.mjs';
import { boundPiRuntime, createInputBudget } from './budget.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** The smallest ordinary dev evidence session is selected without reading holdout session bytes. */
export function selectSlice({ corpus, cases }) {
  if (!Array.isArray(corpus?.sessions) || !Array.isArray(corpus.holdout_source_files) || !Array.isArray(cases)) throw fail('corpus_invalid');
  const held = new Set(corpus.holdout_source_files);
  const candidates = corpus.sessions.filter(row => row.role === 'evidence' && row.fixed_split === 'development' && row.class === 'ordinary'
    && typeof row.file === 'string' && Number.isSafeInteger(row.bytes) && row.bytes > 0);
  if (candidates.some(row => held.has(row.file))) throw fail('holdout_refused');
  candidates.sort((a, b) => a.bytes - b.bytes || a.file.localeCompare(b.file));
  const source = candidates[0];
  if (!source) throw fail('source_unavailable');
  const selectedCases = cases.filter(item => item.split === 'development' && item.required_evidence?.some(span => span.file === source.file));
  if (!selectedCases.length) throw fail('cases_unavailable');
  return { source, cases: selectedCases };
}

/** Model routes and auth are resolved by Pi's host runtime; no credential is copied into the driver. */
export async function resolvePiModels({ pi, modelId = 'anthropic/claude-haiku-5-5', reviewerId }) {
  if (!pi?.ModelRuntime || typeof reviewerId !== 'string' || !reviewerId) throw fail('model_route_invalid');
  const runtime = await pi.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const resolve = async selected => {
    const models = runtime.getModels();
    const qualified = models.filter(item => `${item.provider}/${item.id}` === selected);
    const matches = qualified.length ? qualified : models.filter(item => item.id === selected);
    if (!matches.length) throw fail('model_not_found');
    if (matches.length !== 1) throw fail('model_ambiguous');
    if (!(await runtime.checkAuth(matches[0].provider))) throw fail('auth_unavailable');
    return matches[0];
  };
  return { runtime, model: await resolve(modelId), reviewerModel: await resolve(reviewerId) };
}

/** Builds the same incremental private session used by the live adapter and replay core. */
export async function createSliceSession({ pi, source, entries, conversationId, workDir, scope, memory,
  modelId = 'anthropic/claude-haiku-5-5', reviewerId, reviewMode = 'separate', budget = createInputBudget() }) {
  const { runtime, model, reviewerModel } = await resolvePiModels({ pi, modelId, reviewerId });
  const boundedRuntime = boundPiRuntime(runtime, budget);
  const incremental = await createIncrementalSession({ source, workDir });
  const reviewer = createPiReviewer({ pi, workDir, model: reviewerModel, modelRuntime: boundedRuntime, budget });
  const distiller = await createPiDistiller({ pi, incremental, workDir, model, modelRuntime: boundedRuntime, memory, scope, reviewer, budget, reviewMode });
  return { entries, conversation_id: conversationId, scopes: [scope], memory, distiller, budget };
}
