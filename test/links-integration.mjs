import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Memory } from '../src/memory.mjs';
import { canonical, digest, identity, normalizeEnrichment } from '../src/core.mjs';
import { Neo4jStore } from '../src/store.mjs';
import { failureReply, main } from '../bin/memory.mjs';
import { exportScope } from '../pi-extension/export-scope.mjs';
import { canonicalRun, goldenFixtures } from './flat-golden.mjs';
import { baseMemoryClass } from './nested-scopes.mjs';
import { NESTED_BASE_COMMIT } from './namespacing-integration.mjs';
import { severableRelay } from './qualification.mjs';

// A writes, B is far (its name is itself a canary), C is unrelated; a nested pair under one root covers subtrees.
const A = 'link-a';
const B = 'canary-far-b';
const C = 'link-c';
const NA = 'lnest/a';
const NB = 'lnest/b';
const GRANTS = [A, B, C, 'lnest/**', 'lw', 'lw-far', 'lw-hidden'];
const B_CANARIES = [B, 'canary-rec-b', 'canary far text bravo', identity('record', B, 'canary-rec-b')];
const A_CANARIES = ['canary-link-alpha', 'canary span alpha'];

const leaks = (value, canaries) => canaries.filter(canary => JSON.stringify(value).toLowerCase().includes(canary.toLowerCase()));
const turn = (conversation, id, text, parent = null) => ({ source: 'link-fixture', conversation_id: conversation, turn_id: id,
  ...(parent ? { parent_turn_id: parent } : { lineage_root: true }), entries: [{ id: 'u', role: 'user', text }] });
const spanOf = (uid, text) => [{ turn: uid, entry_id: 'u', start: 0, end: text.length }];
const record = (id, kind, text, evidence) => ({ id, kind, text, attribution: 'link fixture', evidence });

