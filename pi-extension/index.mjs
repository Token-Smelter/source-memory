import { distillThrough } from './core.mjs';

/** Event hooks capture immutable inputs and enqueue work without waiting for model or Memory calls. */
export function registerPiMemory(pi, { prepare, onError = () => {} }) {
  if (!pi || typeof pi.on !== 'function' || typeof prepare !== 'function') throw new Error('extension_invalid');
  const queues = new Map();
  pi.on('agent_settled', (_event, ctx) => {
    const manager = ctx.sessionManager;
    const snapshot = { sessionId: manager.getSessionId(), leafId: manager.getLeafId(), entries: structuredClone(manager.getEntries()) };
    const rows = new Map(snapshot.entries.map(row => [row.id, row]));
    const seen = new Set();
    while (snapshot.leafId && !seen.has(snapshot.leafId)) {
      seen.add(snapshot.leafId);
      const row = rows.get(snapshot.leafId);
      if (!row || row.type === 'compaction' || row.type === 'branch_summary') return;
      if (row.message) break;
      snapshot.leafId = row.parentId;
    }
    if (!snapshot.leafId || !rows.get(snapshot.leafId)?.message) return;
    const previous = queues.get(snapshot.sessionId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const prepared = await prepare(snapshot);
      const result = await distillThrough({ ...prepared, entries: snapshot.entries }, snapshot.leafId, prepared.cursor ?? null);
      await prepared.saveCursor(result.cursor, result);
    });
    queues.set(snapshot.sessionId, work);
    void work.catch(error => { try { onError(error); } catch {} }).finally(() => { if (queues.get(snapshot.sessionId) === work) queues.delete(snapshot.sessionId); });
  });
  return { pending: () => queues.size };
}
