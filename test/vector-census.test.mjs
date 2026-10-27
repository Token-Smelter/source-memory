import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Neo4jStore } from '../src/store.mjs';
import { MemoryError } from '../src/core.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/vector-census-validation.json', import.meta.url), 'utf8'));

function expectedFromGraph(value, kind) {
  const nodes = new Map(value.nodes.map(node => [node.uid, node]));
  const visible = node => !value.exclude.some(row => row.source === node.properties.source
    && row.conversation_id === node.properties.conversation_id);
  const parents = (node, relationship) => value.relationships.filter(edge => edge.type === relationship
    && (relationship === 'SM_HAS_CHUNK' ? edge.to === node.uid : edge.from === node.uid))
    .map(edge => nodes.get(relationship === 'SM_HAS_CHUNK' ? edge.from : edge.to))
    .filter(parent => parent.labels.includes('SMTurn'));
  const eligible = node => value.exclude.length === 0
    || (node.labels.includes('SMTurn') && visible(node))
    || (node.labels.includes('SMChunk') && parents(node, 'SM_HAS_CHUNK').some(visible))
    || (node.labels.includes('SMRecord') && (!parents(node, 'SM_EVIDENCE').length || parents(node, 'SM_EVIDENCE').some(visible)));
  const selected = value.nodes.filter(node => node.properties.scope === value.scope
    && node.labels.includes(`@${kind === 'chunk' ? 'Chunk' : 'Record'}`) && eligible(node));
  const total = selected.filter(node => node.properties.embedding_key === value.model).length;
  const unindexed = selected.filter(node => node.properties.embedding_key == null || node.properties.embedding_key !== value.model).length;
  return { eligible_uids: selected.map(node => node.uid).sort(), total, unindexed, exhausted_at_limit64: total > 64 };
}

test('full-branch CASE accepts exactly the true rows of a three-valued OR', () => {
  const values = [false, null, true];
  const checks = [];
  for (const a of values) for (const b of values) for (const c of values) for (const d of values) {
    const branches = [a, b, c, d];
    const original = branches.includes(true) ? true : branches.includes(null) ? null : false;
    const guarded = branches.find(value => value === true) ?? false;
    checks.push((original === true) === (guarded === true));
  }
  assert.deepEqual(checks, Array(81).fill(true));
});

test('predeclared census UID sets and counts match an independent graph oracle', () => {
  const observed = fixture.cases.map(value => ({ name: value.name,
    expected: Object.fromEntries(['chunk', 'record'].map(kind => [kind, expectedFromGraph(value, kind)])) }));
  assert.deepEqual(observed, fixture.cases.map(value => ({ name: value.name, expected: value.expected })));
});

test('census keeps full branch guards and unchanged model partitions for both kinds', async () => {
  const queries = [];
  const store = Object.assign(Object.create(Neo4jStore.prototype), {
    transaction: async (_mode, action) => action({ run: async (query, parameters) => {
      queries.push({ query, parameters });
      return { records: [{ toObject: () => ({ total: 1, unindexed: 2 }) }] };
    } }),
  });
  const counts = await Promise.all(['chunk', 'record'].map(kind => store.vectorCounts('fixture', kind, 'model', [])));
  assert.deepEqual(counts, [{ total: 1, unindexed: 2 }, { total: 1, unindexed: 2 }]);
  for (const { query } of queries) {
    assert.match(query, /WHERE CASE\s+WHEN size\(\$exclude\) = 0 THEN true/u);
    assert.match(query, /WHEN node:SMTurn AND NOT coalesce/u);
    assert.match(query, /WHEN node:SMChunk AND EXISTS/u);
    assert.match(query, /WHEN node:SMRecord AND \(NOT EXISTS/u);
    assert.match(query, /count\(CASE WHEN node\.embedding_key=\$model THEN 1 END\) AS total/u);
    assert.match(query, /count\(CASE WHEN node\.embedding_key IS NULL OR node\.embedding_key<>\$model THEN 1 END\) AS unindexed/u);
  }
});

test('one census kind failure does not prevent a sibling count result', async () => {
  const store = Object.assign(Object.create(Neo4jStore.prototype), {
    transaction: async (_mode, action) => action({ run: async query => {
      if (query.includes('Chunk {scope:$scope}')) throw new MemoryError('fixture_census_failure');
      return { records: [{ toObject: () => ({ total: 3, unindexed: 1 }) }] };
    } }),
  });
  const [chunk, record] = await Promise.allSettled(['chunk', 'record'].map(kind => store.vectorCounts('fixture', kind, 'model')));
  assert.deepEqual([chunk.status, chunk.reason.code, record], ['rejected', 'fixture_census_failure',
    { status: 'fulfilled', value: { total: 3, unindexed: 1 } }]);
});
