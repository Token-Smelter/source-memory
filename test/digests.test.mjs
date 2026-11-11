import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Memory } from '../src/memory.mjs';
import { BATTERY, digestStore, embeddingFixture, RECORDS, runBattery, SCOPE } from './fixtures/digest-store.mjs';

// Recorded by `node test/fixtures/digest-store.mjs` with src/ of main 7988890, before `digests` existed.
const BASELINE = JSON.parse(readFileSync(new URL('./fixtures/digest-baseline.json', import.meta.url), 'utf8'));
const DIGEST = Object.fromEntries(Object.values(RECORDS).map(row => [row.id, row.hash ?? null]));
const STORE = { system: 'neo4j', database_id: 'db-fixture', database: 'neo4j', record_contract: 'source-memory.record/1' };

const memoryWith = async (t, log = []) => {
  const fixture = await embeddingFixture();
  t.after(fixture.close);
  return new Memory({ scopes: { read: [SCOPE], write: [] }, embedding: fixture.embedding }, digestStore(log));
};

// Every record object a reply carries: a decoded record has `uid` and `evidence`, a list item `record_kind`, a stub
// `content_omitted`, and a ranked record seed `kind: 'record'` with `text` and `channels` (a bundle's `match` has no text).
function recordObjects(value, found = []) {
  if (Array.isArray(value)) value.forEach(item => recordObjects(item, found));
  else if (value && typeof value === 'object') {
    if ((value.uid?.startsWith('record_') && value.evidence) || value.record_kind || (value.kind === 'record' && (value.content_omitted || (value.channels && value.text !== undefined)))) {
      found.push(value);
    }
    Object.values(value).forEach(item => recordObjects(item, found));
  }
  return found;
}

// The opted-in reply minus the fields digests add, for comparing with the same request without them.
const stripped = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'record_digest' || key === 'store_identity' ? undefined : item));

test('without digests every reply and every store call is byte-identical to main before the option existed', async () => {
  const current = await runBattery(Memory);
  assert.deepEqual(Object.keys(current), Object.keys(BASELINE));
  for (const [name, { reply, calls }] of Object.entries(BASELINE)) {
    assert.equal(current[name].reply, reply, `${name} reply`);
    assert.equal(current[name].calls, calls, `${name} store calls`);
  }
});

test('digests:false is the same request as no digests', async () => {
  const current = await runBattery(Memory, { digests: false });
  for (const [name, { reply, calls }] of Object.entries(BASELINE)) {
    assert.equal(current[name].reply, reply, name);
    assert.equal(current[name].calls, calls, name);
  }
});

test('with digests every record carries its stored hash, or null without one, and the reply names the store once', async () => {
  const opted = await runBattery(Memory, { digests: true });
  for (const [name] of BATTERY) {
    const reply = JSON.parse(opted[name].reply);
    assert.deepEqual(reply.store_identity, STORE, name);
    assert.equal(JSON.stringify(reply).split('"store_identity"').length, 2, `${name}: once, at the top`);
    const records = recordObjects(reply);
    for (const row of records) assert.equal(row.record_digest, DIGEST[row.id], `${name} ${row.id}`);
    const turns = JSON.stringify(reply).match(/"kind":"turn"[^{}]*"record_digest"/u);
    assert.equal(turns, null, `${name}: no turn gets a digest`);
    // A stub's `bytes` counts the digest too.
    if (name !== 'list_stub') assert.deepEqual(stripped(reply), JSON.parse(BASELINE[name].reply), `${name} otherwise unchanged`);
  }
  const counted = name => recordObjects(JSON.parse(opted[name].reply)).length;
  assert.ok(['recall', 'recall_grouped', 'recall_seeds', 'show_record', 'show_record_unhashed', 'show_bundle', 'show_units', 'list', 'list_stub']
    .every(name => counted(name) > 0), 'each kind of record-bearing reply was exercised');
  assert.equal(JSON.parse(opted.show_record_unhashed.reply).record.record_digest, null);
  const seeds = JSON.parse(opted.recall_seeds.reply).ranked;
  assert.ok(seeds.some(item => item.kind === 'record') && seeds.filter(item => item.kind === 'record').every(item => item.record_digest === DIGEST[item.id]));
  // With both vector indexes missing, recall scores the scanned vectors itself; those record seeds carry the digest too.
  const scanned = JSON.parse(opted.recall_seeds_fallback.reply).ranked.filter(item => item.channels.some(trace => trace.channel === 'record_vector'));
  assert.deepEqual(scanned.map(item => [item.id, item.record_digest]).sort(), [['r2', DIGEST.r2], ['r3', null]]);
  const stub = JSON.parse(opted.list_stub.reply).items[0];
  assert.deepEqual([stub.content_omitted, stub.record_digest], ['max_bytes', DIGEST.r4]);
});

