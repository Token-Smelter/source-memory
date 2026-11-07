import test from 'node:test';
import assert from 'node:assert/strict';
import { namespace } from '../src/core.mjs';
import { restoreScope, sameLogicalSnapshot } from '../pi-extension/restore-scope.mjs';

function fixture() {
  const scope = 'fiction', ns = namespace(scope);
  return { schema: 'source-memory-logical-snapshot/v1', scope,
    nodes: [{ uid: 'turn', labels: ['SMTurn', `${ns}Turn`], properties: { uid: 'turn', scope, body: 'fiction',
      created_at: { year: 2030, month: 1, day: 2, hour: 3, minute: 4, second: 5, nanosecond: 0, timeZoneOffsetSeconds: 0 } } },
    { uid: 'record', labels: ['SMRecord', `${ns}Record`], properties: { uid: 'record', scope, embedding: [1, 0] } }],
    relationships: [{ from: 'record', to: 'turn', type: 'SM_EVIDENCE', properties: {} }] };
}

test('private restore writes only validated scoped node and relationship types in one transaction', async () => {
  const queries = [];
  const driver = { session() { return { async executeWrite(fn) { return fn({ async run(query, params) { queries.push({ query, params });
    return query.startsWith('MATCH (n)') ? { records: [{ get: () => 0 }] } : { records: [] }; } }); }, async close() {} }; } };
  const result = await restoreScope({ driver, snapshot: fixture(), scope: 'fiction' });
  assert.deepEqual([result.nodes, result.relationships, queries.length], [2, 1, 4]);
});

test('restore refuses foreign labels before database access', async () => {
  let called = false;
  const snapshot = fixture(); snapshot.nodes[0].labels.push('Other');
  await assert.rejects(restoreScope({ driver: { session() { called = true; } }, snapshot, scope: 'fiction' }), /snapshot_invalid/);
  assert.equal(called, false);
});

test('logical comparison ignores label order but detects changed vector contents', () => {
  const one = fixture(), two = structuredClone(one);
  two.nodes[0].labels.reverse();
  assert.equal(sameLogicalSnapshot(one, two), true);
  two.nodes[1].properties.embedding[0] = 0.5;
  assert.equal(sameLogicalSnapshot(one, two), false);
});
