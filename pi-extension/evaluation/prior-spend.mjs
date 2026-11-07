const fail = code => Object.assign(new Error(code), { code });

/** A rerun may subtract only a closed ledger with every dispatched call accounted as received. */
export function priorSoftSpend(text) {
  let rows;
  try { rows = text.trimEnd().split('\n').map(JSON.parse); } catch { throw fail('prior_ledger_invalid'); }
  if (rows[0]?.type !== 'open' || rows[0].version !== 'soft-sdk-ledger/v1' || rows.at(-1)?.type !== 'close'
    || rows.at(-1).in_flight !== false || rows.at(-1).stopped !== null) throw fail('prior_ledger_unresolved');
  const starts = new Set(), completed = new Set();
  let spent = 0n;
  for (const row of rows.slice(1, -1)) {
    if (row.type === 'started') {
      if (!Number.isSafeInteger(row.id) || starts.has(row.id)) throw fail('prior_ledger_invalid');
      starts.add(row.id);
    } else if (row.type === 'result') {
      if (!starts.has(row.id) || completed.has(row.id) || row.outcome !== 'received' || row.stop !== null
        || !/^(0|[1-9]\d*)$/.test(row.api_equivalent_nano ?? '')) throw fail('prior_ledger_unresolved');
      completed.add(row.id); spent += BigInt(row.api_equivalent_nano);
    } else throw fail('prior_ledger_invalid');
  }
  if (starts.size !== completed.size || rows.at(-1).calls_started !== starts.size || rows.at(-1).spent_nano !== spent.toString()) throw fail('prior_ledger_unresolved');
  return spent.toString();
}
