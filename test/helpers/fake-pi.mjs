// Fictional offline Pi model routes: no network, no credentials, scripted assistant messages.
const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const fictionModel = { provider: 'fiction', id: 'model', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', contextWindow: 100000,
  maxTokens: 1000, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

const assistant = (content, stopReason) => ({ role: 'assistant', provider: fictionModel.provider, model: fictionModel.id, api: fictionModel.api,
  timestamp: Date.now(), stopReason, usage, content });

/** next(context) returns the assistant content and stop reason for each call; it may be async to hold a call open. */
export function scriptedRuntime(next) {
  return { hasConfiguredAuth() { return true; }, streamSimple(_model, context) {
    let finish;
    const result = new Promise(resolve => { finish = resolve; });
    return { result: () => result, async *[Symbol.asyncIterator]() {
      const { content, stopReason } = await next(context);
      const message = assistant(content, stopReason);
      yield { type: 'start', partial: message };
      finish(message);
      yield { type: 'done', reason: stopReason, message };
    } };
  } };
}

/** The host assistant answers every prompt with a fictional text reply. */
export const hostRuntime = () => scriptedRuntime(async () => ({ content: [{ type: 'text', text: 'Fictional reply.' }], stopReason: 'stop' }));

/** Distiller script: search, record one observation on the first offered label, submit, stop. */
export function distillerRuntime({ before = async () => {} } = {}) {
  return scriptedRuntime(async context => {
    const messages = context.messages ?? [];
    const lastUser = messages.findLastIndex(row => row.role === 'user');
    const results = messages.slice(lastUser + 1).filter(row => row.role === 'toolResult').length;
    if (results === 0) {
      await before();
      return { content: [{ type: 'toolCall', id: 'search', name: 'memory_search', arguments: { query: 'fictional', kinds: [] } }], stopReason: 'toolUse' };
    }
    if (results === 1) return { content: [{ type: 'toolCall', id: 'record', name: 'memory_record',
      arguments: { kind: 'observation', text: 'The fictional user prefers amber dashboards.', evidence_labels: ['ref-000001'] } }], stopReason: 'toolUse' };
    if (results === 2) return { content: [{ type: 'toolCall', id: 'submit', name: 'memory_submit',
      arguments: { result: 'done_with_writes', reason: 'A fictional preference affects later work.' } }], stopReason: 'toolUse' };
    return { content: [{ type: 'text', text: 'Submitted.' }], stopReason: 'stop' };
  });
}

/** createLiveExtension resolveModels stand-in: both routes are the fictional model on one scripted runtime. */
export const fakeModels = runtime => async () => ({ runtime, model: fictionModel, reviewerModel: fictionModel });

/** A host Pi session that loads extension factories through Pi's own resource loader and persists its session file. */
export async function hostSession(pi, { cwd, agentDir, sessionDir, factories = [], extensionPaths = [], sessionFile }) {
  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true,
    noContextFiles: true, ...(extensionPaths.length ? { additionalExtensionPaths: extensionPaths } : { noExtensions: true }), extensionFactories: factories });
  await resourceLoader.reload();
  const sessionManager = sessionFile ? pi.SessionManager.open(sessionFile, sessionDir) : pi.SessionManager.create(cwd, sessionDir);
  const { session } = await pi.createAgentSession({ cwd, agentDir, model: fictionModel, modelRuntime: hostRuntime(), tools: [], sessionManager,
    resourceLoader, settingsManager });
  return { session, sessionManager, resourceLoader };
}