async function waitReady(memory, scope) {
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    const status = await memory.status(scope);
    if (status.unindexed === 0 && Object.values(status.vector_indexes).every(state => state === 'online')
      && Object.values(status.scope_tree?.indexes ?? {}).every(state => state === 'online')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${scope} never became ready`);
}

const stageOf = async promise => {
  try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error: error.code, stage: error.stage ?? 'unknown' }; }
};

export async function runLinks(database, scratch = null) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const fixtures = await goldenFixtures(database, GRANTS);
  const memory = new Memory(fixtures.config);
  const reader = read => new Memory({ ...fixtures.config, scopes: { read, write: [] } }, memory.store);
  const BaseMemory = await baseMemoryClass(NESTED_BASE_COMMIT);
  const base = new BaseMemory(fixtures.config);
  const ids = {};
  const seed = async (scope, conversation, turnId, text, records = [], parent = null) => {
    const { id } = await memory.ingest(scope, turn(conversation, turnId, text, parent));
    if (records.length) await memory.enrich(scope, { records: records.map(([recordId, kind, body]) => record(recordId, kind, body, spanOf(id, text))), relations: [] });
    return id;
  };

  // Every read a host makes of one selection, serialized once.
  const reads = async (memoryOf, selection, { exact = typeof selection === 'string', home = A } = {}) => {
    const out = [];
    const query = 'lantern alpha bravo canary harbor';
    out.push(await memoryOf.recall(selection, { query }));
    out.push(await memoryOf.recall(selection, { query, mode: 'evidence_advice', group: 'conversation', follow: {} }));
    out.push(await memoryOf.recall(selection, { query }, { seedsOnly: true }));
    out.push(await memoryOf.list(selection, { relations: true }));
    // A subtree is read by recall and list only; show takes an exact scope or a set.
    if (typeof selection === 'string' && selection.endsWith('/**')) return canonicalRun(out);
    const seedScope = exact ? {} : { scope: home };
    const seedId = home === A ? 'a-decision' : home === B ? 'canary-rec-b' : home === C ? 'c-note' : 'n-decision';
    out.push(await memoryOf.show(selection, { kind: 'bundle', seed: { kind: 'record', id: seedId, ...seedScope } }));
    out.push(await memoryOf.show(selection, { kind: 'units', follow: {}, units: [{ key: { scope: home, source: 'link-fixture', conversation_id: `c-${home}` },
      seeds: [{ kind: 'record', id: seedId }, { kind: 'turn', id: ids[home] }] }] }));
    out.push(await memoryOf.show(selection, { kind: 'following', turn: ids[home], ...(exact ? {} : { scope: home }) }));
    if (exact) {
      out.push(await memoryOf.show(selection, { kind: 'record', id: seedId }));
      out.push(await stageOf(memoryOf.show(selection, { kind: 'record', id: 'canary-rec-b' })));
      out.push(await memoryOf.status(selection));
    }
    return canonicalRun(out);
  };

  try {
    const before = {};
    await check('a link is written in its from record\'s scope and leaves every read of the far scope byte-identical', async () => {
      for (const scope of [A, B, C]) await memory.init(scope);
      for (const scope of [NA, NB]) await memory.init(scope);
      ids[B] = await seed(B, `c-${B}`, 'b1', 'The keeper logged the canary far text bravo for the harbor lantern.',
        [['canary-rec-b', 'action', 'Canary far text bravo: repaint the harbor lantern.'], ['b-observation', 'observation', 'Bravo saw the lantern flicker.']]);
      ids[A] = await seed(A, `c-${A}`, 'a1', 'Alpha decided the harbor lantern goes amber.', [['a-decision', 'decision', 'Paint the harbor lantern amber in alpha.']]);
      ids.span = await seed(A, `c-${A}`, 'a2', 'Canary span alpha appears only here.', [], 'a1');
      ids[C] = await seed(C, `c-${C}`, 'c1', 'Charlie notes the harbor lantern.', [['c-note', 'observation', 'Charlie notes the lantern.']]);
      ids[NB] = await seed(NB, `c-${NB}`, 'nb1', 'Nested bravo lantern action.', [['n-far', 'action', 'Nested far lantern action.']]);
      ids[NA] = await seed(NA, `c-${NA}`, 'na1', 'Nested alpha lantern decision.', [['n-decision', 'decision', 'Nested alpha lantern decision.']]);
      for (const scope of [A, B, C, NA, NB]) await waitReady(memory, scope);
      const full = reader([A, B, C]);
      before.exactB = await reads(full, B, { home: B });
      before.setBC = await reads(full, [B, C], { home: B });
      before.status = JSON.stringify(await memory.status(B));
      if (scratch) before.snapshot = await snapshot(B);

      const far = await memory.show(B, { kind: 'record', id: 'canary-rec-b', digests: true });
      const reply = await memory.enrich(A, { records: [], relations: [{ id: 'canary-link-alpha', type: 'supersedes', from: 'a-decision',
        to: { scope: B, id: 'canary-rec-b', expected_digest: far.record.record_digest }, attribution: 'link fixture',
        evidence: spanOf(ids.span, 'Canary span alpha appears only here.') }] });
      assert.deepEqual(reply.relations, ['canary-link-alpha']);
      await memory.enrich(NA, { records: [], relations: [{ id: 'n-link', type: 'depends_on', from: 'n-decision', to: { scope: NB, id: 'n-far' },
        attribution: 'link fixture', evidence: spanOf(ids[NA], 'Nested alpha lantern decision.') }] });
      const stored = (await memory.store.transaction('read', tx => tx.run(`MATCH (e:SMLink {uid:$uid})-[:SM_FROM]->(a:SMRecord), (e)-[:SM_TO]->(b:SMRecord)
        RETURN properties(e) AS e, a.scope AS from, b.scope AS to, labels(e) AS labels`, { uid: identity('relation', A, 'canary-link-alpha') }))).records[0].toObject();
      const body = normalizeEnrichment({ records: [], relations: [{ id: 'canary-link-alpha', type: 'supersedes', from: 'a-decision',
        to: { scope: B, id: 'canary-rec-b' }, attribution: 'link fixture', evidence: spanOf(ids.span, 'Canary span alpha appears only here.') }] }).relations[0];
      assert.deepEqual([stored.labels, stored.from, stored.to, stored.e.scope, stored.e.to_scope, stored.e.to_uid, stored.e.hash, stored.e.body],
        [['SMLink'], A, B, A, B, identity('record', B, 'canary-rec-b'), digest(body), JSON.stringify(body)]);
      assert.equal(JSON.stringify(await reads(full, B, { home: B })), JSON.stringify(before.exactB), 'exact B is unchanged');
      assert.equal(JSON.stringify(await reads(full, [B, C], { home: B })), JSON.stringify(before.setBC), 'set {B, C} is unchanged');
      assert.equal(JSON.stringify(await memory.status(B)), before.status);
      if (scratch) assert.equal(await snapshot(B), before.snapshot, 'B\'s export-scope snapshot is unchanged');
      const status = await memory.status(A);
      assert.deepEqual([status.relations, status.links], [0, 1], 'status counts links apart from relations');
    });

    await check('hide rule: a read that does not select the far scope shows the link with its far end hidden and leaks nothing of B', async () => {
      const hidden = { id: 'canary-link-alpha', to: null, to_hidden: true };
      const exactA = await reads(reader([A]), A);
      assert.deepEqual(leaks(exactA, B_CANARIES), []);
      const bundle = exactA[4].bundle;
      assert.deepEqual(bundle.relations.map(row => ({ id: row.id, to: row.to, to_hidden: row.to_hidden })), [hidden]);
      assert.deepEqual([bundle.gaps, bundle.relationship_context_complete, bundle.records.map(row => row.id)], [['cross_scope_hidden'], false, ['a-decision']]);
      const listed = exactA[3].relations.find(row => row.id === 'canary-link-alpha');
      assert.deepEqual([listed.to, listed.to_hidden, listed.to_scope, listed.scope], [null, true, undefined, A]);
      assert.equal(JSON.stringify(await reads(reader([A, B]), A)), JSON.stringify(exactA), 'selection, not grants, decides');
      const setAC = await reads(reader([A, C]), [A, C]);
      assert.deepEqual(leaks(setAC, B_CANARIES), []);
      assert.ok(JSON.stringify(setAC).includes('"to_hidden":true'));
      const neighbors = await memory.store.neighbors(A, ['a-decision'], 10);
      assert.deepEqual(leaks(neighbors, B_CANARIES), [], 'the store\'s one-scope relation read hides the far end too');
    });

    await check('a set that selects both ends shows the link, the far record in its own scope and the link as incoming from B', async () => {
      const both = reader([A, B]);
      const fromA = (await both.show([A, B], { kind: 'bundle', seed: { kind: 'record', id: 'a-decision', scope: A } })).bundle;
      assert.deepEqual(fromA.records.map(row => [row.scope, row.id]), [[A, 'a-decision'], [B, 'canary-rec-b']]);
      const link = fromA.relations.find(row => row.id === 'canary-link-alpha');
      assert.deepEqual([link.to, link.to_scope, link.scope, link.to_hidden, fromA.gaps], ['canary-rec-b', B, undefined, undefined, []]);
      const far = fromA.records.find(row => row.id === 'canary-rec-b');
      assert.ok(far.supporting_evidence.every(span => span.scope === B), 'a far record\'s evidence is read in, and names, its own scope');
      const fromB = (await both.show([A, B], { kind: 'bundle', seed: { kind: 'record', id: 'canary-rec-b', scope: B } })).bundle;
      const incoming = fromB.relations.find(row => row.id === 'canary-link-alpha');
      assert.deepEqual([incoming.scope, incoming.from, incoming.to, incoming.to_scope], [A, 'a-decision', 'canary-rec-b', B]);
      assert.ok(incoming.supporting_evidence.every(span => span.scope === A));
      const units = await both.show([A, B], { kind: 'units', follow: {}, units: [{ key: { scope: A, source: 'link-fixture', conversation_id: `c-${A}` },
        seeds: [{ kind: 'record', id: 'a-decision' }] }] });
      const followed = units.units[0].following;
      assert.ok(followed.some(entry => entry.scope === B && entry.after === ids[B]), 'show units follows a far evidence root in its own scope');
      assert.ok(followed.filter(entry => entry.scope === undefined).every(entry => [ids[A], ids.span].includes(entry.after)));
      const page = await both.list([A, B], { relations: true });
      assert.deepEqual(page.relations.filter(row => row.id === 'canary-link-alpha').map(row => [row.scope, row.to, row.to_scope]), [[A, 'canary-rec-b', B]]);
      const grouped = await both.recall([A, B], { query: 'harbor lantern alpha amber', group: 'conversation', mode: 'evidence_advice', follow: {} });
      const unitA = grouped.units.find(unit => unit.key.scope === A && unit.seeds.some(seedBundle => seedBundle.records.some(row => row.id === 'canary-rec-b')));
      assert.ok(unitA, 'a unit of A holds B\'s record through the link');
      assert.ok(unitA.also_cites.some(key => key.scope === B), 'also_cites names the far evidence\'s own scope');
      assert.ok(unitA.following.some(entry => entry.scope === B), 'a far evidence root is followed in its own scope');
    });

    await check('subtrees follow the hide rule by selection; the base build sees no link at all', async () => {
      const nested = reader(['lnest/**']);
      const NB_CANARIES = [NB, identity('record', NB, 'n-far'), 'n-far', 'nested bravo lantern action', 'nested far lantern action'];
      const NA_CANARIES = ['n-link', 'n-decision', 'nested alpha lantern decision'];
      const narrowReads = await reads(nested, `${NA}/**`, { home: NA });
      assert.deepEqual(leaks(narrowReads, NB_CANARIES), [], 'a subtree without the far scope');
      assert.ok(JSON.stringify(narrowReads).includes('"to_hidden":true'));
      const farOnly = await reads(nested, `${NB}/**`, { home: NB });
      assert.deepEqual(leaks(farOnly, NA_CANARIES), [], 'a reader of only the far subtree sees nothing of the link');
      assert.equal(farOnly[3].relations_total, 0);
      assert.equal((await nested.status(`${NB}/**`)).links, undefined, 'and counts no link');
      const wideReads = await reads(nested, 'lnest/**', { home: NA });
      assert.ok(JSON.stringify(wideReads).includes('"to_scope":"lnest/b"'));
      const narrow = await nested.recall(`${NA}/**`, { query: 'nested alpha lantern decision' });
      const near = narrow.bundles.find(bundle => bundle.records.some(row => row.id === 'n-decision'));
      assert.deepEqual(near.relations.map(row => [row.id, row.to, row.to_hidden]), [['n-link', null, true]]);
      assert.equal(JSON.stringify(narrow).includes('n-far'), false);
      const wide = await nested.recall('lnest/**', { query: 'nested alpha lantern decision' });
      const both = wide.bundles.find(bundle => bundle.scope === NA && bundle.records.some(row => row.id === 'n-decision'));
      assert.deepEqual(both.relations.map(row => [row.id, row.to, row.to_scope]), [['n-link', 'n-far', NB]]);
      assert.deepEqual(both.records.map(row => row.scope).sort(), [NA, NB]);
      // The base build matches no SMLink: every read it makes of A or B shows no trace of the link or of the other side.
      for (const [scope, canaries] of [[A, [...B_CANARIES, 'canary-link-alpha']], [B, A_CANARIES]]) {
        assert.deepEqual(leaks(await reads(base, scope, { home: scope }), canaries), [], `${NESTED_BASE_COMMIT.slice(0, 7)} reading ${scope}`);
      }
    });

    await check('cross_scope_denied is checked before any storage call, whether or not the far record exists', async () => {
      const calls = [];
      const store = new Proxy(memory.store, { get(target, name) {
        const value = target[name];
        return typeof value === 'function' ? (...args) => { calls.push(name); return value.apply(target, args); } : value;
      } });
      const writer = new Memory({ ...fixtures.config, scopes: { read: [A], write: [A] } }, store);
      const link = to => ({ records: [], relations: [{ id: 'denied-link', type: 'qualifies', from: 'a-decision', to, attribution: 'x',
        evidence: spanOf(ids[A], 'Alpha decided the harbor lantern goes amber.') }] });
      const replies = [];
      for (const id of ['canary-rec-b', 'no-such-record']) replies.push(await stageOf(writer.enrich(A, link({ scope: B, id }))));
      replies.push(await stageOf(writer.enrich(A, link({ scope: 'lnest/**', id: 'n-far' }))));
      assert.deepEqual(replies, Array(3).fill({ ok: false, error: 'cross_scope_denied', stage: 'before_write' }));
      assert.deepEqual(calls, []);
    });

    await check('far writes: kind checks, a stored far referent, the digest precondition, replay and conflicts roll back cleanly', async () => {
      const W = 'lw';
      const F = 'lw-far';
      for (const scope of [W, F]) await memory.init(scope);
      const text = 'The writer records an outcome of the far action.';
      ids[W] = await seed(W, 'c-lw', 'w1', text, [['w-anchor', 'decision', 'Writer anchor decision.']]);
      await seed(F, 'c-lwf', 'f1', 'The far scope holds an action and an observation.',
        [['f-action', 'action', 'Far action.'], ['f-observation', 'observation', 'Far observation.']]);
      const evidence = spanOf(ids[W], text);
      const outcome = { id: 'w-outcome', kind: 'outcome', text: 'The far action worked.', attribution: 'x', evidence };
      const link = (id, from, to, extra = {}) => ({ id, type: 'outcome_of', from, to, attribution: 'x', evidence, ...extra });
      const attempt = input => stageOf(memory.enrich(W, input));
      const counts = async () => { const status = await memory.status(W); return [status.records, status.relations, status.links ?? 0]; };
      const start = await counts();
      const farDigest = (await memory.show(F, { kind: 'record', id: 'f-action', digests: true })).record.record_digest;
      assert.deepEqual(await attempt({ records: [outcome], relations: [link('w-wrong', 'w-outcome', { scope: F, id: 'f-observation' })] }),
        { ok: false, error: 'invalid_outcome_relation', stage: 'rolled_back' });
      assert.deepEqual(await attempt({ records: [outcome], relations: [link('w-ghost', 'w-outcome', { scope: F, id: 'f-ghost' })] }),
        { ok: false, error: 'relation_endpoint_unavailable', stage: 'rolled_back' });
      assert.deepEqual(await attempt({ records: [outcome], relations: [link('w-of', 'w-outcome', { scope: F, id: 'f-action', expected_digest: 'f'.repeat(64) })] }),
        { ok: false, error: 'relation_endpoint_digest_mismatch', stage: 'rolled_back' });
      assert.deepEqual(await counts(), start, 'nothing written by a refusal');
      // A payload record with the far id is a record of the written scope; it never satisfies the far lookup.
      assert.deepEqual(await attempt({ records: [outcome, { id: 'w-local', kind: 'action', text: 'A local action.', attribution: 'x', evidence }],
        relations: [link('w-same-id', 'w-outcome', { scope: F, id: 'w-local' })] }), { ok: false, error: 'relation_endpoint_unavailable', stage: 'rolled_back' });
      const first = await attempt({ records: [outcome], relations: [link('w-of', 'w-outcome', { scope: F, id: 'f-action', expected_digest: farDigest })] });
      assert.equal(first.ok, true, JSON.stringify(first));
      // A replay with or without the precondition converges on one link; the stored far link satisfies a later outcome replay.
      for (const input of [{ records: [outcome], relations: [link('w-of', 'w-outcome', { scope: F, id: 'f-action' })] },
        { records: [outcome], relations: [link('w-of', 'w-outcome', { scope: F, id: 'f-action', expected_digest: farDigest })] }, { records: [outcome], relations: [] }]) {
        assert.equal((await attempt(input)).ok, true, JSON.stringify(input));
      }
      assert.deepEqual(await counts(), [start[0] + 1, start[1], start[2] + 1]);
      assert.deepEqual(await attempt({ records: [], relations: [link('w-of', 'w-outcome', { scope: B, id: 'canary-rec-b' }, { type: 'qualifies' })] }),
        { ok: false, error: 'relation_identity_conflict', stage: 'rolled_back' }, 'same id, other to_scope');
      assert.deepEqual(await attempt({ records: [], relations: [link('w-of', 'w-outcome', 'w-anchor', { type: 'qualifies' })] }),
        { ok: false, error: 'relation_identity_conflict', stage: 'rolled_back' }, 'same id written as a same-scope relation');
      assert.equal((await attempt({ records: [], relations: [link('w-plain', 'w-anchor', 'w-outcome', { type: 'qualifies' })] })).ok, true);
      assert.deepEqual(await attempt({ records: [], relations: [link('w-plain', 'w-anchor', { scope: F, id: 'f-action' }, { type: 'qualifies' })] }),
        { ok: false, error: 'relation_identity_conflict', stage: 'rolled_back' }, 'same id written as a link after a relation');
      // The grant is checked on every call: a replay after read on F was revoked is refused, though the link is stored.
      const revoked = new Memory({ ...fixtures.config, scopes: { read: [W], write: [W] } }, memory.store);
      assert.deepEqual(await stageOf(revoked.enrich(W, { records: [outcome], relations: [link('w-of', 'w-outcome', { scope: F, id: 'f-action' })] })),
        { ok: false, error: 'cross_scope_denied', stage: 'before_write' });
      const settled = (await revoked.list(W, { relations: true })).relations.find(row => row.id === 'w-of');
      assert.deepEqual([settled.from, settled.to, settled.to_hidden, settled.type], ['w-outcome', null, true, 'outcome_of'], 'presence settles through list');
      // Ids that name Object.prototype members write and replay like any other id, in both forms.
      for (const input of [{ records: [], relations: [link('toString', 'w-anchor', { scope: F, id: 'f-action' }, { type: 'qualifies' })] },
        { records: [], relations: [link('constructor', 'w-anchor', 'w-outcome', { type: 'qualifies' })] },
        { records: [], relations: [link('__proto__', 'w-anchor', { scope: F, id: 'f-action', expected_digest: farDigest }, { type: 'qualifies' })] }]) {
        for (const pass of ['write', 'replay']) assert.equal((await attempt(input)).ok, true, `${input.relations[0].id} ${pass}`);
      }
      assert.deepEqual(await placeholders(), 0);
    });

    await check('the relation id lock serializes concurrent first writes of one id in two forms with different from records', async () => {
      const W = 'lw';
      const F = 'lw-far';
      const text = 'Concurrent writers name one relation id.';
      const evidenceTurn = await seed(W, 'c-lw-race', 'r1', text, [['race-r1', 'decision', 'Race target.'], ['race-r2', 'decision', 'Race from two.'],
        ['race-r3', 'decision', 'Race from three.']]);
      const evidence = spanOf(evidenceTurn, text);
      const blocked = [];
      for (const [round, order] of [['x1', ['plain', 'link']], ['x2', ['link', 'plain']]]) {
        const inputs = {
          plain: { records: [], relations: [{ id: `race-${round}`, type: 'qualifies', from: 'race-r2', to: 'race-r1', attribution: 'x', evidence }] },
          link: { records: [], relations: [{ id: `race-${round}`, type: 'qualifies', from: 'race-r3', to: { scope: F, id: 'f-action' }, attribution: 'x', evidence }] },
        };
        // The first writer holds its id lock until the second has started taking the same one.
        // The second writer starts taking it only once the first holds it, so the order of the two is fixed.
        let secondStarted;
        let firstLocked;
        const started = new Promise(resolve => { secondStarted = resolve; });
        const locked = new Promise(resolve => { firstLocked = resolve; });
        // The first writer goes on only once the database reports the second blocked on the same id lock.
        const secondBlocked = async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const waiting = (await memory.store.transaction('read', tx => tx.run(`SHOW TRANSACTIONS YIELD currentQuery, status
              WHERE currentQuery CONTAINS 'sm_placeholder' AND status STARTS WITH 'Blocked' RETURN count(*) AS count`))).records[0].get('count');
            if (waiting > 0) return true;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return false;
        };
        const writers = order.map((form, index) => {
          const store = new Neo4jStore(database);
          const real = store.transaction.bind(store);
          store.transaction = (mode, action) => real(mode, tx => action({ run: async (query, params) => {
            const locking = query.includes('sm_placeholder');
            if (locking && index === 1) { await locked; secondStarted(); }
            const result = await tx.run(query, params);
            if (locking && index === 0) { firstLocked(); await started; blocked.push(await secondBlocked()); }
            return result;
          } }));
          return { form, memory: new Memory(fixtures.config, store) };
        });
        const replies = await Promise.all(writers.map(({ form, memory: writer }) => stageOf(writer.enrich(W, inputs[form]))));
        await Promise.all(writers.map(({ memory: writer }) => writer.close()));
        assert.deepEqual(replies.map(reply => reply.ok ? 'ok' : `${reply.error}:${reply.stage}`), ['ok', 'relation_identity_conflict:rolled_back'], round);
        const stored = (await memory.store.transaction('read', tx => tx.run(`MATCH (n) WHERE (n:SMRelation OR n:SMLink) AND n.uid = $uid
          RETURN labels(n) AS labels`, { uid: identity('relation', W, `race-${round}`) }))).records.map(row => row.get('labels'));
        assert.deepEqual(stored, [[order[0] === 'plain' ? 'SMRelation' : 'SMLink']], `${round}: one id names one relation`);
      }
      assert.deepEqual(blocked, [true, true], 'the second writer waited on the first writer id lock');
      assert.equal(await placeholders(), 0, 'no placeholder survives a commit, a refusal or a rollback');
      const status = await memory.status('lw', { capabilities: true });
      assert.deepEqual([status.capabilities.cross_scope_relations, status.capabilities.link_uid_lock], [true, true]);
      // Without the constraint there is no index entry to lock, and status says so until init creates it again.
      await memory.store.transaction('write', tx => tx.run('DROP CONSTRAINT smlink_uid IF EXISTS'));
      assert.equal((await memory.status('lw', { capabilities: true })).capabilities.link_uid_lock, false);
      await memory.init('lw');
      assert.equal((await memory.status('lw', { capabilities: true })).capabilities.link_uid_lock, true);
    });

    await check('a link refusal raised after a real driver retry carries stage unknown', async () => {
      const W = 'lw';
      const F = 'lw-far';
      const text = 'A retried writer names a link.';
      const evidenceTurn = await seed(W, 'c-lw-retry', 'q1', text, [['retry-from', 'decision', 'Retry from.']]);
      const evidence = spanOf(evidenceTurn, text);
      const relay = await severableRelay(database.uri);
      const store = new Neo4jStore({ ...database, uri: relay.uri });
      const real = store.transaction.bind(store);
      const attempts = [];
      store.transaction = (mode, action) => real(mode, async tx => {
        attempts.push(attempts.length + 1);
        if (attempts.length > 1) {
          // Between attempts another writer commits the same id to another far record, so only the retry conflicts.
          await memory.enrich(W, { records: [], relations: [{ id: 'retry-link', type: 'qualifies', from: 'retry-from', to: { scope: F, id: 'f-observation' },
            attribution: 'x', evidence }] });
          return action(tx);
        }
        let severed = false;
        return action({ run: async (...args) => { const result = await tx.run(...args); if (!severed) { severed = true; relay.sever(); } return result; } });
      });
      const config = join(scratch, 'links-retry-config.json');
      const input = join(scratch, 'links-retry-input.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(config, JSON.stringify(fixtures.config));
      await writeFile(input, JSON.stringify({ records: [], relations: [{ id: 'retry-link', type: 'qualifies', from: 'retry-from', to: { scope: F, id: 'f-action' },
        attribution: 'x', evidence }] }));
      let reply;
      try {
        await main(['enrich', '--config', config, '--scope', W, '--input', input], { store, stdout: { write: line => { reply = JSON.parse(line); } }, stderr: { write() {} } });
      } catch (error) { reply = failureReply('enrich', error); } finally { await relay.close(); }
      assert.deepEqual([attempts.length, reply], [2, { ok: false, error: 'relation_identity_conflict', stage: 'unknown' }]);
      assert.equal(await placeholders(), 0);
    });
  } finally {
    await base.close();
    await memory.close();
    await fixtures.close();
  }

  async function placeholders() {
    return (await memory.store.transaction('read', tx => tx.run('MATCH (p:SMLink) WHERE p.sm_placeholder IS NOT NULL OR p.body IS NULL RETURN count(p) AS count')))
      .records[0].get('count');
  }

  async function snapshot(scope) {
    const output = join(scratch, `links-${scope}-${Date.now()}.json`);
    await exportScope({ driver: memory.store.driver, scope, output, allowedDir: scratch });
    // Neo4j returns property maps in no fixed key order.
    return canonical(JSON.parse(await readFile(output, 'utf8')));
  }
  return results;
}

