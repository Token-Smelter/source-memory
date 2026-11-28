// Parity qualification of the local tokenizer against the served model, on fictional strings only.
//   node scripts/tokenizer-parity.mjs --blob /path/to/sha256-<digest> --url http://127.0.0.1:11434 --model embeddinggemma [--out dir]
// Each string goes alone to /api/embed with truncate:false. At or under the context the server's prompt_eval_count must equal
// the local count; over it the server must refuse and the local count must exceed the context. A clipped count never passes.
import { mkdir, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { digest } from '../src/core.mjs';
import { readGgufTokenizer, RENDER_CONTRACT, sentencePiece } from '../src/tokenizer.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [all[index].slice(2), all[index + 1]]], []));
const CONTEXT = 2048;
const CONTEXT_REFUSAL = 'the input length exceeds the context length';

function fictionalStrings(counter) {
  const base = [
    'A fictional quartz lantern note.', '  leading and  double  spaces ', 'tabs\tand\nnewlines\n\n\nand\r\nreturns',
    '日本語のテキストと漢字の混在した文章。', '한국어 문장과 English 혼합', 'Ελληνικά και Русский текст', 'e\u0301 a\u0308 n\u0303 combining marks',
    '\u{1F469}\u200D\u{1F4BB} \u{1F44D}\u{1F3FD} emoji sequences', 'literal <start_of_turn>user and <eos> and <bos> strings',
    '<unused0> <mask> [multimodal] <pad>', 'function f(x) { return x < 3 ? `${x}` : null; } // code', '{"json": [1, 2.5e-3, null, true]}',
    'aGVsbG8gZmljdGlvbmFsIHdvcmxkIQ== base64', '0xDEADBEEF 0b1010 1e309 -0.0', 'https://example.invalid/path?q=1&r=two#frag',
    '\uFFFD replacement \u00A0nbsp \u200B zero width', 'x'.repeat(500), '!@#$%^&*()_+-=[]{}|;:,.<>/?~', '',
  ];
  const words = ['quartz', 'lantern', 'harbor', 'meadow', 'copper', '日本', 'café', 'naïve', '\u{1F600}', 'x<y', 'a\tb'];
  const near = [];
  // Strings whose exact local count lands on each value around the context boundary.
  const long = Array.from({ length: 4000 }, (_, i) => words[i % words.length]).join(' ');
  const points = Array.from(long).length;
  const prefix = length => Array.from(long).slice(0, length).join('');
  for (const target of [CONTEXT - 8, CONTEXT - 2, CONTEXT - 1, CONTEXT, CONTEXT + 1, CONTEXT + 2, CONTEXT + 8, 1919, 1920, 1921]) {
    // Largest code-point prefix counting at most the target, then the exact hit if one exists nearby.
    let low = 0, high = points;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (counter.count(prefix(mid)) <= target) low = mid; else high = mid - 1;
    }
    for (let length = low; length > Math.max(0, low - 8); length--) {
      if (counter.count(prefix(length)) === target) { near.push(prefix(length)); break; }
    }
  }
  const mixed = Array.from({ length: 160 }, (_, i) => Array.from({ length: 1 + (i * 7) % 90 }, (_, j) => words[(i + j * 3) % words.length]).join(i % 3 ? ' ' : '\n'));
  return [...base, ...near, ...mixed].filter(text => text.length > 0);
}

const spec = await readGgufTokenizer(args.blob);
const counter = sentencePiece(spec);
const strings = fictionalStrings(counter);
if (args['dry-run'] === 'true') {
  console.log(JSON.stringify({ strings: strings.length, over_context: strings.filter(text => counter.count(text) > CONTEXT).length,
    near_boundary: strings.map(text => counter.count(text)).filter(count => count >= 1919 && count <= CONTEXT + 8).sort((a, b) => a - b) }));
  process.exit(0);
}
const rows = [];
const maxLoad = Number(args['max-load5'] ?? Infinity);
for (const text of strings) {
  // The host scheduler admits this run only below a load ceiling; wait between requests while it is exceeded.
  while (loadavg()[1] > maxLoad) await sleep(15000);
  const local = counter.count(text);
  const response = await fetch(`${args.url}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: args.model, input: text, truncate: false }), signal: AbortSignal.timeout(60000) });
  const body = await response.json().catch(() => null);
  const served = response.ok ? body?.prompt_eval_count ?? null : null;
  const error = response.ok ? null : typeof body?.error === 'string' ? body.error.slice(0, 200) : null;
  // Only the server's own context refusal credits an over-context control; any other 400 (e.g. a cancelled wait) does not.
  const pass = local <= CONTEXT ? response.ok && served === local
    : response.status === 400 && error === CONTEXT_REFUSAL && local > CONTEXT;
  rows.push({ text_sha256: digest(text), bytes: Buffer.byteLength(text), local, status: response.status, served, error, pass });
}
const report = { contract: 'source-memory.tokenizer-parity/1', render: RENDER_CONTRACT, tokenizer_sha256: spec.sha256, blob: args.blob,
  model: args.model, context: CONTEXT, at: new Date().toISOString(), strings: rows.length, failures: rows.filter(row => !row.pass).length,
  over_context: rows.filter(row => row.local > CONTEXT).length, rows };
const out = args.out ?? '.memory-local/tokenizer-parity';
await mkdir(out, { recursive: true });
const path = join(out, `${report.at.replace(/[:.]/g, '-')}.json`);
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ path, strings: report.strings, failures: report.failures, over_context: report.over_context, tokenizer_sha256: spec.sha256 }));
process.exitCode = report.failures ? 1 : 0;
