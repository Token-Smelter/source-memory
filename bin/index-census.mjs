#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { MemoryError, requireThat } from '../src/core.mjs';
import { indexCensus } from '../src/index-census.mjs';

try {
  const [flag, scope, ...extra] = process.argv.slice(2);
  const configPath = process.env.SOURCE_MEMORY_CONFIG;
  requireThat(flag === '--scope' && scope && !extra.length, 'census_arguments_invalid');
  requireThat(configPath, 'SOURCE_MEMORY_CONFIG unset');
  const parts = [];
  let bytes = 0;
  for await (const chunk of createReadStream(configPath)) {
    bytes += chunk.length;
    requireThat(bytes <= 64000, 'census_config_invalid');
    parts.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (config.neo4j?.auth !== 'none') {
    const name = config.neo4j?.password_env;
    requireThat(typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'neo4j.password_env missing or invalid');
    requireThat(process.env[name], 'password_env variable unset or empty');
  }
  process.stderr.write('Read-only; configured 15 s server transaction timeout, not a proven plan or hard wall-clock cutoff. Run at a quiet moment; the query may load the database while it runs.\n');
  const unknownKeys = new Set();
  const result = await indexCensus(config, scope, undefined, unknownKeys);
  if (unknownKeys.size) process.stderr.write(`Unknown optional property keys: ${[...unknownKeys].sort().join(', ')}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof MemoryError ? (error.notification ? `census_unverified: notification ${error.notification}` : error.code) : 'census_unavailable';
  const timedOut = ['Neo.ClientError.Transaction.TransactionTimedOut', 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration',
    'Neo.TransientError.Transaction.TransactionTimedOut'].includes(error?.code);
  process.stderr.write(timedOut ? 'unknown: timed out\n' : `${JSON.stringify({ error: code })}\n`);
  process.exitCode = 1;
}
