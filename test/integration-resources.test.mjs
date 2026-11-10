import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationResources } from '../scripts/integration-resources.mjs';

const runId = '12345678-1234-1234';
const containerId = 'a'.repeat(64);
const name = `source-memory-test-${runId}`;

test('integration resources are labelled, receipted and removed by exact identity', async () => {
  const events = [], commands = [], removed = new Set();
  const execute = async (_program, args) => {
    commands.push(args);
    if (args[0] === 'image') return { stdout: JSON.stringify({ '/data': {}, '/logs': {} }) };
    if (args[0] === 'volume' && args[1] === 'create') return { stdout: args.at(-1) };
    if (args[0] === 'volume' && args[1] === 'rm') { removed.add(args[2]); return { stdout: args[2] }; }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (removed.has(args[2])) throw Object.assign(new Error('missing'), { stderr: 'no such volume' });
      return { stdout: JSON.stringify([{ Name: args[2], Labels: { 'source-memory.run': runId } }]) };
    }
    if (args[0] === 'create') return { stdout: containerId };
    if (args[0] === 'start' || args[0] === 'stop') return { stdout: containerId };
    if (args[0] === 'rm') { removed.add(args[1]); return { stdout: containerId }; }
    if (args[0] === 'inspect') {
      if (removed.has(args[1])) throw Object.assign(new Error('missing'), { stderr: 'no such object' });
      return { stdout: JSON.stringify([{ Id: containerId, Config: { Labels: { 'source-memory.run': runId } }, Mounts: [
        { Type: 'volume', Destination: '/data', Name: `${name}-data` }, { Type: 'volume', Destination: '/logs', Name: `${name}-logs` }] }]) };
    }
    throw new Error('unexpected');
  };
  const resources = integrationResources({ runId, execute, record: row => events.push(row) });
  await resources.create();
  await resources.cleanup();
  assert.deepEqual([events.filter(row => row.phase === 'created').length, events.filter(row => row.phase === 'removed').length,
    commands.filter(args => args[0] === 'create' || (args[0] === 'volume' && args[1] === 'create')).every(args => args.includes(`source-memory.run=${runId}`))], [3, 3, true]);
});

test('the disposable container declares the shared Neo4j resource profile', async () => {
  let created;
  const execute = async (_program, args) => {
    if (args[0] === 'image') return { stdout: JSON.stringify({ '/data': {}, '/logs': {} }) };
    if (args[0] === 'volume' && args[1] === 'create') return { stdout: args.at(-1) };
    if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: JSON.stringify([{ Name: args[2], Labels: { 'source-memory.run': runId } }]) };
    if (args[0] === 'create') { created = args; throw new Error('stop after create'); }
    throw new Error('unexpected');
  };
  await assert.rejects(integrationResources({ runId, execute, record: () => {} }).create(), /creation_unknown/);
  const flag = key => created[created.indexOf(key) + 1];
  const env = key => created.find(arg => arg.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.deepEqual([flag('--memory'), flag('--cpus'), flag('--publish'), env('NEO4J_server_memory_heap_initial__size'),
    env('NEO4J_server_memory_heap_max__size'), env('NEO4J_server_memory_pagecache_size')],
  ['2048m', '2', '127.0.0.1::7687', '512m', '512m', '128m']);
});

test('an unconfirmed Docker create is an explicit uncertainty, not a successful allocation', async () => {
  const events = [];
  const execute = async (_program, args) => {
    if (args[0] === 'image') return { stdout: JSON.stringify({ '/data': {}, '/logs': {} }) };
    if (args[0] === 'volume' && args[1] === 'create') throw new Error('timeout');
    throw new Error('unexpected');
  };
  const resources = integrationResources({ runId, execute, record: row => events.push(row) });
  await assert.rejects(resources.create(), /creation_unknown/);
  assert.deepEqual(events.map(row => row.phase), ['planned']);
});
