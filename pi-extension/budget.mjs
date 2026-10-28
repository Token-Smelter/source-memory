const fail = code => Object.assign(new Error(code), { code });

/** Reported input and cache usage are charged after each call; a single call may overshoot the ceiling. */
export function createInputBudget(limit = 20_000_000, { onReceipt = () => {} } = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw fail('input_budget_invalid');
  let used = 0;
  let unknown = false;
  let started = 0;
  const receipts = [];
  const persist = receipt => {
    try { onReceipt(receipt); } catch { unknown = true; throw fail('usage_receipt_unavailable'); }
  };
  return {
    beforeCall() {
      if (unknown || started !== receipts.length) throw fail('input_budget_unknown');
      if (used >= limit) throw fail('input_budget_exhausted');
      started++;
    },
    record(usage) {
      const fields = ['input', 'cacheRead', 'cacheWrite'];
      if (!usage || fields.some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0)) {
        unknown = true;
        const receipt = { status: 'unknown' };
        receipts.push(receipt);
        persist(receipt);
        return;
      }
      const amount = fields.reduce((sum, key) => sum + usage[key], 0);
      if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(used + amount)) {
        unknown = true;
        const receipt = { status: 'unknown' };
        receipts.push(receipt);
        persist(receipt);
        return;
      }
      used += amount;
      const receipt = { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        output: Number.isSafeInteger(usage.output) ? usage.output : null };
      receipts.push(receipt);
      persist(receipt);
    },
    used: () => used,
    started: () => started,
    receipts: () => structuredClone(receipts),
    reason: () => unknown || started !== receipts.length ? 'input_budget_unknown' : used >= limit ? 'input_budget_exhausted' : null,
    limit,
  };
}

/** Check between SDK stream calls; no provider hook or mid-request cancellation is used. */
export function boundPiRuntime(runtime, budget) {
  if (!runtime || typeof runtime.streamSimple !== 'function' || typeof budget?.beforeCall !== 'function') throw fail('runtime_invalid');
  return new Proxy(runtime, {
    get(target, key) {
      if (key === 'streamSimple') return (model, ...args) => {
        budget.beforeCall();
        return target.streamSimple(model, ...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
