import { performance } from 'node:perf_hooks';
import { distillThrough } from './core.mjs';

/** Replay ordered leaves with the same core and incremental Pi distiller as live capture. */
export async function replay(session, leaves, cursor = null, { maxTurns = 110, onTurn = async () => {} } = {}) {
  if (!Array.isArray(leaves) || leaves.some(leaf => typeof leaf !== 'string' || !leaf)
    || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 110 || typeof onTurn !== 'function') throw new Error('invalid_input');
  const results = [];
  for (const leaf of leaves) {
    if (results.length >= maxTurns) return { status: 'turn_limit', cursor, results };
    const reason = session.budget?.reason();
    if (reason) return { status: reason === 'input_budget_exhausted' ? 'budget_stopped' : 'budget_unknown', cursor, results };
    try {
      const start = performance.now();
      const result = { ...await distillThrough(session, leaf, cursor), elapsed_ms: Math.round(performance.now() - start) };
      await onTurn(result);
      results.push(result);
      cursor = result.cursor;
    } catch (error) {
      const code = session.budget?.reason() ?? error?.code;
      if (code === 'input_budget_exhausted' || code === 'input_budget_unknown') {
        return { status: code === 'input_budget_exhausted' ? 'budget_stopped' : 'budget_unknown', cursor, results, stopped_at: leaf };
      }
      throw error;
    }
  }
  return { status: 'complete', cursor, results };
}
