import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/memory.mjs';
import { MemoryError } from '../src/core.mjs';

class UncachedMemory extends Memory {
  bundle(scope, seed, query, maxNodes, maxHops) {
    return super.bundle(scope, seed, query, maxNodes, maxHops);
  }

  followingForBundles(scope, seeds, follow, cache) {
    return super.followingForBundles(scope, seeds, follow, cache);
  }
}

function fixture({ lateRecord = false, failOnce = false, mutableChildren = false } = {}) {
  const calls = { turns: [], records: [], children: [], unlinked: [] };
  const config = { scopes: { read: ['primary', 'foreign'], write: [] } };
  let version = 'original';
  let failed = false;
  const turn = (scope, id = 'turn') => ({ id, scope, source: 'fictional', conversation_id: 'conversation', turn_id: `${id}-key`,
    occurred_at: '2025-01-01T00:00:00.000Z', entries: [{ id: 'user', role: 'user', text: `${scope} ${version} fixture source.` }] });
  const record = (scope, id) => ({ id, kind: 'decision', status: 'proposed', attribution: 'fictional extraction', text: `Claim ${id}`,
    evidence: [{ turn: 'turn', entry_id: 'user', start: 0, end: turn(scope).entries[0].text.length }] });
  const edge = (id, to) => ({ id, type: 'qualifies', from: 'turn', to, attribution: 'fictional relation',
    evidence: [{ turn: 'turn', entry_id: 'user', start: 0, end: 7 }] });
  const context = scope => [{ key: { scope, source: 'fictional', conversation_id: 'conversation' } }];
  const store = {
    async close() {},
    async lexicalStatus() { return { status: 'ready' }; },
    async admittedLexical(scope, kind) {
      const hits = kind === 'turn' ? (mutableChildren ? ['turn', 'later'] : ['turn']).map(id => ({ kind: 'turn', id,
        text: turn(scope, id).entries[0].text, conversations: context(scope) }))
        : kind === 'record' && !mutableChildren && !lateRecord ? ['turn', 'other'].map(id => ({ kind: 'record', id,
          text: record(scope, id).text, conversations: context(scope) })) : [];
      return { hits, omitted: [], admitted_conversations: hits.length ? 1 : 0, exhausted: false };
    },
    async getTurn(scope, id) {
      calls.turns.push([scope, id]);
      if (failOnce && !failed) { failed = true; throw new MemoryError('fixture_read_failed'); }
      return structuredClone(turn(scope, id));
    },
    async getRecord(scope, id) {
      calls.records.push([scope, id]);
      if (id === 'missing' && calls.records.filter(([, candidate]) => candidate === id).length === 1) return null;
      return structuredClone(record(scope, id));
    },
    async recordsForTurn(scope) {
      return mutableChildren ? [] : (lateRecord ? ['turn'] : ['turn', 'other']).map(id => structuredClone(record(scope, id)));
    },
    async neighbors() {
      return mutableChildren ? [] : lateRecord ? [edge('first', 'missing'), edge('second', 'missing')] : [edge('relation', 'other')];
    },
    async childTurns(scope, current) {
      calls.children.push([scope, current.id]);
      if (!mutableChildren) return [];
      if (current.id === 'turn') return [turn(scope, 'later')];
      if (current.id === 'later' && calls.children.filter(([, id]) => id === 'later').length > 1) return [turn(scope, 'branch-a'), turn(scope, 'branch-b')];
      return [];
    },
    async unlinkedTurns(scope, start) { calls.unlinked.push([scope, start.id]); return 0; },
  };
  return { config, store, calls, setVersion(value) { version = value; } };
}

const grouped = mode => ({ query: 'fixture', group: 'conversation', ...(mode ? { mode } : {}), limit: 12,
  max_nodes: 8, max_hops: 2, max_chars: mode === 'evidence_advice' ? 1000000 : 200000, follow: { turns: 8, bytes: 16384 } });

for (const mode of [undefined, 'evidence_advice', 'history_search']) {
  test(`grouped ${mode ?? 'absent-mode'} preserves all reply bytes while reusing successful UID reads`, async () => {
    const baseline = fixture();
    const candidate = fixture();
    const before = await new UncachedMemory(baseline.config, baseline.store).recall('primary', grouped(mode));
    const after = await new Memory(candidate.config, candidate.store).recall('primary', grouped(mode));
    assert.equal(JSON.stringify(after), JSON.stringify(before));
    assert.equal(candidate.calls.turns.length, 1);
    assert.equal(candidate.calls.records.length, 2);
    assert.ok(baseline.calls.turns.length > candidate.calls.turns.length);
    assert.ok(baseline.calls.records.length > candidate.calls.records.length);
    assert.deepEqual(candidate.calls.children, baseline.calls.children);
    assert.deepEqual(candidate.calls.unlinked, baseline.calls.unlinked);
  });
}