test('status reports capabilities only when asked', async t => {
  const memory = await memoryWith(t);
  const plain = await memory.status(SCOPE);
  assert.equal(plain.capabilities, undefined);
  assert.deepEqual(await memory.status(SCOPE, {}), plain);
  const asked = await memory.status(SCOPE, { capabilities: true });
  assert.deepEqual(asked.capabilities, { scope_set_max: 4, record_digests: true, cross_scope_relations: true, link_uid_lock: false });
  assert.deepEqual({ ...asked, capabilities: undefined }, { ...plain, capabilities: undefined });
  assert.deepEqual(plain.store, STORE, 'store_identity has the shape of status.store');
});

test('show works on an object derived from a Memory, with and without digests', async t => {
  const derived = Object.create(await memoryWith(t));
  assert.equal((await derived.show(SCOPE, { kind: 'record', id: 'r1' })).record.record_digest, undefined);
  assert.equal((await derived.show(SCOPE, { kind: 'record', id: 'r1', digests: true })).record.record_digest, DIGEST.r1);
});

test('without digests the internal bundle and unit calls keep their old arguments', async t => {
  const memory = await memoryWith(t);
  const seen = [];
  for (const name of ['bundle', 'conversationUnits']) {
    const original = memory[name];
    memory[name] = function (...args) { seen.push([name, args.length]); return original.apply(this, args); };
  }
  await memory.show(SCOPE, { kind: 'bundle', seed: { kind: 'record', id: 'r1' } });
  await memory.recall(SCOPE, { query: 'lantern', limit: 1 });
  await memory.recall(SCOPE, { query: 'lantern', group: 'conversation', limit: 1 });
  assert.deepEqual([...new Set(seen.map(row => row.join(':')))].sort(), ['bundle:5', 'bundle:7', 'conversationUnits:11']);
});

test('a malformed digests value is refused before any store call', async t => {
  for (const [method, input] of [['recall', { query: 'lantern' }], ['show', { kind: 'record', id: 'r1' }], ['list', {}]]) {
    const log = [];
    const memory = await memoryWith(t, log);
    await assert.rejects(memory[method](SCOPE, { ...input, digests: 'yes' }), { code: 'invalid_input' }, method);
    assert.deepEqual(log, [], method);
  }
});

test('digests count toward list max_bytes: a page can end earlier, and the cursor walk stays exact either way', async t => {
  const memory = await memoryWith(t);
  const walk = async digests => {
    const ids = [];
    let pages = 0;
    let cursor;
    do {
      const page = await memory.list(SCOPE, { kind: 'decision', limit: 2, max_bytes: 4096, ...(cursor ? { cursor } : {}), ...(digests ? { digests } : {}) });
      ids.push(...page.items.map(item => item.id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor);
    return { ids, pages };
  };
  assert.deepEqual((await walk(true)).ids, (await walk(false)).ids);
  const first = await memory.list(SCOPE, { limit: 6 });
  const resumed = await memory.list(SCOPE, { limit: 1, digests: true });
  const plainNext = await memory.list(SCOPE, { limit: 1 });
  assert.equal(resumed.next_cursor, plainNext.next_cursor, 'the cursor binding excludes digests');
  const next = await memory.list(SCOPE, { limit: 6, cursor: plainNext.next_cursor, digests: true });
  assert.deepEqual(next.items.map(item => item.id), first.items.slice(1).map(item => item.id));
  // The item size a page budgets includes the digest, so a stub reports the larger size.
  const [plainStub] = (await memory.list(SCOPE, { max_bytes: 4096 })).items;
  const [optedStub] = (await memory.list(SCOPE, { max_bytes: 4096, digests: true })).items;
  assert.equal(optedStub.bytes - plainStub.bytes, Buffer.byteLength(`,"record_digest":"${DIGEST.r4}"`));
});

test('digests count toward recall budgets: a bundle or unit that fits without them can be omitted with them', async t => {
  const memory = await memoryWith(t);
  const plain = await memory.recall(SCOPE, { query: 'lantern teal', limit: 1 });
  const exact = JSON.stringify(plain.bundles[0]).length;
  const opted = await memory.recall(SCOPE, { query: 'lantern teal', limit: 1, max_chars: exact, digests: true });
  assert.deepEqual([plain.budget_omitted, opted.budget_omitted, opted.status], [0, 1, 'budget_limited']);
  assert.equal((await memory.recall(SCOPE, { query: 'lantern teal', limit: 1, max_chars: exact })).budget_omitted, 0);
  const grouped = { query: 'lantern', group: 'conversation', mode: 'history_search' };
  const unit = Buffer.byteLength(JSON.stringify((await memory.recall(SCOPE, grouped)).units[0]));
  assert.equal((await memory.recall(SCOPE, { ...grouped, max_chars: unit })).budget_omitted, 0);
  assert.equal((await memory.recall(SCOPE, { ...grouped, max_chars: unit, digests: true })).budget_omitted, 1);
});
