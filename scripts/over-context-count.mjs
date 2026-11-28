// Owner-only count of one exact scope's stored chunks against the token cap and the model context. Counts only: no chunk
// identifiers, spans or text are printed or written. Needs the owner's grant to read that scope's text.
//   node scripts/over-context-count.mjs --config owner.json --scope SCOPE --caps caps.json
// caps.json: {max_rows, max_text_bytes, max_pages, page_size (<= 500), max_seconds, transaction_timeout_ms}, all required.
import { readFile } from 'node:fs/promises';
import { authorize } from '../src/core.mjs';
import { chunkPolicy, TOKEN_POLICY } from '../src/chunk-policy.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { countCaps, countOverContext, neo4jChunkReader } from '../src/over-context-count.mjs';
import { Neo4jStore } from '../src/store.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [all[index].slice(2), all[index + 1]]], []));
let store;
try {
  const config = JSON.parse(await readFile(args.config, 'utf8'));
  const caps = countCaps(JSON.parse(await readFile(args.caps, 'utf8')));
  const scope = authorize(config, args.scope, 'read');
  const policy = chunkPolicy(config);
  if (policy.descriptor.policy !== TOKEN_POLICY) throw Object.assign(new Error(), { code: 'token_policy_required' });
  store = new Neo4jStore(config.neo4j);
  const reader = neo4jChunkReader(store.driver, store.database, scope, embeddingIdentity(config.embedding));
  process.stdout.write(`${JSON.stringify({ scope, caps, ...await countOverContext({ policy, reader, caps }) }, null, 2)}\n`);
} catch (error) {
  // Only a code: an error message could carry stored text.
  process.stderr.write(`${JSON.stringify({ ok: false, error: typeof error?.code === 'string' ? error.code : 'count_failed' })}\n`);
  process.exitCode = 1;
} finally {
  await store?.close();
}
