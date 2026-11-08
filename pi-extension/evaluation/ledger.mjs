import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { hash, verifySeal } from './seal.mjs';

const fail = code => Object.assign(new Error(code), { code });
const text = value => typeof value === 'string' && value.trim().length > 0;
const uint = value => Number.isSafeInteger(value) && value >= 0;
const nat = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const fields = ['input', 'cacheRead', 'cacheWrite', 'output'];
const rateValid = rates => rates && fields.every(k => uint(rates[k]));

export function estimateUsageNano(usage, rates, semantics) {
  if (!rateValid(rates) || !['included', 'separate'].includes(semantics) || !usage || fields.some(k => !uint(usage[k]))) return null;
  let input = usage.input;
  if (semantics === 'included') {
    input -= usage.cacheRead + usage.cacheWrite;
    if (input < 0) return null;
  }
  return (BigInt(input) * BigInt(rates.input) + BigInt(usage.cacheRead) * BigInt(rates.cacheRead)
    + BigInt(usage.cacheWrite) * BigInt(rates.cacheWrite) + BigInt(usage.output) * BigInt(rates.output)).toString();
}

function bound(bounds) {
  if (!bounds || !uint(bounds.maxInputTokens) || bounds.maxInputTokens < 1 || !uint(bounds.maxOutputTokens) || bounds.maxOutputTokens < 1
    || !uint(bounds.maxProviderAttempts) || bounds.maxProviderAttempts < 1 || !uint(bounds.fixedNano)
    || !rateValid(bounds.rates) || !text(bounds.boundEvidence) || !text(bounds.rateEvidence) || !text(bounds.rateCardVersion)
    || !/^[a-f0-9]{64}$/.test(bounds.modelFingerprint ?? '')
    || !['included', 'separate'].includes(bounds.inputSemantics)) throw fail('bound_unavailable');
  const r = bounds.rates;
  // Independent maxima are deliberately additive even when cache tokens overlap input.
  return ((BigInt(bounds.maxInputTokens) * (BigInt(r.input) + BigInt(r.cacheRead) + BigInt(r.cacheWrite))
    + BigInt(bounds.maxOutputTokens) * BigInt(r.output) + BigInt(bounds.fixedNano)) * BigInt(bounds.maxProviderAttempts)).toString();
}

