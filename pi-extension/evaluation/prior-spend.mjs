import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const localStops = new Set(['input_budget_exhausted', 'input_budget_unknown']);
/** Operator-approved worker soft share, API-equivalent at SDK rates (raised from 100 USD for D0 and T1–T5). */
export const WORKER_SHARE_NANO = 250_000_000_000n;

export function validatePriorSpendContinuity(previousNano, priorReportedNano) {
  if (!/^(0|[1-9]\d*)$/.test(previousNano ?? '') || !/^(0|[1-9]\d*)$/.test(priorReportedNano ?? '')
    || BigInt(previousNano) < BigInt(priorReportedNano)) throw fail('prior_spend_chain_incomplete');
  return previousNano;
}

/** Conservative prior total from closed ledgers' recorded spend plus an explicit reserve for unresolved calls. */
export function attestedPriorSpend(attestation, ledgerTexts) {
  if (attestation?.schema !== 'prior-spend-attestation/v1' || !Array.isArray(attestation.ledgers) || !Array.isArray(ledgerTexts)
    || ledgerTexts.length !== attestation.ledgers.length || !/^(0|[1-9]\d*)$/.test(attestation.unresolved_reserve_nano ?? '')
    || new Set(attestation.ledgers.map(row => row?.sha256)).size !== attestation.ledgers.length) throw fail('prior_attestation_invalid');
  let total = BigInt(attestation.unresolved_reserve_nano), unresolved = 0, required = 0n;
  ledgerTexts.forEach((text, index) => {
    let rows;
    try { rows = text.trimEnd().split('\n').map(JSON.parse); } catch { throw fail('prior_ledger_invalid'); }
    const close = rows.at(-1);
    if (sha(text) !== attestation.ledgers[index].sha256 || rows[0]?.type !== 'open' || rows[0].version !== 'soft-sdk-ledger/v1'
      || close?.type !== 'close' || close.in_flight !== false || !/^(0|[1-9]\d*)$/.test(close.spent_nano ?? '')) throw fail('prior_attestation_invalid');
    total += BigInt(close.spent_nano);
    for (const row of rows.filter(item => item.type === 'result' && item.outcome !== 'received' && item.outcome !== 'not_sent')) {
      const started = rows.find(item => item.type === 'started' && item.id === row.id);
      if (!/^(0|[1-9]\d*)$/.test(started?.estimated_nano ?? '')) throw fail('prior_attestation_invalid');
      required += 2n * BigInt(started.estimated_nano);
      unresolved++;
    }
  });
  // Matches the live stop rule: an unresolved call may have cost up to twice its estimate.
  if (BigInt(attestation.unresolved_reserve_nano) < required) throw fail('prior_attestation_invalid');
  return { totalNano: total.toString(), unresolvedCalls: unresolved };
}

/** A closed ledger may exclude a pre-dispatch call only with a typed or pinned reconciliation receipt. */
export function priorSoftSpend(text, { reconciliations = [] } = {}) {
  let rows;
  try { rows = text.trimEnd().split('\n').map(JSON.parse); } catch { throw fail('prior_ledger_invalid'); }
  if (!Array.isArray(reconciliations) || rows[0]?.type !== 'open' || rows[0].version !== 'soft-sdk-ledger/v1'
    || rows.at(-1)?.type !== 'close' || rows.at(-1).in_flight !== false) throw fail('prior_ledger_unresolved');
  const ledgerSha = sha(text), approvals = new Map();
  for (const receipt of reconciliations) {
    if (receipt?.schema !== 'soft-ledger-reconciliation/v1' || receipt.ledger_sha256 !== ledgerSha
      || !Number.isSafeInteger(receipt.call_id) || receipt.call_id < 1 || receipt.decision !== 'not_sent'
      || receipt.reported_error !== 'input_budget_exhausted' || receipt.additional_upstream_request !== false
      || !/^[a-f0-9]{64}$/.test(receipt.transcript_row_sha256 ?? '') || !/^[a-f0-9]{64}$/.test(receipt.budget_code_sha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(receipt.gateway_correlation_sha256 ?? '') || approvals.has(receipt.call_id)) throw fail('prior_ledger_unresolved');
    approvals.set(receipt.call_id, receipt);
  }
  const starts = new Set(), completed = new Set(), usedApprovals = new Set();
  let spent = 0n, localStop = null;
  for (const row of rows.slice(1, -1)) {
    if (row.type === 'started') {
      if (!Number.isSafeInteger(row.id) || starts.has(row.id)) throw fail('prior_ledger_invalid');
      starts.add(row.id);
    } else if (row.type === 'stop_requested') {
      if (localStop || !['SIGINT', 'SIGTERM'].includes(row.reason) || typeof row.in_flight !== 'boolean') throw fail('prior_ledger_unresolved');
      localStop = 'operator_interrupted';
    } else if (row.type === 'result') {
      if (!starts.has(row.id) || completed.has(row.id)) throw fail('prior_ledger_unresolved');
      if (row.outcome === 'received' && (row.stop === null || (row.stop === 'operator_interrupted' && localStop === row.stop))
        && /^(0|[1-9]\d*)$/.test(row.api_equivalent_nano ?? '')) spent += BigInt(row.api_equivalent_nano);
      else if (row.outcome === 'not_sent' && localStops.has(row.reason) && row.stop === row.reason
        && row.provenance === 'bound-runtime-pre-dispatch') localStop = row.stop;
      else if (row.outcome === 'unknown' && row.stop === 'dispatch_unknown' && approvals.has(row.id)) {
        usedApprovals.add(row.id); localStop = row.stop;
      } else throw fail('prior_ledger_unresolved');
      completed.add(row.id);
    } else throw fail('prior_ledger_invalid');
  }
  const close = rows.at(-1);
  if (starts.size !== completed.size || close.calls_started !== starts.size || close.spent_nano !== spent.toString()
    || (close.stopped !== null && close.stopped !== localStop) || usedApprovals.size !== approvals.size) throw fail('prior_ledger_unresolved');
  return spent.toString();
}