test('repeated grouped records retain independent nested evidence values', async () => {
  const observe = async MemoryType => {
    const value = fixture();
    const memory = new MemoryType(value.config, value.store);
    const reply = await memory.recall('primary', grouped('evidence_advice'));
    const seeds = reply.units.flatMap(unit => unit.seeds);
    const chosen = seeds.find(seed => seed.match.kind === 'record' && seed.match.id === 'turn');
    const siblings = seeds.filter(seed => seed !== chosen).flatMap(seed => seed.records.filter(record => record.id === 'turn'));
    const expected = structuredClone(siblings.map(record => record.evidence));
    const record = chosen.records.find(record => record.id === 'turn');
    record.evidence[0].start = 1;
    record.evidence.push({ turn: 'local-mutation', entry_id: 'user', start: 0, end: 1 });
    const next = await memory.recall('primary', grouped('evidence_advice'));
    return { siblings: siblings.map(record => record.evidence), expected,
      next: next.units.flatMap(unit => unit.seeds).flatMap(seed => seed.records.filter(row => row.id === 'turn')).map(row => row.evidence) };
  };
  const before = await observe(UncachedMemory);
  const after = await observe(Memory);
  assert.deepEqual(after, before);
  assert.deepEqual(after.siblings, after.expected);
});

test('a successful cached read keeps a private snapshot before its first return', async () => {
  const observe = async MemoryType => {
    const value = fixture();
    const loaded = [];
    const load = value.store.getRecord;
    value.store.getRecord = async (...args) => {
      const record = await load(...args);
      loaded.push(record);
      return record;
    };
    const memory = new MemoryType(value.config, value.store);
    const reads = new Map();
    const bundle = id => memory.bundle('primary', { kind: 'record', id, score: 1, channels: [] }, 'fixture', 8, 2, reads);
    const first = await bundle('turn');
    const sibling = await bundle('other');
    const expected = structuredClone(first.records.find(record => record.id === 'turn').evidence);
    first.records.find(record => record.id === 'turn').evidence[0].start = 1;
    first.records.find(record => record.id === 'turn').evidence.push({ turn: 'local-mutation', entry_id: 'user', start: 0, end: 1 });
    loaded[0].evidence[0].end = 1;
    const next = await bundle('turn');
    return { sibling: sibling.records.find(record => record.id === 'turn').evidence,
      next: next.records.find(record => record.id === 'turn').evidence, expected };
  };
  const before = await observe(UncachedMemory);
  const after = await observe(Memory);
  assert.deepEqual(after, before);
  assert.deepEqual([after.sibling, after.next], [after.expected, after.expected]);
});

test('ungrouped recall retains the existing reads and reply bytes', async () => {
  const baseline = fixture();
  const candidate = fixture();
  const hits = [{ kind: 'turn', id: 'turn', text: 'fixture' }, { kind: 'record', id: 'turn', text: 'fixture' }];
  for (const value of [baseline, candidate]) {
    value.store.lexical = async (_scope, kind) => hits.filter(hit => hit.kind === kind);
    value.store.chunkLexicalStatus = async () => ({ status: 'ready' });
    value.store.chunkLexical = async () => [];
  }
  const before = await new UncachedMemory(baseline.config, baseline.store).recall('primary', { query: 'fixture' });
  const after = await new Memory(candidate.config, candidate.store).recall('primary', { query: 'fixture' });
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.deepEqual(candidate.calls, baseline.calls);
});

test('successful reads do not survive the next request or cross a scope boundary', async () => {
  const value = fixture();
  const memory = new Memory(value.config, value.store);
  await memory.recall('primary', grouped('evidence_advice'));
  value.setVersion('changed between requests');
  const second = await memory.recall('primary', grouped('evidence_advice'));
  const foreign = await memory.recall('foreign', grouped('evidence_advice'));
  assert.match(second.units[0].seeds[0].records[0].supporting_evidence[0].text, /changed between requests/);
  assert.match(foreign.units[0].seeds[0].records[0].supporting_evidence[0].text, /^foreign /);
  assert.deepEqual(value.calls.turns, [['primary', 'turn'], ['primary', 'turn'], ['foreign', 'turn']]);
  await assert.rejects(memory.recall('denied', grouped('evidence_advice')), { code: 'scope_denied' });
  assert.equal(value.calls.turns.length, 3);
});

test('a missing record is not retained as a negative read inside a grouped request', async () => {
  const baseline = fixture({ lateRecord: true });
  const candidate = fixture({ lateRecord: true });
  const before = await new UncachedMemory(baseline.config, baseline.store).recall('primary', grouped('evidence_advice'));
  const after = await new Memory(candidate.config, candidate.store).recall('primary', grouped('evidence_advice'));
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.equal(candidate.calls.records.filter(([, id]) => id === 'missing').length, 2);
  assert.ok(after.units[0].seeds[0].records.some(record => record.id === 'missing'));
  assert.ok(after.units[0].seeds[0].gaps.includes('record_unavailable'));
});

test('a rejected read remains a rejection and does not poison the next request', async () => {
  const value = fixture({ failOnce: true });
  const memory = new Memory(value.config, value.store);
  await assert.rejects(memory.recall('primary', grouped('evidence_advice')), { code: 'fixture_read_failed' });
  const reply = await memory.recall('primary', grouped('evidence_advice'));
  assert.equal(reply.status, 'ready');
  assert.equal(value.calls.turns.length, 2);
});

test('following still observes mutable child lists separately for overlapping roots', async () => {
  const baseline = fixture({ mutableChildren: true });
  const candidate = fixture({ mutableChildren: true });
  const before = await new UncachedMemory(baseline.config, baseline.store).recall('primary', grouped('evidence_advice'));
  const after = await new Memory(candidate.config, candidate.store).recall('primary', grouped('evidence_advice'));
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.deepEqual(candidate.calls.children, baseline.calls.children);
  assert.equal(candidate.calls.children.filter(([, id]) => id === 'later').length, 2);
  assert.equal(after.units[0].following.find(row => row.after === 'turn').status, 'branched');
});
