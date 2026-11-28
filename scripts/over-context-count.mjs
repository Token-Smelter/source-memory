// Owner-only count of one expressly named scope's stored chunks against the 1920-token cap and the 2048-token context.
// Counts only: no scope name, chunk identifier, span, URL or text is printed or written. Needs the owner's grant to read
// that scope's text and the owner's pinned embedding key.
//   node scripts/over-context-count.mjs --config owner.json --scope SCOPE --embedding-key KEY --caps caps.json
// caps.json: {max_rows, max_text_bytes, max_pages, page_size (<= 500), max_seconds, transaction_timeout_ms}, all required.
import { readFile } from 'node:fs/promises';
import { runOverContextCount } from '../src/over-context-count.mjs';
import { Neo4jStore } from '../src/store.mjs';

const OPTIONS = ['--config', '--scope', '--embedding-key', '--caps'];

// Exactly one of each option and nothing else; a duplicate or unknown argument refuses before any input is read.
function options(argv) {
  if (argv.length !== OPTIONS.length * 2) return null;
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (!OPTIONS.includes(name) || Object.hasOwn(values, name) || typeof value !== 'string' || value.startsWith('--')) return null;
    values[name] = value;
  }
  return values;
}

let outcome;
const args = options(process.argv.slice(2));
if (!args) outcome = { ok: false, error: 'invalid_input' };
else {
  try {
    const [config, caps] = await Promise.all([readFile(args['--config'], 'utf8'), readFile(args['--caps'], 'utf8')].map(async text => JSON.parse(await text)));
    outcome = await runOverContextCount({ config, scope: args['--scope'], embeddingKey: args['--embedding-key'], caps,
      openStore: async settings => new Neo4jStore(settings) });
  } catch {
    outcome = { ok: false, error: 'count_failed' };
  }
}
if (outcome.ok) process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
else {
  process.stderr.write(`${JSON.stringify({ ok: false, error: outcome.error })}\n`);
  process.exitCode = 1;
}
