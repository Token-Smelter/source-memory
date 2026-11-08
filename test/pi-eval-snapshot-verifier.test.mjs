import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotVerifier } from '../pi-extension/evaluation/snapshot-verifier.mjs';

function snapshot(text) {
  return { schema: 'source-memory-logical-snapshot/v1', scope: 'fiction',
    nodes: [{ uid: 'record', labels: ['SMRecord'], properties: { uid: 'record', text } }], relationships: [] };
}

test('a changed store is not accepted as the held snapshot', async () => {
  const checks = [], held = { id: 'epoch', async verify() { return 'epoch'; } };
  const verify = createSnapshotVerifier({ held, expectedSnapshot: snapshot('original'),
    async capture() { return { snapshot: snapshot('changed'), receipt: { id: 'check' } }; }, onCheck: row => checks.push(row) });
  assert.deepEqual([await verify('time'), checks[0].equivalent], [null, false]);
});

test('a valid export is refused if the held epoch changes during capture', async () => {
  let calls = 0;
  const held = { id: 'epoch', async verify() { return ++calls === 1 ? 'epoch' : null; } };
  const verify = createSnapshotVerifier({ held, expectedSnapshot: snapshot('original'),
    async capture() { return { snapshot: snapshot('original'), receipt: {} }; }, onCheck() {} });
  assert.equal(await verify('time'), null);
});
