import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Memory } from '../src/memory.mjs';
import { digest, identity, normalizeEnrichment } from '../src/core.mjs';
import { main } from '../bin/memory.mjs';
import { canonicalRun, goldenFixtures, writeGoldenCorpus } from './flat-golden.mjs';
import { baseMemoryClass } from './nested-scopes.mjs';

// The commit before namespacing (nested scopes and list built). Its Memory writes and reads the nested corpus first.
export const NESTED_BASE_COMMIT = 'f5b49e322fd741d6596cbac43d7e70f64f98fe58';
export const NESTED_GOLDEN_SCOPES = ['ngolden/team', 'ngolden/team/ops'];
const SUBTREE = 'ngolden/**';
const SOUTH = [{ source: 'golden-fixture', conversation_id: 'south' }];

async function waitReady(memory, scope) {
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    const status = await memory.status(scope);
    if (status.unindexed === 0 && Object.values(status.vector_indexes).every(state => state === 'online')
      && Object.values(status.scope_tree?.indexes ?? {}).every(state => state === 'online')
      && Object.values(status.scope_tree?.pending ?? {}).every(count => count === 0)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${scope} never became ready; refusing to pin a partial read`);
}

async function walk(memory, scope, input) {
  const pages = [];
  let cursor;
  do {
    const page = await memory.list(scope, { ...input, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor);
  return pages;
}

/**
 * The reads a host makes of one exact nested scope or one subtree, using only the API of NESTED_BASE_COMMIT. `wrap` maps the
 * scope argument, so the same reads can be repeated through another request form that must give the same bytes.
 */
export async function nestedReads(memory, selection, { exact, wrap = scope => scope, extra = {} } = {}) {
  const scope = wrap(selection);
  const replies = [];
  const recall = (input, options) => memory.recall(scope, { ...input, ...extra }, ...(options ? [options] : []));
  replies.push(await recall({ query: 'lantern colour teal' }));
  replies.push(await recall({ query: 'harbor beacon tide', limit: 4, candidates: 8 }));
  replies.push(await recall({ query: 'ferry fog keeper', mode: 'evidence_advice', group: 'conversation', follow: {} }));
  replies.push(await recall({ query: 'lighthouse lantern', mode: 'history_search', group: 'conversation', per_conversation: 1,
    exclude_conversations: SOUTH }));
  replies.push(await recall({ query: 'lantern teal amber' }, { seedsOnly: true }));
  for (const input of [{ limit: 4 }, { relations: true, limit: 3 }, { kind: 'decision', relations: true }, { kind: 'turn', limit: 5 }]) {
    replies.push(await walk(memory, scope, { ...input, ...extra }));
  }
  if (exact) {
    const show = input => memory.show(scope, { ...input, ...extra });
    const keys = await memory.show(selection, { kind: 'turn_by_key', source: 'golden-fixture', conversation_id: 'north', turn_ids: ['n1', 'n2'] });
    const [n1, n2] = ['n1', 'n2'].map(id => keys.found.find(row => row.turn_id === id).id);
    replies.push(await show({ kind: 'record', id: 'teal' }));
    replies.push(await show({ kind: 'bundle', seed: { kind: 'record', id: 'teal' } }));
    replies.push(await show({ kind: 'bundle', seed: { kind: 'turn', id: n2 }, max_nodes: 2 }));
    replies.push(await show({ kind: 'units', follow: {}, units: [{ key: { scope: selection, source: 'golden-fixture', conversation_id: 'north' },
      seeds: [{ kind: 'turn', id: n2 }, { kind: 'record', id: 'delay' }, { kind: 'record', id: 'missing' }] }] }));
    replies.push(await show({ kind: 'following', turn: n1, limit: 4 }));
  }
  return replies;
}

const pinned = replies => {
  const bytes = JSON.stringify(canonicalRun(replies));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
};

// A record object in a reply: a decoded record (uid and evidence), a list item or stub, or a ranked record seed.
function recordObjects(value, found = []) {
  if (Array.isArray(value)) value.forEach(item => recordObjects(item, found));
  else if (value && typeof value === 'object') {
    if ((value.uid?.startsWith('record_') && value.evidence) || value.record_kind
      || (value.kind === 'record' && (value.content_omitted || (value.channels && value.text !== undefined)))) found.push(value);
    Object.values(value).forEach(item => recordObjects(item, found));
  }
  return found;
}

const withoutDigests = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'record_digest' || key === 'store_identity' ? undefined : item));

export async function runNamespacing(database, scratch = null) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const fixtures = await goldenFixtures(database, ['ngolden/**', 'dg', 'dg/**']);
  const memory = new Memory(fixtures.config);
  const BaseMemory = await baseMemoryClass(NESTED_BASE_COMMIT);
  const base = new BaseMemory(fixtures.config);
  try {
    await check(`exact nested and subtree reads of a corpus written by ${NESTED_BASE_COMMIT.slice(0, 7)} are byte-identical, cursors included`, async () => {
      for (const scope of NESTED_GOLDEN_SCOPES) await writeGoldenCorpus(base, scope);
      for (const scope of NESTED_GOLDEN_SCOPES) await waitReady(base, scope);
      const reads = async reader => {
        const out = {};
        for (const scope of NESTED_GOLDEN_SCOPES) out[scope] = pinned(await nestedReads(reader, scope, { exact: true }));
        out[SUBTREE] = pinned(await nestedReads(reader, SUBTREE, { exact: false }));
        return out;
      };
      const before = await reads(base);
      const after = await reads(memory);
      const digestsFalse = {};
      for (const scope of NESTED_GOLDEN_SCOPES) digestsFalse[scope] = pinned(await nestedReads(memory, scope, { exact: true, extra: { digests: false } }));
      for (const [scope, row] of Object.entries(before)) {
        if (scratch && row.sha256 !== after[scope].sha256) {
          await writeFile(join(scratch, `nested-golden-${scope.replaceAll('/', '_')}-base.json`), row.bytes, { mode: 0o600 });
          await writeFile(join(scratch, `nested-golden-${scope.replaceAll('/', '_')}-new.json`), after[scope].bytes, { mode: 0o600 });
        }
        assert.equal(after[scope].sha256, row.sha256, scope);
        if (digestsFalse[scope]) assert.equal(digestsFalse[scope].sha256, row.sha256, `${scope} with digests:false`);
      }
      const statusBefore = await base.status(SUBTREE);
      assert.equal(JSON.stringify(await memory.status(SUBTREE)), JSON.stringify(statusBefore), 'status is unchanged');
    });

    const input = () => ({ records: [
      { id: 'teal', kind: 'decision', status: 'accepted', text: 'Paint the lantern teal.', attribution: 'keeper', evidence: [] },
      { id: 'amber', kind: 'decision', text: 'Paint the lantern amber after the fog trial.', attribution: 'keeper', evidence: [] },
    ], relations: [{ id: 'amber-over-teal', type: 'supersedes', from: 'amber', to: 'teal', attribution: 'keeper', evidence: [] }] });
    const expected = {};
    await check('with digests every record carries the stored hash, equal to the digest of the normalized submission', async () => {
      for (const scope of ['dg', 'dg/a']) {
        await memory.init(scope);
        const text = 'The keeper wants the lighthouse lantern teal, then amber after the fog trial.';
        const { id } = await memory.ingest(scope, { source: 'dg-fixture', conversation_id: 'north', turn_id: 'n1', lineage_root: true,
          entries: [{ id: 'u', role: 'user', text }] });
        const enrichment = input();
        for (const row of [...enrichment.records, ...enrichment.relations]) row.evidence = [{ turn: id, entry_id: 'u', start: 0, end: text.length }];
        await memory.enrich(scope, enrichment);
        expected[scope] = Object.fromEntries(normalizeEnrichment(enrichment).records.map(record => [record.id, digest(record)]));
        await waitReady(memory, scope);
      }
      const stored = Object.fromEntries((await memory.store.transaction('read', tx => tx.run(`MATCH (r:SMRecord) WHERE r.scope IN ['dg', 'dg/a']
        RETURN r.scope AS scope, r.record_id AS id, r.hash AS hash`))).records.map(row => [`${row.get('scope')}:${row.get('id')}`, row.get('hash')]));
      const status = await memory.status('dg');
      const replies = [];
      for (const scope of ['dg', 'dg/a', 'dg/**']) {
        replies.push([scope, await memory.recall(scope, { query: 'lantern teal amber', digests: true })]);
        replies.push([scope, await memory.recall(scope, { query: 'lantern amber', group: 'conversation', mode: 'evidence_advice', follow: {}, digests: true })]);
        replies.push([scope, await memory.recall(scope, { query: 'lantern teal amber', digests: true }, { seedsOnly: true })]);
        replies.push([scope, await memory.list(scope, { relations: true, digests: true })]);
        replies.push([scope, await memory.list(scope, { max_bytes: 4096, digests: true })]);
      }
      for (const scope of ['dg', 'dg/a']) {
        replies.push([scope, await memory.show(scope, { kind: 'record', id: 'teal', digests: true })]);
        replies.push([scope, await memory.show(scope, { kind: 'bundle', seed: { kind: 'record', id: 'teal' }, digests: true })]);
        replies.push([scope, await memory.show(scope, { kind: 'units', digests: true, units: [{ key: { scope, source: 'dg-fixture', conversation_id: 'north' },
          seeds: [{ kind: 'record', id: 'amber' }] }] })]);
      }
      let checked = 0;
      const seedChannels = new Set();
      for (const [scope, reply] of replies) {
        assert.deepEqual(reply.store_identity, status.store, scope);
        for (const row of recordObjects(reply)) {
          const owner = row.scope ?? scope;
          assert.equal(row.record_digest, stored[`${owner}:${row.id}`], `${owner}:${row.id}`);
          assert.equal(row.record_digest, expected[owner][row.id], `${owner}:${row.id} matches the submission`);
          checked += 1;
          if (row.channels && !row.supporting_evidence) for (const trace of row.channels) seedChannels.add(`${owner}:${trace.channel}`);
        }
      }
      assert.ok(checked > 40, `${checked} record objects checked`);
      for (const channel of ['dg:record_lexical', 'dg:record_vector', 'dg/a:record_lexical', 'dg/a:record_vector']) {
        assert.ok(seedChannels.has(channel), `a record seed found by ${channel} carries its digest`);
      }
      const plain = await memory.recall('dg/a', { query: 'lantern teal amber' });
      assert.deepEqual(withoutDigests(await memory.recall('dg/a', { query: 'lantern teal amber', digests: true })), JSON.parse(JSON.stringify(plain)));
    });

    await check('a record node without a string hash reports record_digest null; the base build refuses digests on list', async () => {
      const uid = identity('record', 'dg', 'raw');
      await memory.store.transaction('write', tx => tx.run(`CREATE (r:SMRecord {uid:$uid, scope:'dg', record_id:'raw', hash:42, body:$body,
        text:'Raw fictional note.', created_at:datetime()})`, { uid, body: JSON.stringify({ id: 'raw', kind: 'observation', text: 'Raw fictional note.',
        status: 'observed', attribution: 'other writer', evidence: [] }) }));
      assert.equal((await memory.show('dg', { kind: 'record', id: 'raw', digests: true })).record.record_digest, null);
      const page = await memory.list('dg', { kind: 'observation', digests: true });
      assert.deepEqual(page.items.map(item => [item.id, item.record_digest]), [['raw', null]]);
      await assert.rejects(base.list('dg', { digests: true }), { code: 'invalid_input' });
      assert.equal((await base.recall('dg', { query: 'lantern', digests: true })).store_identity, undefined, 'an older build ignores it on recall');
    });

    await check('status reports capabilities only when asked, and the CLI carries digests and capabilities', async () => {
      const plain = await memory.status('dg');
      assert.equal(JSON.stringify(plain), JSON.stringify(await base.status('dg')));
      assert.deepEqual((await memory.status('dg', { capabilities: true })).capabilities, { record_digests: true });
      assert.equal((await base.status('dg', { capabilities: true })).capabilities, undefined, 'absent means unsupported');
      const dir = await mkdtemp(join(scratch ?? tmpdir(), 'namespacing-cli-'));
      await writeFile(join(dir, 'config.json'), JSON.stringify(fixtures.config));
      const cli = async (command, body) => {
        await writeFile(join(dir, 'input.json'), JSON.stringify(body));
        let out = '';
        await main([command, '--config', join(dir, 'config.json'), '--scope', 'dg', '--input', join(dir, 'input.json')],
          { stdout: { write: line => { out += line; } }, stderr: { write() {} } });
        return JSON.parse(out);
      };
      assert.deepEqual((await cli('status', { capabilities: true })).capabilities, { record_digests: true });
      const listed = await cli('list', { kind: 'decision', digests: true });
      assert.deepEqual(listed.items.map(item => item.record_digest).sort(), Object.values(expected.dg).sort());
      assert.deepEqual(listed.store_identity, plain.store);
    });
  } finally {
    await base.close();
    await memory.close();
    await fixtures.close();
  }
  return results;
}
