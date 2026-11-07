const fail = code => Object.assign(new Error(code), { code });

/** Finish explicitly pending indexing; unavailable is a failure, not an automatic retry. */
export async function ensureIndexed(memory, scope, initial, { maxRounds = 32, waitForVectors = false, maxPolls = 120, pollMs = 500 } = {}) {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 128 || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 240
    || !Number.isSafeInteger(pollMs) || pollMs < 0 || pollMs > 10000) throw fail('indexing_config_invalid');
  let state = initial;
  for (let round = 0; round <= maxRounds; round++) {
    if (state?.status === 'ready') {
      if (!waitForVectors) return state;
      if (typeof memory.status !== 'function') throw fail('indexing_unavailable');
      for (let poll = 0; poll < maxPolls; poll++) {
        const status = await memory.status(scope);
        if (status?.unindexed === 0 && status.vector_indexes?.chunk === 'online' && status.vector_indexes?.record === 'online') return state;
        if (!Number.isSafeInteger(status?.unindexed) || status.unindexed > 0
          || ['missing', 'failed'].includes(status.vector_indexes?.chunk) || ['missing', 'failed'].includes(status.vector_indexes?.record)) throw fail('indexing_incomplete');
        if (pollMs) await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      throw fail('indexing_wait_timeout');
    }
    if (state?.status === 'unavailable') {
      const reason = typeof state.reason === 'string' && /^[a-z_]+$/.test(state.reason) ? state.reason : 'unknown';
      throw fail(`indexing_${reason}`);
    }
    if (!['pending', 'deferred'].includes(state?.status) || typeof memory.index !== 'function') throw fail('indexing_unavailable');
    if (round === maxRounds) throw fail('indexing_round_limit');
    state = await memory.index(scope, { limit: 256 });
  }
  throw fail('indexing_round_limit');
}
