import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { main } from '../bin/memory.mjs';
import { Memory } from '../src/memory.mjs';
import { Neo4jStore } from '../src/store.mjs';
import { MAX_BYTES, MAX_LINE_BYTES, MAX_MARKERS, createPhaseSink, passthrough, scoped, tracer } from '../src/phase-diagnostic.mjs';
import { phaseStore } from './fixtures/phase-store.mjs';

// Recorded by running Memory.recall on the fixture store at main b6b1665, before phase markers existed.
const BASELINE = JSON.parse(readFileSync(new URL('./fixtures/phase-baseline.json', import.meta.url), 'utf8'));
const INPUTS = { plain: { query: 'dashboard color' }, grouped: { query: 'dashboard color', group: 'conversation', follow: {} } };
const CONFIG = { scopes: { read: ['s'], write: [] } };

const sink = () => { const chunks = []; return { chunks, write: text => { chunks.push(String(text)); return true; }, text: () => chunks.join('') }; };

async function files() {
  const dir = await mkdtemp(join(tmpdir(), 'phase-diagnostic-'));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify(CONFIG));
  const inputs = {};
  for (const [name, input] of Object.entries(INPUTS)) {
    inputs[name] = join(dir, `${name}.json`);
    await writeFile(inputs[name], JSON.stringify(input));
  }
  return { config, inputs };
}

async function cli(name, extra = [], io = {}) {
  const { config, inputs } = await files();
  const { store, log } = phaseStore();
  const stdout = sink();
  const stderr = io.stderr ?? sink();
  const before = process.exitCode;
  await main(['recall', '--config', config, '--scope', 's', '--input', inputs[name], ...extra], { store, stdout, stderr });
  assert.equal(process.exitCode, before);
  return { stdout: stdout.text(), stderr: stderr.text?.() ?? '', calls: log };
}

for (const name of Object.keys(INPUTS)) {
  test(`${name} recall without the flag matches main: stdout, empty stderr, exit code and store calls`, async () => {
    const result = await cli(name);
    assert.equal(result.stdout, BASELINE[name].reply);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.calls, [...BASELINE[name].calls, ['close']]);
  });

  test(`${name} recall with the flag sends the same queries and stdout, and markers only to stderr`, async () => {
    const result = await cli(name, ['--diagnostic-phases', 'v1']);
    assert.equal(result.stdout, BASELINE[name].reply);
    assert.deepEqual(result.calls, [...BASELINE[name].calls, ['close']]);
    const lines = result.stderr.split('\n').slice(0, -1);
    assert.ok(lines.length > 2 && lines.length <= MAX_MARKERS + 1);
    assert.ok(lines.every(line => /^phase v1 [A-Za-z0-9._:-]+ (start|end) \+\d+ms$/.test(line) || /^phase v1 footer emitted=\d+ dropped=\d+$/.test(line)));
    assert.equal(lines.filter(line => line.includes(' footer ')).length, 1);
    assert.match(lines.at(-1), new RegExp(`footer emitted=${lines.length - 1} dropped=0$`));
    for (const span of ['lexical.turn', 'lexical.record', 'lexical.chunk', 'bundle.0', 'bundle.0.evidence']) {
      for (const edge of ['start', 'end']) assert.ok(lines.some(line => line.startsWith(`phase v1 ${span} ${edge} `)), `${span} ${edge}`);
    }
    assert.equal(name === 'grouped', lines.some(line => line.startsWith('phase v1 lexical.turn.status ')));
  });
}

test('the flag is accepted only as v1 on recall', async () => {
  const { config, inputs } = await files();
  const run = argv => main(argv, { store: phaseStore().store, stdout: sink(), stderr: sink() });
  await assert.rejects(run(['recall', '--config', config, '--scope', 's', '--input', inputs.plain, '--diagnostic-phases', 'v2']), { code: 'invalid_arguments' });
  await assert.rejects(run(['status', '--config', config, '--scope', 's', '--diagnostic-phases', 'v1']), { code: 'invalid_arguments' });
});

test('at most 48 markers, 6144 bytes and 128 bytes per line, then one footer with counts', () => {
  const out = sink();
  const phases = createPhaseSink({ write: out.write });
  for (let i = 0; i < 500; i++) phases.mark(`span-${i}-${'x'.repeat(300)}`, i % 2 ? 'end' : 'start');
  phases.mark('é\n\u{1F600} odd name', 'start');
  phases.finish();
  phases.finish();
  phases.mark('after-finish', 'start');
  const lines = out.text().split('\n').slice(0, -1);
  assert.equal(lines.length, MAX_MARKERS + 1);
  assert.equal(lines.at(-1), 'phase v1 footer emitted=48 dropped=453');
  assert.ok(out.chunks.every(chunk => /^[\x20-\x7e]*\n$/.test(chunk) && chunk.length <= MAX_LINE_BYTES));
  assert.ok(Buffer.byteLength(out.text()) <= MAX_BYTES);
});

