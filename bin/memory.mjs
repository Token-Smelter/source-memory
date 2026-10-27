#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Memory } from '../src/memory.mjs';
import { MemoryError, requireThat } from '../src/core.mjs';
import { warm } from '../src/warm.mjs';
import { warmDb } from '../src/warm-db.mjs';
import { isPoolRequest, serializePoolReply } from '../src/envelope.mjs';

const HELP = `source-memory <init|ingest|enrich|index|recall|show|status|warm> [--config FILE] --scope SCOPE [--input FILE]

--config defaults to $SOURCE_MEMORY_CONFIG.

JSON input is read from --input or stdin for ingest/enrich/recall/show.
index accepts optional --input {"limit":256}; init/status/warm need no input.
warm sends one fixed embedding request and never touches the database.
warm --db v1 instead runs the read-only recall query paths once against Neo4j, makes no model call, and reports ready or unavailable.
Source is copied by the caller, never transcribed by a model or discovered from host paths.
Use a local configuration with neo4j and explicit scopes.read/scopes.write allowlists.
Embeddings/reranking are optional loopback services; their availability is reported.
See README.md and examples/ for complete schemas. No deletion or live integration command.
`;

async function readBounded(stream, max = 4_000_000) {
  const parts = [];
  let size = 0;
  for await (const part of stream) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buffer.length;
    requireThat(size <= max, 'input_too_large');
    parts.push(buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function fileJson(path, max) {
  const { createReadStream } = await import('node:fs');
  return JSON.parse(await readBounded(createReadStream(path), max));
}

// `io` lets tests supply a store and capture the streams; the CLI passes nothing.
export async function main(argv = process.argv.slice(2), io = {}) {
  const { store, stdout = process.stdout, stderr = process.stderr } = io;
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...rest] = argv;
  requireThat(['init', 'ingest', 'enrich', 'index', 'recall', 'show', 'status', 'warm'].includes(command), 'unknown_command');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    requireThat(['--config', '--scope', '--input', '--db'].includes(rest[i]) && rest[i + 1] && !options[rest[i]], 'invalid_arguments');
    options[rest[i]] = rest[i + 1];
  }
  const configPath = options['--config'] ?? process.env.SOURCE_MEMORY_CONFIG;
  requireThat(configPath && options['--scope'], 'config_and_scope_required');
  requireThat(options['--db'] === undefined || (command === 'warm' && options['--db'] === 'v1'), 'invalid_arguments');
  const config = await fileJson(configPath, 64000);
  let input = {};
  if (options['--input']) input = await fileJson(options['--input'], 4_000_000);
  else if (['ingest', 'enrich', 'recall', 'show'].includes(command)) input = JSON.parse(await readBounded(process.stdin));
  if (command === 'warm' && options['--db']) {
    const memory = new Memory(config, store);
    try {
      stdout.write(`${JSON.stringify({ ok: true, ...await warmDb(config, options['--scope'], memory.store) })}\n`);
    } finally { await memory.close(); }
    return;
  }
  if (command === 'warm') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...await warm(config, options['--scope']) })}\n`);
    return;
  }
  const memory = new Memory(config);
  try {
    const result = await memory[command](options['--scope'], input);
    const reply = { ok: true, ...result };
    process.stdout.write(command === 'recall' && isPoolRequest(input) ? serializePoolReply(reply, input.max_chars ?? 24000)
      : `${JSON.stringify(reply)}\n`);
  } finally { await memory.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Database/model responses may contain connection details or user content.
    const code = error instanceof MemoryError ? error.code
      : error instanceof SyntaxError ? 'invalid_json'
        : ['ENOENT', 'EACCES'].includes(error.code) ? 'input_file_unavailable' : 'operation_failed';
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    process.exitCode = 1;
  });
}
