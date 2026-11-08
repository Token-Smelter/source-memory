const fail = code => Object.assign(new Error(code), { code });

/** Finish pending indexing and gate searches on the configured visibility checks. */
export async function ensureIndexed(memory, scope, initial, { maxRounds = 32, batchLimit = 256, maxIndexRetries = 0,
  waitForVectors = false, recordIds = [], turnId = null, maxPolls = 120, pollMs = 500 } = {}) {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 128 || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 240
    || !Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 2048 || !Number.isSafeInteger(maxIndexRetries) || maxIndexRetries < 0 || maxIndexRetries > 3
    || !Number.isSafeInteger(pollMs) || pollMs < 0 || pollMs > 10000 || !Array.isArray(recordIds)
    || (turnId !== null && (typeof turnId !== 'string' || !turnId))
    || recordIds.length > 16 || new Set(recordIds).size !== recordIds.length || recordIds.some(id => typeof id !== 'string' || !id)) throw fail('indexing_config_invalid');
  let state = initial, retries = 0;
  for (let round = 0; round <= maxRounds; round++) {
    if (state?.status === 'ready') {
      if (!waitForVectors) return state;
      if (typeof memory.status !== 'function') throw fail('indexing_unavailable');
      for (let poll = 0; poll < maxPolls; poll++) {
        const status = await memory.status(scope);
        if (status?.unindexed === 0 && status.vector_indexes?.chunk === 'online' && status.vector_indexes?.record === 'online') {
          const checks = [];
          if (recordIds.length) {
            if (typeof memory.recordVectorStatus !== 'function') throw fail('indexing_unavailable');
            checks.push(await memory.recordVectorStatus(scope, recordIds));
          }
          if (turnId) {
            if (typeof memory.turnVectorStatus !== 'function') throw fail('indexing_unavailable');
            checks.push(await memory.turnVectorStatus(scope, turnId));
          }
          if (checks.every(visibility => visibility?.visible === true)) return state;
          if (checks.some(visibility => typeof visibility?.visible !== 'boolean')) throw fail('indexing_incomplete');
        }
        if (!Number.isSafeInteger(status?.unindexed) || status.unindexed > 0
          || ['missing', 'failed'].includes(status.vector_indexes?.chunk) || ['missing', 'failed'].includes(status.vector_indexes?.record)) throw fail('indexing_incomplete');
        if (pollMs) await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      throw fail('indexing_wait_timeout');
    }
    if (state?.status === 'unavailable') {
      const reason = typeof state.reason === 'string' && /^[a-z_]+$/.test(state.reason) ? state.reason : 'unknown';
      if (!['model_timeout', 'model_request_failed'].includes(reason) || retries >= maxIndexRetries) throw fail(`indexing_${reason}`);
      retries++; state = { status: 'pending' };
    }
    if (!['pending', 'deferred'].includes(state?.status) || typeof memory.index !== 'function') throw fail('indexing_unavailable');
    if (round === maxRounds) throw fail('indexing_round_limit');
    try { state = await memory.index(scope, { limit: batchLimit }); }
    catch (error) {
      if (error?.code !== 'request_timeout' || retries >= maxIndexRetries) throw fail('indexing_request_failed');
      retries++; state = { status: 'pending' };
    }
  }
  throw fail('indexing_round_limit');
}
