import { performance } from 'node:perf_hooks';
import neo4j from 'neo4j-driver';
import { authorize, integer, MemoryError, requireThat } from './core.mjs';
import { chunkPolicy, DEFAULT_TREATMENT, TOKEN_POLICY, verifiedCounter } from './chunk-policy.mjs';
import { embeddingIdentity } from './models.mjs';

// Names the report contract. Counts describe stored chunk text under today's verified tokenizer contract; they do not say
// what an earlier writer sent to or received from the embedder.
export const OVER_CONTEXT_COUNT = 'source-memory.over-context-count/1';
export const PAGE_MAX = 500;
// Over-context buckets as multiples of the context: (1, 1.5], (1.5, 2], (2, 3], above 3.
const HISTOGRAM = [1.5, 2, 3, Infinity];
// The only codes the count reports; anything else is count_failed, so no message can carry stored text.
export const COUNT_ERRORS = ['invalid_input', 'scope_denied', 'scope_required', 'token_policy_required', 'count_contract_mismatch',
  'invalid_chunk_tokenizer', 'invalid_chunk_token_cap', 'invalid_model_endpoint', 'model_endpoint_must_be_loopback',
  'database_config_required', 'invalid_database_uri', 'database_must_be_loopback', 'database_credentials_unavailable', 'count_failed'];

/** Finite absolute caps, all required; nothing defaults to unbounded. */
export function countCaps(input) {
  requireThat(input && typeof input === 'object', 'invalid_input');
  return {
    max_rows: integer(input.max_rows, undefined, 1, 10_000_000),
    max_text_bytes: integer(input.max_text_bytes, undefined, 1, 100_000_000_000),
    max_pages: integer(input.max_pages, undefined, 1, 1_000_000),
    page_size: integer(input.page_size, undefined, 1, PAGE_MAX),
    max_seconds: integer(input.max_seconds, undefined, 1, 86_400),
    transaction_timeout_ms: integer(input.transaction_timeout_ms, undefined, 1, 600_000),
  };
}

// No totals or progress counters on an incomplete pass.
const incomplete = reason => ({ contract: OVER_CONTEXT_COUNT, status: 'incomplete', reason });

/**
 * Counts one exact scope's stored chunks against the token cap and the context, through `reader`:
 * `{ total(timeoutMs): Promise<number>, page(after, limit, timeoutMs): Promise<[{uid, text, current_vector}]> }`.
 * One monotonic budget of max_seconds covers tokenizer verification, both totals, every page and all processing; each read
 * gets at most the remaining budget, and a pass that ends late is refused. Pages are separate snapshots. Any cap, read
 * failure, malformed row, unverified contract or changed total yields `incomplete`. Identifiers and texts never leave.
 */
export async function countOverContext({ policy, reader, caps: input, clock = () => performance.now() }) {
  const caps = countCaps(input);
  const deadline = clock() + caps.max_seconds * 1000;
  const remaining = () => Math.floor(deadline - clock());
  const timeout = () => Math.min(caps.transaction_timeout_ms, remaining());
  const resolved = await verifiedCounter(policy);
  if (!resolved.counter) return incomplete('tokenizer_unavailable');
  if (remaining() <= 0) return incomplete('cap_seconds');
  const { counter } = resolved;
  const cap = policy.descriptor.token_cap;
  const context = resolved.context;
  const counts = { within_cap: 0, over_cap_within_context: 0, over_context_with_current_vector: 0, over_context_without_current_vector: 0 };
  const histogram = HISTOGRAM.map((factor, index) => ({ low: Math.floor(context * (index ? HISTOGRAM[index - 1] : 1)) + 1,
    high: Number.isFinite(factor) ? Math.floor(context * factor) : null, chunks: 0 }));
  let excess = 0, overContextTokens = 0, exactlyCounted = 0, rows = 0, pages = 0, fetchedBytes = 0;
  let totalBefore;
  try { totalBefore = await reader.total(timeout()); } catch { return incomplete('read_failed'); }
  if (remaining() <= 0) return incomplete('cap_seconds');
  if (!Number.isSafeInteger(totalBefore) || totalBefore < 0) return incomplete('read_failed');
  if (totalBefore > caps.max_rows) return incomplete('cap_rows');
  for (let after = null; ;) {
    if (pages >= caps.max_pages) return incomplete('cap_pages');
    if (remaining() <= 0) return incomplete('cap_seconds');
    let page;
    try { page = await reader.page(after, caps.page_size, timeout()); } catch { return incomplete('read_failed'); }
    pages++;
    if (!Array.isArray(page) || page.length > caps.page_size) return incomplete('read_failed');
    for (const row of page) {
      if (typeof row?.uid !== 'string' || typeof row.text !== 'string' || typeof row.current_vector !== 'boolean'
          || (after !== null && row.uid <= after)) return incomplete('read_failed');
      after = row.uid;
      rows++;
      if (rows > caps.max_rows) return incomplete('cap_rows');
      fetchedBytes += Buffer.byteLength(row.text);
      if (fetchedBytes > caps.max_text_bytes) return incomplete('cap_text_bytes');
      // The bound never undercounts, so a text whose bound fits the cap fits both limits without an exact count.
      if (counter.bound(row.text) <= cap) { counts.within_cap++; continue; }
      const tokens = counter.count(row.text);
      exactlyCounted++;
      if (tokens <= cap) counts.within_cap++;
      else if (tokens <= context) counts.over_cap_within_context++;
      else {
        counts[row.current_vector ? 'over_context_with_current_vector' : 'over_context_without_current_vector']++;
        excess += tokens - context;
        overContextTokens += tokens;
        histogram.find(bucket => tokens >= bucket.low && (bucket.high === null || tokens <= bucket.high)).chunks++;
      }
    }
    if (remaining() <= 0) return incomplete('cap_seconds');
    if (page.length < caps.page_size) break;
  }
  let totalAfter;
  try { totalAfter = await reader.total(timeout()); } catch { return incomplete('read_failed'); }
  if (totalAfter !== totalBefore || rows !== totalBefore) return incomplete('total_changed');
  // A result produced after the budget is refused, even if every read succeeded.
  if (remaining() <= 0) return incomplete('cap_seconds');
  return {
    contract: OVER_CONTEXT_COUNT, status: 'complete', cut: 'separate_pages',
    contract_binding: { policy_digest: policy.digest, tokenizer_sha256: policy.descriptor.tokenizer_sha256,
      served_blob: policy.descriptor.served_blob, token_cap: cap, context },
    chunks: rows, exactly_counted: exactlyCounted, ...counts,
    over_context_histogram: histogram,
    excess_tokens: { sum: excess, denominator_tokens: overContextTokens },
    // Text bytes received after fetching; network transfer and database work are not measured, only bounded by page size,
    // page count and each transaction's timeout.
    post_fetch_text_bytes: fetchedBytes, transfer_and_database_work: 'not_measured',
    pages, totals: { before: totalBefore, after: totalAfter },
  };
}

