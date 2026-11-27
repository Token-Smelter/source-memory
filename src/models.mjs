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

export class EmbeddingContextRejection extends Error {}

export async function localJson(endpoint, body, timeout = 10000, allowRemote = false, classifyContext = false) {
  const url = localEndpoint(endpoint, allowRemote);
  const signal = AbortSignal.timeout(integer(timeout, 10000, 1, 120000));
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok && classifyContext && response.status === 400 && response.body
        && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        requireThat(bytes <= 1024, 'model_request_failed');
        chunks.push(chunk);
      }
      let error;
      try { error = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))?.error; } catch { /* Unknown response stays retryable. */ }
      const rejection = classifyContext === 'native' ? error : error?.type === 'invalid_request_error' ? error.message : null;
      if (!signal.aborted && rejection === 'the input length exceeds the context length') {
        throw new EmbeddingContextRejection();
      }
    }
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
    if (error instanceof MemoryError || error instanceof EmbeddingContextRejection) throw error;
    throw new MemoryError(signal.aborted ? 'model_timeout' : 'model_request_failed');
  }
}

export function embeddingIdentity(config) {
  if (!config) return null;
  return digest({ endpoint: localEndpoint(config.url, config.allow_remote), model: text(config.model, 256), dimensions: integer(config.dimensions, undefined, 1, 4096) });
}

function nativeOllamaEndpoint(config) {
  if (config.ollama_transport === undefined) return null;
  requireThat(config.ollama_transport === 'native_no_truncate' && config.allow_remote !== true
    && /^embeddinggemma(?::latest)?$/.test(config.model), 'invalid_model_endpoint');
  const url = new URL(localEndpoint(config.url));
  requireThat(url.protocol === 'http:' && url.pathname === '/v1/embeddings', 'invalid_model_endpoint');
  // The configured URL continues to name the existing vector space. Selection requires vector parity.
  url.pathname = '/api/embed';
  return url.toString();
}

export function embeddingContextContract(config) {
  if (typeof config?.ollama_context_revision !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(config.ollama_context_revision)
      || !/^embeddinggemma(?::latest)?$/.test(config.model) || config.allow_remote === true) return null;
  const url = new URL(localEndpoint(config.url));
  if (url.protocol !== 'http:' || url.pathname !== '/v1/embeddings') return null;
  const contract = nativeOllamaEndpoint(config) ? 'ollama-native-no-truncate-context-rejection/1' : 'ollama-openai-context-rejection/1';
  return digest([contract, embeddingIdentity(config), config.ollama_context_revision]);
}

export async function embed(config, texts, { isolatedChunk = false } = {}) {
  requireThat(config, 'embedding_unconfigured');
  embeddingIdentity(config);
  const native = nativeOllamaEndpoint(config);
  const vectors = [];
  for (let offset = 0; offset < texts.length; offset += 16) {
    const input = texts.slice(offset, offset + 16);
    const classify = isolatedChunk && texts.length === 1 && embeddingContextContract(config) ? (native ? 'native' : 'compat') : false;
    const result = await localJson(native ?? config.url, { model: config.model, input, ...(native ? { truncate: false } : {}) },
      config.timeout_ms, config.allow_remote, classify);
    if (native) {
      requireThat(result?.model === config.model, 'embedding_model_mismatch');
      requireThat(Array.isArray(result.embeddings) && result.embeddings.length === input.length, 'invalid_embedding_response');
      vectors.push(...result.embeddings.map(vector => validateVector(vector, config.dimensions)));
      continue;
    }
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
