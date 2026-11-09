import { createDailyInputBudget, createLiveGate, createUsageLedger } from '../../pi-extension/live-gate.mjs';

// One process asking the shared gate for an interval at a given instant; prints admitted or the refusal code.
const [directory, startAt] = process.argv.slice(2);
const ledger = createUsageLedger({ directory, now: () => new Date('2026-03-01T10:00:00Z') });
const budget = createDailyInputBudget({ ledger, limit: 1000 });
const gate = createLiveGate({ scope: 'private', grants: { read: ['private'], write: ['private'] }, budget, ledger, maxIntervalsPerDay: 1 });
while (Date.now() < Number(startAt)) { /* align the contenders */ }
try { await gate({}); process.stdout.write('admitted\n'); }
catch (error) { process.stdout.write(`${error.code}\n`); }
finally { ledger.close(); }
