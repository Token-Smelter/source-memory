// Owner-only, one-shot repair of one pre-manifest turn's three byte-oversized, vectorless derived chunks.
//
// External gates this tool records but cannot verify, and which must hold before and through apply or inverse:
// - the owner's exclusive custody of this repair (one operator, one plan file, no copies run elsewhere), named by
//   --custody-ref;
// - writer quiescence for the scope, named by --quiescence-ref;
// - settlement of any earlier attempt whose outcome was not committed or rolled back.
//
// Within that custody the tool keeps one attempt journal per plan, `<config.repair_journal_dir>/<plan digest>/`, and enforces
// it:
// - each apply or inverse first creates attempt-N exclusively and durably, so two runs cannot both start;
// - it refuses while any earlier attempt lacks a settled outcome or a disposition bound to that attempt.
// The journal is keyed by the plan digest, so a moved or copied plan file finds the same journal. A different journal
// directory or host does not, which is why custody stays an external gate.
//
// Private files are written 0600, fsynced, with their directory entry fsynced too, and never overwritten. Stdout carries
// digests only.
//   freeze    --config C --store-id ID --scope S --turn UID --out FROZEN
//   stage     --config C --frozen FROZEN --approved-frozen DIGEST --max-pieces N --max-seconds N --out PLAN
//   apply     --config C --plan PLAN --approved-plan DIGEST --custody-ref REF --quiescence-ref REF
//   inverse   --config C --plan PLAN --approved-plan DIGEST --custody-ref REF --quiescence-ref REF
//   reconcile --config C --plan PLAN
//   dispose   --config C --plan PLAN --attempt N --state preimage|postimage --ref REF
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { authorize, integer, MemoryError, requireThat } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { apply, freeze, inverse, reconcile, REPAIR_CONTRACT, stage } from '../src/one-turn-repair.mjs';
import { Neo4jStore } from '../src/store.mjs';

const COMMANDS = {
  freeze: ['--config', '--store-id', '--scope', '--turn', '--out'],
  stage: ['--config', '--frozen', '--approved-frozen', '--max-pieces', '--max-seconds', '--out'],
  apply: ['--config', '--plan', '--approved-plan', '--custody-ref', '--quiescence-ref'],
  inverse: ['--config', '--plan', '--approved-plan', '--custody-ref', '--quiescence-ref'],
  reconcile: ['--config', '--plan'],
  dispose: ['--config', '--plan', '--attempt', '--state', '--ref'],
};
const REF = /^[A-Za-z0-9._:-]{1,128}$/u;
// Outcomes that settle an attempt by themselves. `refused`: the step threw before any write transaction began.
const SETTLED = ['committed', 'rolled_back', 'refused'];