export function openLedger({ path, seal, expectedDigest }) {
  const spec = verifySeal(seal, expectedDigest);
  const capNano = spec.budget.capNano;
  if (!isAbsolute(path ?? '') || !nat(capNano) || capNano === '0') throw fail('ledger_invalid');
  for (const routeBounds of Object.values(spec.budget.routes)) {
    bound(routeBounds);
    if (routeBounds.rateCardVersion !== spec.budget.rateCardVersion) throw fail('budget_seal_mismatch');
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS slots (plan_id TEXT NOT NULL REFERENCES plans(id), id TEXT NOT NULL, state TEXT NOT NULL,
      max_nano TEXT NOT NULL, data TEXT NOT NULL, started TEXT, observation TEXT, PRIMARY KEY(plan_id,id));
    CREATE TABLE IF NOT EXISTS charges (seq INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, slot_id TEXT NOT NULL,
      data TEXT NOT NULL, FOREIGN KEY(plan_id,slot_id) REFERENCES slots(plan_id,id));`);
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  };
  transaction(() => {
    const row = db.prepare("SELECT value FROM meta WHERE key='cap'").get();
    if (row && row.value !== capNano) throw fail('cap_mismatch');
    if (!row) db.prepare("INSERT INTO meta VALUES ('cap', ?)").run(capNano);
    const stored = db.prepare("SELECT value FROM meta WHERE key='seal'").get();
    if (stored && stored.value !== seal.digest) throw fail('seal_mismatch');
    if (!stored) db.prepare("INSERT INTO meta VALUES ('seal', ?)").run(seal.digest);
  });
  const held = () => db.prepare("SELECT max_nano FROM slots WHERE state != 'released'").all().reduce((n, r) => n + BigInt(r.max_nano), 0n);
  const poison = reason => db.prepare("INSERT INTO meta VALUES ('poisoned', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(reason);
  const unhealthy = () => db.prepare("SELECT value FROM meta WHERE key='poisoned'").get()?.value ?? null;
  const assertHealthy = () => { if (unhealthy()) throw fail('ledger_poisoned'); };
  const slotRow = (plan, id) => db.prepare('SELECT * FROM slots WHERE plan_id=? AND id=?').get(plan, id);
  const assertOpen = plan => {
    const p = db.prepare('SELECT * FROM plans WHERE id=?').get(plan);
    if (!p || p.state !== 'open') throw fail('plan_not_open');
    return JSON.parse(p.data);
  };
  return {
    reservePlan(plan) {
      if (![plan?.id, plan?.arm, plan?.purpose, plan?.taskVersion, plan?.policyVersion, plan?.requestedRoute, plan?.checkpoint, plan?.sessionKey].every(text)
        || !Array.isArray(plan?.slots) || !plan.slots.length || plan.slots.length > spec.budget.maxSlotsPerPlan) throw fail('plan_invalid');
      const purpose = spec.budget.purposes[plan.purpose];
      if (!spec.budget.routes[plan.requestedRoute] || !purpose || purpose.route !== plan.requestedRoute
        || purpose.taskVersion !== plan.taskVersion || plan.policyVersion !== spec.policyVersion) throw fail('budget_seal_mismatch');
      const ids = new Set();
      const slots = plan.slots.map(slot => {
        if (!text(slot?.id) || ids.has(slot.id) || !['initial', 'retry', 'repair', 'adjudication', 'model'].includes(slot.kind)
          || (slot.kind === 'initial' ? slot.parent !== null : !ids.has(slot.parent))) throw fail('slot_invalid');
        ids.add(slot.id);
        const maxNano = bound(slot.bounds);
        if (hash(slot.bounds) !== hash(spec.budget.routes[plan.requestedRoute])) throw fail('budget_seal_mismatch');
        return { ...slot, maxNano };
      });
      const max = slots.reduce((n, r) => n + BigInt(r.maxNano), 0n);
      return transaction(() => {
        assertHealthy();
        if (db.prepare('SELECT id FROM plans WHERE id=?').get(plan.id)) throw fail('plan_exists');
        if (db.prepare('SELECT count(*) AS count FROM plans').get().count >= spec.budget.maxPlans) throw fail('plan_limit');
        if (held() + max > BigInt(capNano)) throw fail('budget_exhausted');
        db.prepare('INSERT INTO plans VALUES (?, ?, ?)').run(plan.id, JSON.stringify(plan), 'open');
        const insert = db.prepare('INSERT INTO slots (plan_id,id,state,max_nano,data) VALUES (?,?,?,?,?)');
        for (const slot of slots) insert.run(plan.id, slot.id, 'reserved', slot.maxNano, JSON.stringify(slot));
        return { planId: plan.id, reservedNano: max.toString() };
      });
    },
    startSlot(planId, id, actual) {
      return transaction(() => {
        assertHealthy();
        const plan = assertOpen(planId);
        const row = slotRow(planId, id);
        if (!row || row.state !== 'reserved') throw fail('slot_not_reserved');
        const slot = JSON.parse(row.data);
        if (!uint(actual?.inputBoundTokens) || actual.inputBoundTokens > slot.bounds.maxInputTokens
          || actual?.providerBound !== true || !text(actual?.proofRef) || !/^[a-f0-9]{64}$/.test(actual?.contextFingerprint ?? '')
          || !uint(actual?.maxOutputTokens) || actual.maxOutputTokens < 1 || actual.maxOutputTokens > slot.bounds.maxOutputTokens
          || actual.route !== plan.requestedRoute || actual.modelFingerprint !== slot.bounds.modelFingerprint) throw fail('call_bound_unavailable');
        if (slot.parent) {
          const parent = slotRow(planId, slot.parent);
          if (!parent || parent.state !== 'observed') throw fail('parent_effect_unknown');
        }
        db.prepare("UPDATE slots SET state='started', started=? WHERE plan_id=? AND id=?").run(JSON.stringify({ ...actual, at: new Date().toISOString() }), planId, id);
        return { maxNano: row.max_nano };
      });
    },
    recordResult(planId, id, message, latencyMs, usageEvidence = null) {
      return transaction(() => {
        const row = slotRow(planId, id);
        if (!row || row.state !== 'started') throw fail('attempt_not_started');
        const plan = assertOpen(planId), slot = JSON.parse(row.data);
        const actualRoute = text(message?.provider) && text(message?.model) ? `${message.provider}/${message.model}` : null;
        const usage = message?.usage ?? null;
        const providerUsageVerified = usageEvidence?.source === 'provider_reported' && text(usageEvidence.reference);
        const usageEstimateNano = providerUsageVerified ? estimateUsageNano(usage, slot.bounds.rates, slot.bounds.inputSemantics) : null;
        const knownOutcome = message && ['stop', 'length', 'toolUse'].includes(message.stopReason) && actualRoute === plan.requestedRoute;
        const maxAttempts = BigInt(slot.bounds.maxProviderAttempts);
        const input = usage && fields.every(k => uint(usage[k])) ? BigInt(usage.input)
          + (slot.bounds.inputSemantics === 'separate' ? BigInt(usage.cacheRead) + BigInt(usage.cacheWrite) : 0n) : null;
        if (actualRoute && actualRoute !== plan.requestedRoute) poison('actual_route_changed');
        if (input !== null && (input > BigInt(slot.bounds.maxInputTokens) * maxAttempts
          || BigInt(usage.output) > BigInt(slot.bounds.maxOutputTokens) * maxAttempts
          || (usageEstimateNano !== null && BigInt(usageEstimateNano) > BigInt(row.max_nano)))) poison('reported_usage_exceeds_bound');
        const observation = { outcome: knownOutcome ? 'complete' : 'unknown', stopReason: message?.stopReason ?? null,
          actualRoute, usage, usageProvenance: providerUsageVerified ? 'provider_reported' : 'sdk_unverified',
          usageEvidence: providerUsageVerified ? usageEvidence : null, usageSemantics: slot.bounds.inputSemantics, usageEstimateNano,
          sdkCostTotal: typeof usage?.cost?.total === 'number' && Number.isFinite(usage.cost.total) ? usage.cost.total : null,
          sdkCostProvenance: 'sdk_estimate', providerCharge: null, latencyMs: uint(latencyMs) ? latencyMs : null,
          at: new Date().toISOString() };
        db.prepare('UPDATE slots SET state=?, observation=? WHERE plan_id=? AND id=?').run(knownOutcome ? 'observed' : 'unknown', JSON.stringify(observation), planId, id);
        return observation;
      });
    },
    recordUnknown(planId, id, reason) {
      return transaction(() => {
        const row = slotRow(planId, id);
        if (!row || row.state !== 'started') throw fail('attempt_not_started');
        const observation = { outcome: 'unknown', reason: text(reason) ? reason : 'unknown', usage: null, providerCharge: null, at: new Date().toISOString() };
        db.prepare("UPDATE slots SET state='unknown', observation=? WHERE plan_id=? AND id=?").run(JSON.stringify(observation), planId, id);
      });
    },
    reconcileAttempt(planId, id, proof) {
      return transaction(() => {
        assertOpen(planId);
        const row = slotRow(planId, id);
        if (!row || !['started', 'unknown'].includes(row.state)) throw fail('attempt_not_unknown');
        if (proof?.effectQuiesced !== true || !text(proof.reference) || !['failed', 'complete'].includes(proof.outcome)) throw fail('reconciliation_unverified');
        const previous = row.observation ? JSON.parse(row.observation) : { outcome: 'unknown', usage: null, providerCharge: null };
        const observation = { ...previous, outcome: proof.outcome, reconciliation: { ...proof, at: new Date().toISOString() } };
        db.prepare("UPDATE slots SET state='observed', observation=? WHERE plan_id=? AND id=?").run(JSON.stringify(observation), planId, id);
        return { outcome: proof.outcome, reservationRetained: row.max_nano, usage: observation.usage ?? null };
      });
    },
    recordCharge(planId, id, charge) {
      const result = transaction(() => {
        const row = slotRow(planId, id);
        if (!row || !['observed', 'unknown', 'started'].includes(row.state)) throw fail('attempt_not_found');
        if (!nat(charge?.nano) || !['provider_reported', 'invoice'].includes(charge?.provenance) || !text(charge?.reference)
          || charge?.final !== true || charge?.effectQuiesced !== true) throw fail('charge_unverified');
        const exceeded = BigInt(charge.nano) > BigInt(row.max_nano);
        if (exceeded) poison('charge_exceeds_bound');
        db.prepare('INSERT INTO charges (plan_id,slot_id,data) VALUES (?,?,?)').run(planId, id, JSON.stringify({ ...charge, at: new Date().toISOString() }));
        return { recorded: true, reservationRetained: row.max_nano, exceeded };
      });
      if (result.exceeded) throw fail('charge_exceeds_bound');
      return result;
    },
    finishPlan(planId) {
      return transaction(() => {
        assertOpen(planId);
        const rows = db.prepare('SELECT * FROM slots WHERE plan_id=?').all(planId);
        if (rows.some(r => ['started', 'unknown'].includes(r.state))) throw fail('in_flight_or_unknown');
        db.prepare("UPDATE slots SET state='released' WHERE plan_id=? AND state='reserved'").run(planId);
        db.prepare("UPDATE plans SET state='finished' WHERE id=?").run(planId);
      });
    },
    plan(planId) {
      const row = db.prepare('SELECT data,state FROM plans WHERE id=?').get(planId);
      return row ? { ...JSON.parse(row.data), state: row.state, sealDigest: seal.digest } : null;
    },
    attempt(planId, id) {
      const row = slotRow(planId, id);
      if (!row) return null;
      const charges = db.prepare('SELECT data FROM charges WHERE plan_id=? AND slot_id=? ORDER BY seq').all(planId, id).map(x => JSON.parse(x.data));
      const plan = db.prepare('SELECT data FROM plans WHERE id=?').get(planId);
      return { planId, id, state: row.state, maxNano: row.max_nano, ...JSON.parse(row.data), plan: JSON.parse(plan.data),
        started: row.started ? JSON.parse(row.started) : null, ...(row.observation ? JSON.parse(row.observation) : { outcome: 'unknown', usage: null, providerCharge: null }),
        providerCharge: charges.at(-1) ?? null, charges };
    },
    summary() {
      const rows = db.prepare('SELECT * FROM slots').all();
      const attempts = rows.filter(r => !['reserved', 'released'].includes(r.state));
      const observations = attempts.map(r => r.observation ? JSON.parse(r.observation) : null);
      const charges = attempts.map(r => db.prepare('SELECT data FROM charges WHERE plan_id=? AND slot_id=? ORDER BY seq DESC LIMIT 1').get(r.plan_id, r.id))
        .map(r => r ? JSON.parse(r.data) : null);
      return { capNano, sealDigest: seal.digest, heldNano: held().toString(), poisoned: unhealthy(), attempts: attempts.length,
        usageComplete: observations.every(o => o?.usageEstimateNano !== null && o?.usageEstimateNano !== undefined),
        usageEstimateKnownNano: observations.reduce((sum, o) => sum + BigInt(o?.usageEstimateNano ?? '0'), 0n).toString(),
        unknownEffects: rows.filter(r => ['started', 'unknown'].includes(r.state)).length,
        chargesComplete: charges.every(Boolean), providerChargeKnownNano: charges.reduce((sum, c) => sum + BigInt(c?.nano ?? '0'), 0n).toString(),
        sdkEstimates: observations.map(o => o?.sdkCostTotal ?? null) };
    },
    close() { db.close(); },
  };
}

export function contextFingerprint(value) { return hash(value); }
