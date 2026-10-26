import { authorize } from './core.mjs';
import { embed, embeddingIdentity } from './models.mjs';

// Fixed and neutral: warming must never carry memory text to the model endpoint.
export const WARM_INPUT = 'source-memory warm';

// Touches only the configured embedding endpoint; no store, no writes.
export async function warm(config, scope) {
  authorize(config, scope, 'read');
  if (!config.embedding) return { warm: { status: 'unconfigured' } };
  const key = embeddingIdentity(config.embedding);
  const started = performance.now();
  await embed(config.embedding, [WARM_INPUT]);
  return { warm: { model: config.embedding.model, embedding_key: key, ms: Math.round(performance.now() - started) } };
}
