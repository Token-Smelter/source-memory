import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/memory.mjs';
import { serializePoolReply } from '../src/envelope.mjs';

const ready = { status: 'ready' };
const store = {
  lexicalStatus: async () => ready, admittedLexical: async () => ({ hits: [], omitted: [], admitted_conversations: 0, exhausted: true }),
  chunkLexicalStatus: async () => ready, chunkLexical: async () => [], lexical: async () => [],
};
const memory = () => new Memory({ scopes: { read: ['test'], write: [] } }, store);

const key = n => ({ scope: 'test', source: 'fixture', conversation_id: `chat-${n}` });
const seed = n => ({ kind: 'turn', id: `t${n}`, conversations: [{ key: key(n), legacy: false }] });
const bundleFor = text => (_scope, candidate) => ({ match: { kind: 'turn', id: candidate.id }, source: { text }, records: [], relations: [] });

function unitsOf(text, count = 1, maxBytes = 1_000_000) {
  const subject = memory();
  subject.bundle = bundleFor(text);
  const ranked = Array.from({ length: count }, (_, n) => seed(n));
  return subject.conversationUnits('test', ranked, {}, [], 'q', 12, maxBytes, 8, 2);
}

const reply = result => ({ ok: true, scope: 'test', query: 'q', status: 'ready', bundles: result.units.flatMap(unit => unit.seeds),
  budget_omitted: result.budget_omitted, units: result.units, budget_unit: 'utf8_bytes' });

const cases = [
  [{ mode: 'evidence_advice', group: 'conversation' }, 1_000_000],
  [{ mode: 'history_search', group: 'conversation' }, 200_000],
  [{ group: 'conversation' }, 200_000],
  [{ mode: 'evidence_advice' }, 200_000],
  [{ mode: 'history_search' }, 200_000],
  [{}, 200_000],
];

for (const [request, cap] of cases) {
  const label = `${request.mode ?? 'no mode'}/${request.group ?? 'ungrouped'}`;
  test(`${label} accepts max_chars up to ${cap} and refuses one more`, async () => {
    const subject = memory();
    await subject.recall('test', { query: 'q', ...request, max_chars: cap });
    await assert.rejects(subject.recall('test', { query: 'q', ...request, max_chars: cap + 1 }), { code: 'invalid_input' });
  });

  test(`${label} keeps the 256 minimum`, async () => {
    const subject = memory();
    await subject.recall('test', { query: 'q', ...request, max_chars: 256 });
    await assert.rejects(subject.recall('test', { query: 'q', ...request, max_chars: 255 }), { code: 'invalid_input' });
  });
}

test('only grouped evidence_advice may exceed 200000', async () => {
  const subject = memory();
  for (const [request] of cases.slice(1)) {
    await assert.rejects(subject.recall('test', { query: 'q', ...request, max_chars: 1_000_000 }), { code: 'invalid_input' });
  }
  await assert.rejects(subject.recall('test', { query: 'q', mode: 'evidence_advice', group: 'conversation', max_chars: 1.5 }), { code: 'invalid_input' });
});

test('grouped recall still defaults to a 24000 byte budget and reports utf8_bytes', async () => {
  for (const request of [{ mode: 'evidence_advice', group: 'conversation' }, { mode: 'history_search', group: 'conversation' }, { group: 'conversation' }]) {
    const subject = memory();
    const seen = [];
    const original = subject.conversationUnits.bind(subject);
    subject.conversationUnits = (...args) => { seen.push(args[6]); return original(...args); };
    const result = await subject.recall('test', { query: 'q', ...request });
    assert.deepEqual([seen, result.budget_unit], [[24000], 'utf8_bytes']);
  }
});

test('grouped accounting sums the serialized UTF-8 bytes of whole units', async () => {
  const result = await unitsOf('plain text', 2);
  const total = result.units.reduce((sum, unit) => sum + Buffer.byteLength(JSON.stringify(unit)), 0);
  assert.deepEqual([result.units.length, Object.keys(result.units[0])], [2, ['key', 'seeds', 'seeds_truncated', 'also_cites']]);
  assert.equal((await unitsOf('plain text', 2, total)).budget_omitted, 0);
  const short = await unitsOf('plain text', 2, total - 1);
  assert.deepEqual([short.units.length, short.budget_omitted], [1, 1]);
});

test('escape-heavy units are accounted in serialized bytes', async () => {
  const text = `${'\u0001\u001f"\\\n\t'.repeat(40)}\u{1F9D9}\u00e9`;
  const { units } = await unitsOf(text);
  const serialized = JSON.stringify(units[0]);
  const bytes = Buffer.byteLength(serialized);
  assert.ok(bytes > Buffer.byteLength(text) + 40 * 8);
  assert.ok(bytes > serialized.length);
  assert.equal((await unitsOf(text, 1, bytes)).units.length, 1);
  const short = await unitsOf(text, 1, bytes - 1);
  assert.deepEqual([short.units.length, short.budget_omitted], [0, 1]);
});

test('a normal pool reply passes the envelope check and is serialized exactly once', async () => {
  const body = reply(await unitsOf('plain \u{1F9D9} "text"', 3));
  assert.equal(serializePoolReply(body, 24000), `${JSON.stringify(body)}\n`);
});

test('the envelope check refuses a reply whose framing exceeds 65536 bytes', async () => {
  const body = { ...reply(await unitsOf('plain')), query: 'x'.repeat(65_536) };
  assert.throws(() => serializePoolReply(body, 1_000_000), { code: 'output_envelope_exceeded' });
});

test('the envelope check refuses a reply beyond twice max_chars plus the envelope', async () => {
  const result = await unitsOf('plain');
  const heavy = { ...result.units[0].seeds[0], source: { text: 'y'.repeat(70_000) } };
  const body = { ...reply(result), bundles: [heavy] };
  assert.throws(() => serializePoolReply(body, 256), { code: 'output_envelope_exceeded' });
  assert.ok(serializePoolReply(body, 1_000_000).length > 70_000);
});
