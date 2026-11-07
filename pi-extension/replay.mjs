import { performance } from 'node:perf_hooks';
import { distillThrough } from './core.mjs';
import { runCoveredInterval } from './coverage.mjs';

/** Replay ordered leaves with the same core and incremental Pi distiller as live capture. */
export async function replay(session, leaves, cursor = null, { maxTurns = 110, onTurn = async () => {} } = {}) {
  const validLeaf = leaf => typeof leaf === 'string' ? !!leaf : leaf && typeof leaf === 'object'
    && typeof leaf.through === 'string' && !!leaf.through && typeof leaf.interrupted === 'boolean'
    && Object.keys(leaf).every(key => ['through', 'interrupted'].includes(key));
  if (!Array.isArray(leaves) || leaves.some(leaf => !validLeaf(leaf))
    || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 110 || typeof onTurn !== 'function') throw new Error('invalid_input');
  const results = [];
  for (const leaf of leaves) {
    const through = typeof leaf === 'string' ? leaf : leaf.through;
    const allowInterrupted = typeof leaf === 'object' && leaf.interrupted;
    if (results.length >= maxTurns) return { status: 'turn_limit', cursor, results };
    const reason = session.budget?.reason();
    if (reason) return { status: reason === 'input_budget_exhausted' ? 'budget_stopped' : 'budget_unknown', cursor, results };
    try {
      const start = performance.now();
      const result = { ...(session.coverageJournal
        ? await runCoveredInterval({ journal: session.coverageJournal, session, through, cursor, allowInterrupted })
        : await distillThrough(session, through, cursor, { allowInterrupted })), elapsed_ms: Math.round(performance.now() - start) };
      await onTurn(result);
      results.push(result);
      if (session.coverageJournal && !['committed', 'abstained', 'ineligible_by_policy'].includes(result.disposition)) {
        return { status: result.disposition, cursor, results, stopped_at: through };
      }
      cursor = result.cursor;
    } catch (error) {
      const code = session.budget?.reason() ?? error?.code;
      if (code === 'input_budget_exhausted' || code === 'input_budget_unknown') {
        return { status: code === 'input_budget_exhausted' ? 'budget_stopped' : 'budget_unknown', cursor, results, stopped_at: through };
      }
      throw error;
    }
  }
  return { status: 'complete', cursor, results };
}
