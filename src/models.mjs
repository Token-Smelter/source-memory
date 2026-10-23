import { digest, integer, MemoryError, requireThat, text, validateVector } from './core.mjs';

export function localEndpoint(value, allowRemote = false) {
  let url;
  try { url = new URL(value); } catch { throw new MemoryError('invalid_model_endpoint'); }
  requireThat(['http:', 'https:'].includes(url.protocol)
    && !url.username && !url.password && !url.hash && !url.search, 'invalid_model_endpoint');
  // Text is sent to this endpoint. Leaving the host requires an explicit operator choice.
  requireThat(allowRemote === true || ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 'model_endpoint_must_be_loopback');
  return url.toString();
}

export async function localJson(endpoint, body, timeout = 10000, allowRemote = false) {
  const url = localEndpoint(endpoint, allowRemote);
  const signal = AbortSignal.timeout(integer(timeout, 10000, 1, 120000));
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    requireThat(response.ok, 'model_request_failed');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      requireThat(bytes <= 8_000_000, 'model_response_too_large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(signal.aborted ? 'model_timeout' : 'model_request_failed');
  }
}

export function embeddingIdentity(config) {
  if (!config) return null;
  return digest({ endpoint: localEndpoint(config.url, config.allow_remote), model: text(config.model, 256), dimensions: integer(config.dimensions, undefined, 1, 4096) });
}

export async function embed(config, texts) {
  requireThat(config, 'embedding_unconfigured');
  embeddingIdentity(config);
  const vectors = [];
  for (let offset = 0; offset < texts.length; offset += 16) {
    const input = texts.slice(offset, offset + 16);
    const result = await localJson(config.url, { model: config.model, input }, config.timeout_ms, config.allow_remote);
    requireThat(!result.model || result.model === config.model, 'embedding_model_mismatch');
    requireThat(Array.isArray(result.data) && result.data.length === input.length, 'invalid_embedding_response');
    const rows = [...result.data].sort((a, b) => a.index - b.index);
    requireThat(rows.every((row, index) => row.index === index), 'invalid_embedding_response');
    vectors.push(...rows.map(row => validateVector(row.embedding, config.dimensions)));
  }
  return vectors;
}

export async function rerank(config, query, candidates) {
  if (!config || !candidates.length) return candidates;
  const result = await localJson(config.url, {
    model: text(config.model, 256), query,
    documents: candidates.map(item => item.text), top_n: candidates.length,
  }, config.timeout_ms, config.allow_remote);
  requireThat(!result.model || result.model === config.model, 'reranker_model_mismatch');
  requireThat(Array.isArray(result.results) && result.results.length === candidates.length, 'invalid_rerank_response');
  const indices = new Set();
  for (const row of result.results) {
    requireThat(Number.isSafeInteger(row.index) && row.index >= 0 && row.index < candidates.length
      && !indices.has(row.index) && Number.isFinite(row.relevance_score), 'invalid_rerank_response');
    indices.add(row.index);
  }
  return [...result.results].sort((a, b) => b.relevance_score - a.relevance_score)
    .map(row => ({ ...candidates[row.index], rerank_score: row.relevance_score }));
}
