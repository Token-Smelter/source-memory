#!/usr/bin/env node
import { inspectInterruptedRun } from '../pi-extension/evaluation/interrupted-run.mjs';

try {
  if (process.argv.length !== 3) throw Object.assign(new Error('arguments_invalid'), { code: 'arguments_invalid' });
  process.stdout.write(`${JSON.stringify(inspectInterruptedRun(process.argv[2]))}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'inspection_failed', code: error?.code ?? 'inspection_failed' })}\n`);
  process.exitCode = 1;
}
