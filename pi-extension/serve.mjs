#!/usr/bin/env node
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/core.mjs';
import { Memory } from '../src/memory.mjs';
import { createMemoryHandlers } from './memory-process.mjs';
import { serve } from './ndjson.mjs';

/** Persist an append intent exactly once; an existing intent is an unknown outcome, never permission to retry. */
export function createIntentWriter(directory) {
  const root = realpathSync(directory);
  const state = statSync(root);
  if (!state.isDirectory() || (state.mode & 0o077) !== 0) throw new Error('intent_dir_invalid');
  return async plan => {
    const key = digest(['pi-memory-link-intent/v1', plan.operation_id]);
    const path = join(root, `${key}.json`);
    let fd;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error('link_intent_unknown'); }
    try {
      writeFileSync(fd, JSON.stringify(plan));
      if (!fstatSync(fd).isFile() || (fstatSync(fd).mode & 0o777) !== 0o600) throw new Error('link_intent_invalid');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return { accepted: true, operation_id: plan.operation_id, append_sha256: plan.append_sha256, receipt_ref: `pi-intent-${key}` };
  };
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, store } = {}) {
  if (![6, 8].includes(argv.length) || argv[0] !== '--config' || argv[2] !== '--scope' || argv[4] !== '--intent-dir'
    || (argv.length === 8 && argv[6] !== '--offer-timeout-ms')) throw new Error('invalid_arguments');
  const [configPath, scope, intentDir] = [argv[1], argv[3], argv[5]];
  const offerTimeoutMs = argv.length === 8 ? Number(argv[7]) : 30000;
  if (!Number.isSafeInteger(offerTimeoutMs) || offerTimeoutMs < 1 || offerTimeoutMs > 180000) throw new Error('invalid_arguments');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const memory = new Memory(config, store);
  const handlers = createMemoryHandlers({ memory, scopes: [scope], beforeAppend: createIntentWriter(intentDir), offerTimeoutMs });
  try { await serve({ input, output, handlers }); }
  finally { handlers.close(); await memory.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = typeof error?.code === 'string' && /^[a-zA-Z_]{1,80}$/.test(error.code) ? error.code : 'unknown';
    process.stderr.write(`${JSON.stringify({ ok: false, error: 'memory_process_failed', code })}\n`);
    process.exitCode = 1;
  });
}