function options([command, ...argv]) {
  const names = COMMANDS[command];
  if (!names || argv.length !== names.length * 2) return null;
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (!names.includes(name) || Object.hasOwn(values, name) || typeof value !== 'string' || value.startsWith('--')) return null;
    values[name] = value;
  }
  return { command, values };
}

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Written exactly once (exclusive create), private and durable, directory entry included, before the command goes on.
async function writeOnceFile(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

function journalOf(config, plan) {
  requireThat(typeof config.repair_journal_dir === 'string' && isAbsolute(config.repair_journal_dir)
    && /^[0-9a-f]{64}$/u.test(plan.plan_digest ?? ''), 'invalid_input');
  return join(config.repair_journal_dir, plan.plan_digest);
}

async function attempts(journal) {
  let names = [];
  try { names = await readdir(journal); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const numbers = names.map(name => /^attempt-(\d+)\.json$/u.exec(name)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  return Promise.all(numbers.map(async number => {
    const read = async suffix => { try { return await readJson(join(journal, `attempt-${number}.${suffix}.json`)); } catch { return null; } };
    return { number, outcome: await read('outcome'), disposition: await read('disposed') };
  }));
}

const settled = attempt => (attempt.outcome && SETTLED.includes(attempt.outcome.outcome)) || attempt.disposition !== null;

// Refuses while any earlier attempt is unsettled, then claims the next attempt number by exclusive create.
async function startAttempt(journal, entry) {
  await mkdir(journal, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(journal));
  const existing = await attempts(journal);
  requireThat(existing.every(settled), 'repair_disposition_required');
  const number = (existing.at(-1)?.number ?? 0) + 1;
  try { await writeOnceFile(join(journal, `attempt-${number}.json`), { ...entry, attempt: number, started_at: new Date().toISOString() }); }
  catch (error) { if (error.code === 'EEXIST') throw new MemoryError('repair_attempt_concurrent'); throw error; }
  return number;
}

// The scope must be named verbatim in the grant: a subtree grant that covers it is not authority for this repair.
function grantedScope(config, scope, operation) {
  const exact = authorize(config, scope, operation);
  requireThat(Array.isArray(config.scopes?.[operation]) && config.scopes[operation].includes(exact), 'scope_denied');
  return exact;
}

async function withStore(config, work) {
  const store = new Neo4jStore(config.neo4j);
  let receipt;
  try { receipt = await work({ driver: store.driver, database: store.database }); }
  finally {
    // A failed close never replaces a step's recorded outcome; it is reported beside it.
    try { await store.close(); } catch { if (receipt) receipt = { ...receipt, store_cleanup: 'failed' }; }
  }
  return receipt;
}

async function run({ command, values }) {
  const config = await readJson(values['--config']);
  if (command === 'dispose') {
    const plan = await readJson(values['--plan']);
    requireThat(['preimage', 'postimage'].includes(values['--state']) && REF.test(values['--ref']), 'invalid_input');
    const number = integer(Number(values['--attempt']), undefined, 1, 1_000_000);
    const journal = journalOf(config, plan);
    const attempt = (await attempts(journal)).find(item => item.number === number);
    // Only an existing, unsettled attempt of this plan can be disposed, and only once.
    requireThat(attempt && !settled(attempt), 'repair_attempt_not_unsettled');
    await writeOnceFile(join(journal, `attempt-${number}.disposed.json`), { plan_digest: plan.plan_digest, attempt: number,
      state: values['--state'], ref: values['--ref'], at: new Date().toISOString() });
    return { contract: REPAIR_CONTRACT, step: 'dispose', plan_digest: plan.plan_digest, attempt: number, state: values['--state'] };
  }
  if (command === 'freeze') {
    // Freezing reads the rows' content and prepares a write, so the scope must be granted for both, by name.
    const scope = grantedScope(config, values['--scope'], 'read');
    grantedScope(config, scope, 'write');
    requireThat(REF.test(values['--store-id']), 'invalid_input');
    const expectedStore = { database_id: values['--store-id'], database: config.neo4j?.database ?? 'neo4j' };
    return withStore(config, async handles => {
      const frozen = await freeze({ ...handles, expectedStore, scope, turnUid: values['--turn'], embeddingKey: embeddingIdentity(config.embedding) });
      await writeOnceFile(values['--out'], frozen);
      return { contract: REPAIR_CONTRACT, step: 'freeze', frozen_digest: frozen.frozen_digest, targets: frozen.targets.length };
    });
  }
  if (command === 'stage') {
    const frozen = await readJson(values['--frozen']);
    grantedScope(config, frozen.scope, 'read');
    grantedScope(config, frozen.scope, 'write');
    const budget = { max_pieces: integer(Number(values['--max-pieces']), undefined, 1, 256), max_seconds: integer(Number(values['--max-seconds']), undefined, 1, 3600) };
    const plan = await stage({ frozen, approvedFrozen: values['--approved-frozen'], config, budget });
    await writeOnceFile(values['--out'], plan);
    return { contract: REPAIR_CONTRACT, step: 'stage', frozen_digest: plan.frozen_digest, plan_digest: plan.plan_digest,
      targets: plan.replacements.length, replacements: plan.postimage.created.length };
  }
  const plan = await readJson(values['--plan']);
  // Every remaining step reads the rows' content; apply and inverse also write.
  grantedScope(config, plan.frozen.scope, 'read');
  if (command !== 'reconcile') grantedScope(config, plan.frozen.scope, 'write');
  if (command === 'reconcile') return withStore(config, handles => reconcile({ ...handles, plan }));
  requireThat(values['--approved-plan'] === plan.plan_digest, 'repair_plan_not_approved');
  requireThat(REF.test(values['--custody-ref']) && REF.test(values['--quiescence-ref']), 'invalid_input');
  const journal = journalOf(config, plan);
  const number = await startAttempt(journal, { plan_digest: plan.plan_digest, step: command,
    custody_ref: values['--custody-ref'], quiescence_ref: values['--quiescence-ref'] });
  let receipt;
  try { receipt = await withStore(config, handles => (command === 'apply' ? apply : inverse)({ ...handles, plan, config })); }
  catch (error) {
    await writeOnceFile(join(journal, `attempt-${number}.outcome.json`), { attempt: number, outcome: 'refused' });
    throw error;
  }
  await writeOnceFile(join(journal, `attempt-${number}.outcome.json`), { attempt: number, outcome: receipt.outcome, cleanup: receipt.cleanup });
  return { ...receipt, attempt: number, custody_ref: values['--custody-ref'], quiescence_ref: values['--quiescence-ref'] };
}

const parsed = options(process.argv.slice(2));
let output;
try {
  output = parsed ? { ok: true, receipt: await run(parsed) } : { ok: false, error: 'invalid_input' };
} catch (error) {
  // Only a code: a message could carry stored text.
  output = { ok: false, error: error instanceof MemoryError && /^[a-z_]{1,64}$/u.test(error.code) ? error.code : 'repair_failed' };
}
if (output.ok) process.stdout.write(`${JSON.stringify(output.receipt)}\n`);
else {
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
}
// An apply or inverse that did not commit or acknowledge its rollback must be reconciled and disposed, never replayed.
if (output.ok && output.receipt.outcome && !['committed', 'rolled_back'].includes(output.receipt.outcome)) process.exitCode = 2;
