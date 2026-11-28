// Owner-only count of one exact scope's stored chunks against the 1920-token cap and the 2048-token context. Counts only:
// no chunk identifiers, spans or text are printed or written. Needs the owner's grant to read that scope's text.
//   node scripts/over-context-count.mjs --config owner.json --scope SCOPE --caps caps.json
// caps.json: {max_rows, max_text_bytes, max_pages, page_size (<= 500), max_seconds, transaction_timeout_ms}, all required.
import { readFile } from 'node:fs/promises';
import { runOverContextCount } from '../src/over-context-count.mjs';
import { Neo4jStore } from '../src/store.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [all[index].slice(2), all[index + 1]]], []));
let outcome;
try {
  const [config, caps] = await Promise.all([readFile(args.config, 'utf8'), readFile(args.caps, 'utf8')].map(async text => JSON.parse(await text)));
  outcome = await runOverContextCount({ config, scope: args.scope, caps, openStore: async settings => new Neo4jStore(settings) });
} catch {
  outcome = { ok: false, error: 'count_failed' };
}
if (outcome.ok) process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
else {
  process.stderr.write(`${JSON.stringify({ ok: false, error: outcome.error })}\n`);
  process.exitCode = 1;
}
