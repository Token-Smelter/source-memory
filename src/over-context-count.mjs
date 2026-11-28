import neo4j from 'neo4j-driver';
import { integer, requireThat } from './core.mjs';
import { verifiedCounter } from './chunk-policy.mjs';

// Names the report contract. Counts describe stored chunk text under today's verified tokenizer contract; they do not say
// what an earlier writer sent to or received from the embedder.
export const OVER_CONTEXT_COUNT = 'source-memory.over-context-count/1';
export const PAGE_MAX = 500;
// Over-context buckets as multiples of the context: (1, 1.5], (1.5, 2], (2, 3], above 3.
const HISTOGRAM = [1.5, 2, 3, Infinity];

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

const incomplete = (reason, progress) => ({ contract: OVER_CONTEXT_COUNT, status: 'incomplete', reason, progress });

/**
 * Counts one exact scope's stored chunks against the token cap and the context, through `reader`:
 * `{ total(): Promise<number>, page(after, limit, timeoutMs): Promise<[{uid, text, current_vector}]> }`.
 * Pages are separate snapshots. Any cap, read failure, unverified contract or changed total yields `incomplete` with no
 * totals; only a complete pass reports counts. Identifiers and texts never leave this function.
 */
export async function countOverContext({ policy, reader, caps: input, clock = () => Date.now() }) {
  const caps = countCaps(input);
  const started = clock();
  const resolved = await verifiedCounter(policy);
  if (!resolved.counter) return incomplete('tokenizer_unavailable', { rows: 0, pages: 0 });
  const { counter } = resolved;
  const cap = policy.descriptor.token_cap;
  const context = resolved.context;
  const counts = { within_cap: 0, over_cap_within_context: 0, over_context_with_current_vector: 0, over_context_without_current_vector: 0 };
  const histogram = HISTOGRAM.map((factor, index) => ({ low: Math.floor(context * (index ? HISTOGRAM[index - 1] : 1)) + 1,
    high: Number.isFinite(factor) ? Math.floor(context * factor) : null, chunks: 0 }));
  let excess = 0, overContextTokens = 0, exactlyCounted = 0, rows = 0, pages = 0, fetchedBytes = 0;
  let totalBefore;
  try { totalBefore = await reader.total(); } catch { return incomplete('read_failed', { rows, pages }); }
  if (!Number.isSafeInteger(totalBefore) || totalBefore < 0) return incomplete('read_failed', { rows, pages });
  if (totalBefore > caps.max_rows) return incomplete('cap_rows', { rows, pages });
  for (let after = null; ;) {
    if (pages >= caps.max_pages) return incomplete('cap_pages', { rows, pages });
    if (clock() - started > caps.max_seconds * 1000) return incomplete('cap_seconds', { rows, pages });
    let page;
    try { page = await reader.page(after, caps.page_size, caps.transaction_timeout_ms); } catch { return incomplete('read_failed', { rows, pages }); }
    pages++;
    if (!Array.isArray(page) || page.length > caps.page_size) return incomplete('read_failed', { rows, pages });
    for (const row of page) {
      if (typeof row?.uid !== 'string' || typeof row.text !== 'string' || typeof row.current_vector !== 'boolean'
          || (after !== null && row.uid <= after)) return incomplete('read_failed', { rows, pages });
      after = row.uid;
      rows++;
      if (rows > caps.max_rows) return incomplete('cap_rows', { rows, pages });
      fetchedBytes += Buffer.byteLength(row.text);
      if (fetchedBytes > caps.max_text_bytes) return incomplete('cap_text_bytes', { rows, pages });
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
    if (page.length < caps.page_size) break;
  }
  let totalAfter;
  try { totalAfter = await reader.total(); } catch { return incomplete('read_failed', { rows, pages }); }
  if (totalAfter !== totalBefore || rows !== totalBefore) return incomplete('total_changed', { rows, pages });
  return {
    contract: OVER_CONTEXT_COUNT, status: 'complete', cut: 'separate_pages',
    contract_binding: { policy_digest: policy.digest, tokenizer_sha256: policy.descriptor.tokenizer_sha256,
      served_blob: policy.descriptor.served_blob, token_cap: cap, context },
    chunks: rows, exactly_counted: exactlyCounted, ...counts,
    over_context_histogram: histogram,
    excess_tokens: { sum: excess, denominator_tokens: overContextTokens },
    // Post-fetch processing only. Database work is bounded by page size, page count and the transaction timeout, not measured.
    fetched_text_bytes: fetchedBytes, pages, elapsed_ms: clock() - started, totals: { before: totalBefore, after: totalAfter },
  };
}

/** A reader over one exact scope's `SMChunk` rows. It returns text and a current-key flag, never vectors. */
export function neo4jChunkReader(driver, database, scope, embeddingKey) {
  const run = async (query, params, timeout) => {
    const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
    try { return await session.executeRead(tx => tx.run(query, params), { timeout }); }
    finally { await session.close(); }
  };
  return {
    async total() {
      const result = await run('MATCH (c:SMChunk {scope:$scope}) RETURN count(c) AS n', { scope }, 60_000);
      return Number(result.records[0].get('n'));
    },
    async page(after, limit, timeout) {
      const result = await run(`MATCH (c:SMChunk {scope:$scope}) WHERE $after IS NULL OR c.uid > $after
        RETURN c.uid AS uid, c.text AS text, (c.embedding IS NOT NULL AND c.embedding_key = $key) AS current_vector
        ORDER BY c.uid LIMIT $limit`, { scope, after, key: embeddingKey, limit: neo4j.int(limit) }, timeout);
      return result.records.map(record => ({ uid: record.get('uid'), text: record.get('text'), current_vector: record.get('current_vector') === true }));
    },
  };
}