test('the byte bound drops later markers before the count bound is reached', () => {
  const out = sink();
  const maxBytes = MAX_LINE_BYTES + 100;
  const phases = createPhaseSink({ write: out.write, maxBytes });
  for (let i = 0; i < 20; i++) phases.mark(`span${i}`, 'start');
  phases.finish();
  const lines = out.text().split('\n').slice(0, -1);
  const [, emitted, dropped] = /emitted=(\d+) dropped=(\d+)$/.exec(lines.at(-1));
  assert.ok(Number(emitted) > 0 && Number(emitted) < 20);
  assert.equal(Number(emitted) + Number(dropped), 20);
  assert.equal(lines.length, Number(emitted) + 1);
  assert.ok(Buffer.byteLength(out.text()) <= maxBytes);
});

test('worst-case markers still honour both default bounds', () => {
  const out = sink();
  const phases = createPhaseSink({ write: out.write, now: (() => { let t = 0; return () => (t += 1e12); })() });
  for (let i = 0; i < 100; i++) phases.mark('n'.repeat(500), 'start');
  phases.finish();
  assert.ok(Buffer.byteLength(out.text()) <= MAX_BYTES);
  assert.ok(out.chunks.every(chunk => chunk.length <= MAX_LINE_BYTES));
});

test('a failing write or clock cannot throw into the caller and is counted or ignored', () => {
  const failing = createPhaseSink({ write: () => { throw new Error('closed'); } });
  assert.doesNotThrow(() => { failing.mark('a', 'start'); failing.finish(); });
  const out = sink();
  let calls = 0;
  const clock = createPhaseSink({ write: out.write, now: () => { if (calls++ === 1) throw new Error('clock'); return 0; } });
  assert.doesNotThrow(() => { clock.mark('a', 'start'); clock.mark('b', 'start'); clock.finish(); });
  assert.match(out.text(), /footer emitted=1 dropped=1\n$/);
});

test('the tracer brackets success and failure, and a throwing sink changes neither result nor error', async () => {
  const events = [];
  const trace = tracer({ mark: (name, edge) => events.push(`${name}:${edge}`) });
  assert.equal(await trace('ok', async () => 7), 7);
  await assert.rejects(trace('bad', async () => { throw new Error('boom'); }), { message: 'boom' });
  assert.deepEqual(events, ['ok:start', 'ok:end', 'bad:start', 'bad:end']);
  const hostile = tracer({ mark() { throw new Error('sink'); } });
  assert.equal(await hostile('ok', async () => 7), 7);
  await assert.rejects(hostile('bad', async () => { throw new Error('boom'); }), { message: 'boom' });
  assert.equal(tracer(null), passthrough);
  const names = [];
  await scoped(tracer({ mark: (name, edge) => edge === 'start' && names.push(name) }), 'a')('b', async () => {});
  assert.deepEqual(names, ['a.b']);
});

for (const name of Object.keys(INPUTS)) {
  test(`${name} recall reply is unchanged by a throwing marker sink`, async () => {
    const memory = new Memory(CONFIG, phaseStore().store);
    const hostile = { mark() { throw new Error('sink'); }, finish() { throw new Error('sink'); } };
    const expected = await new Memory(CONFIG, phaseStore().store).recall('s', INPUTS[name]);
    assert.deepEqual(await memory.recall('s', INPUTS[name], { phases: hostile }), expected);
  });

  test(`${name} recall output and exit code are unchanged by a throwing, ended or destroyed stderr`, async () => {
    const throwing = { write() { throw new Error('EPIPE'); } };
    const ended = new PassThrough();
    ended.end();
    const destroyed = new PassThrough();
    destroyed.destroy();
    for (const stderr of [throwing, ended, destroyed]) {
      const result = await cli(name, ['--diagnostic-phases', 'v1'], { stderr });
      assert.equal(result.stdout, BASELINE[name].reply);
      assert.deepEqual(result.calls, [...BASELINE[name].calls, ['close']]);
    }
    // Stream errors are emitted on a later tick; an unhandled one would fail the run here.
    await new Promise(resolve => setImmediate(resolve));
  });
}

test('the store brackets its admission queries without changing their text or parameters', async () => {
  const run = async trace => {
    const queries = [];
    const store = Object.assign(Object.create(Neo4jStore.prototype), {
      transaction: async (_mode, action) => action({ run: async (query, params) => { queries.push([query, JSON.stringify(params)]); return { records: [] }; } }),
    });
    await store.admittedLexical('s', 'chunk', 'dashboard color', 8, 2, [], ...(trace ? [trace] : []));
    return queries;
  };
  const events = [];
  const traced = await run(tracer({ mark: (name, edge) => events.push(`${name}:${edge}`) }));
  assert.deepEqual(traced, await run(null));
  assert.equal(traced.length, 2);
  assert.deepEqual(events, ['admission.chunk.legacy:start', 'admission.chunk.legacy:end', 'admission.chunk.search:start', 'admission.chunk.search:end']);
});
