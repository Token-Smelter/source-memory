import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Codes the CLI synthesizes for errors that are not MemoryErrors, and the indexing reason for any non-MemoryError.
export const TRANSPORT_CODES = ['invalid_json', 'input_file_unavailable', 'operation_failed', 'database_unavailable'];
export const CLASSES = ['pre-commit-only', 'in-transaction-rolled-back', 'post-commit', 'not-on-write-path', 'stage-dependent'];

/** Code → class from the QUALIFICATION.md code table rows: | `code` | class | ... */
export function qualificationCodes(markdown) {
  const codes = new Map();
  for (const [, code, kind] of markdown.matchAll(/^\| `([a-z_]+)` \| ([a-z-]+) \|/gm)) {
    if (!CLASSES.includes(kind)) throw new Error(`unknown class ${kind} for ${code}`);
    if (codes.has(code)) throw new Error(`duplicate code ${code}`);
    codes.set(code, kind);
  }
  return codes;
}

// The modules the CLI loads, followed through relative static and dynamic imports.
async function importClosure(entry) {
  const seen = new Map();
  const visit = async path => {
    if (seen.has(path)) return;
    const source = await readFile(path, 'utf8');
    seen.set(path, source);
    for (const [, target] of source.matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g)) await visit(resolve(dirname(path), target));
  };
  await visit(entry);
  return seen;
}

// Returns the argument text of the call whose '(' is at `open`, split at top-level commas. Skips string and template literals.
function callArguments(source, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open; at < source.length; at++) {
    const char = source[at];
    if (char === "'" || char === '"' || char === '`') {
      for (at++; source[at] !== char; at++) if (source[at] === '\\') at++;
    } else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) {
      depth--;
      if (depth === 0) { args.push(source.slice(start, at).trim()); return args; }
    } else if (char === ',' && depth === 1) { args.push(source.slice(start, at).trim()); start = at + 1; }
  }
  throw new Error('unbalanced call');
}

/** Every code a requireThat or new MemoryError in the CLI's import closure can raise. A computed code fails loudly. */
export async function sourceCodes(entry) {
  const codes = new Set();
  for (const [path, source] of await importClosure(entry)) {
    for (const match of source.matchAll(/(?<!function )\brequireThat\(/g)) {
      const args = callArguments(source, match.index + match[0].length - 1);
      if (args.length === 1) { codes.add('invalid_input'); continue; }
      const literal = /^'([a-z_]+)'$/.exec(args.at(-1));
      if (!literal) throw new Error(`computed requireThat code in ${path}: ${args.at(-1)}`);
      codes.add(literal[1]);
    }
    for (const match of source.matchAll(/new MemoryError\(/g)) {
      const [arg] = callArguments(source, match.index + match[0].length - 1);
      if (arg === 'code' && path.endsWith('/src/core.mjs')) continue; // requireThat's own throw
      const literals = [...arg.matchAll(/'([a-z_]+)'/g)].map(row => row[1]);
      if (!literals.length) throw new Error(`computed MemoryError code in ${path}: ${arg}`);
      for (const code of literals) codes.add(code);
    }
  }
  return codes;
}
