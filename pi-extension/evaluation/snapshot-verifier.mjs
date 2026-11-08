import { sameLogicalSnapshot } from '../restore-scope.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** Verify the held epoch and re-exported logical contents before or after each retrieval. */
export function createSnapshotVerifier({ held, expectedSnapshot, capture, onCheck }) {
  if (!held?.id || typeof held.verify !== 'function' || !expectedSnapshot || typeof capture !== 'function' || typeof onCheck !== 'function') throw fail('snapshot_verifier_invalid');
  return async time => {
    if (await held.verify(time) !== held.id) return null;
    const { snapshot, receipt } = await capture();
    const equivalent = sameLogicalSnapshot(expectedSnapshot, snapshot);
    await onCheck({ ...receipt, equivalent });
    return equivalent && await held.verify(time) === held.id ? held.id : null;
  };
}
