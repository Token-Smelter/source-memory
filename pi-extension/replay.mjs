import { distillThrough } from './core.mjs';

/** Replay ordered leaves with the same core and incremental Pi distiller as live capture. */
export async function replay(session, leaves, cursor = null) {
  if (!Array.isArray(leaves) || leaves.some(leaf => typeof leaf !== 'string' || !leaf)) throw new Error('invalid_input');
  const results = [];
  for (const leaf of leaves) {
    const result = await distillThrough(session, leaf, cursor);
    results.push(result);
    cursor = result.cursor;
  }
  return { cursor, results };
}
