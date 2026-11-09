import { distillThrough } from './core.mjs';

/**
 * The settled message leaf and an immutable copy of the entries, or null when there is no message leaf. By default a summary
 * leaf also yields null; throughSummaries steps past it to the message before it, so a turn that ended in an automatic
 * compaction is covered at this settle rather than the next one.
 */
export function settledSnapshot(ctx, { throughSummaries = false } = {}) {
  const manager = ctx.sessionManager;
  const snapshot = { sessionId: manager.getSessionId(), leafId: manager.getLeafId(), entries: structuredClone(manager.getEntries()) };
  const rows = new Map(snapshot.entries.map(row => [row.id, row]));
  const seen = new Set();
  while (snapshot.leafId && !seen.has(snapshot.leafId)) {
    seen.add(snapshot.leafId);
    const row = rows.get(snapshot.leafId);
    if (!row || (!throughSummaries && (row.type === 'compaction' || row.type === 'branch_summary'))) return null;
    if (row.message) break;
    snapshot.leafId = row.parentId;
  }
  if (!snapshot.leafId || !rows.get(snapshot.leafId)?.message) return null;
  return snapshot;
}

/** Per-session serial queue; work runs after the handler returns and its failures go to onError. */
export function createSessionQueue(onError) {
  const queues = new Map();
  return {
    push(sessionId, task) {
      const previous = queues.get(sessionId) ?? Promise.resolve();
      const work = previous.catch(() => {}).then(task);
      queues.set(sessionId, work);
      void work.catch(error => { try { onError(error); } catch {} }).finally(() => { if (queues.get(sessionId) === work) queues.delete(sessionId); });
      return work;
    },
    pending: () => queues.size,
    drain: () => Promise.allSettled([...queues.values()]),
  };
}

/** Event hooks capture immutable inputs and enqueue work without waiting for model or Memory calls. */
export function registerPiMemory(pi, { prepare, onError = () => {} }) {
  if (!pi || typeof pi.on !== 'function' || typeof prepare !== 'function') throw new Error('extension_invalid');
  const queue = createSessionQueue(onError);
  pi.on('agent_settled', (_event, ctx) => {
    const snapshot = settledSnapshot(ctx);
    if (!snapshot) return;
    queue.push(snapshot.sessionId, async () => {
      const prepared = await prepare(snapshot);
      const result = await distillThrough({ ...prepared, entries: snapshot.entries }, snapshot.leafId, prepared.cursor ?? null);
      await prepared.saveCursor(result.cursor, result);
    });
  });
  return { pending: queue.pending };
}