// The stored vector state of one row: current under this key, or not. An unreadable or ambiguous state is refused.
function currentVector(kind, key, embeddingKey) {
  if (kind === 'none') {
    requireThat(key === null || typeof key === 'string', 'count_failed');
    return false;
  }
  requireThat(kind === 'list' && typeof key === 'string', 'count_failed');
  return key === embeddingKey;
}

/** A reader over one exact scope's `SMChunk` rows. It returns text and a current-key flag, never vectors. No read retries. */
export function neo4jChunkReader(driver, database, scope, embeddingKey) {
  const run = async (query, params, timeout) => {
    requireThat(Number.isSafeInteger(timeout) && timeout > 0, 'count_failed');
    const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
    const tx = session.beginTransaction({ timeout });
    try {
      const result = await tx.run(query, params);
      await tx.commit();
      return result;
    } finally {
      if (tx.isOpen()) await tx.rollback().catch(() => {});
      await session.close();
    }
  };
  return {
    async total(timeout) {
      const result = await run('MATCH (c:SMChunk {scope:$scope}) RETURN count(c) AS n', { scope }, timeout);
      return Number(result.records[0].get('n'));
    },
    async page(after, limit, timeout) {
      const result = await run(`MATCH (c:SMChunk {scope:$scope}) WHERE $after IS NULL OR c.uid > $after
        RETURN c.uid AS uid, c.text AS text, c.embedding_key AS key,
          CASE WHEN c.embedding IS NULL THEN 'none' WHEN valueType(c.embedding) STARTS WITH 'LIST' THEN 'list' ELSE 'other' END AS kind
        ORDER BY c.uid LIMIT $limit`, { scope, after, limit: neo4j.int(limit) }, timeout);
      return result.records.map(record => ({ uid: record.get('uid'), text: record.get('text'),
        current_vector: currentVector(record.get('kind'), record.get('key'), embeddingKey) }));
    },
  };
}

/**
 * The owner count end to end. It requires the verified default contract (cap 1920, context 2048, the qualified tokenizer and
 * served blob), so a run is exactly the stated measurement. The store is closed before any result is returned; a failed
 * close is a failure. Returns `{ok:true, report}` or `{ok:false, error}` with a closed error code.
 */
export async function runOverContextCount({ config, scope, caps, openStore, clock }) {
  let store = null;
  try {
    requireThat(typeof scope === 'string', 'scope_required');
    const exact = authorize(config, scope, 'read');
    const limits = countCaps(caps);
    const policy = chunkPolicy(config);
    requireThat(policy.descriptor.policy === TOKEN_POLICY, 'token_policy_required');
    requireThat(['token_cap', 'context', 'tokenizer_sha256', 'served_blob', 'render', 'model']
      .every(key => policy.descriptor[key] === DEFAULT_TREATMENT[key]), 'count_contract_mismatch');
    store = await openStore(config.neo4j);
    const reader = neo4jChunkReader(store.driver, store.database, exact, embeddingIdentity(config.embedding));
    const report = await countOverContext({ policy, reader, caps: limits, ...(clock ? { clock } : {}) });
    const closing = store;
    store = null;
    await closing.close();
    return { ok: true, report: { scope: exact, caps: limits, ...report } };
  } catch (error) {
    if (store) await store.close().catch(() => {});
    return { ok: false, error: error instanceof MemoryError && COUNT_ERRORS.includes(error.code) ? error.code : 'count_failed' };
  }
}
