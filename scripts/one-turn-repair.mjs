// Owner-only, one-shot repair of one pre-manifest turn's three byte-oversized, vectorless derived chunks. Every step needs the
// owner's grant naming that scope; apply and inverse also need writers to have ceased under the owner's control, which this
// tool records but cannot verify. Private files are written 0600, fsynced and never overwritten; stdout carries digests only.
//   freeze    --config C --scope S --turn UID --out FROZEN
//   stage     --config C --frozen FROZEN --max-pieces N --max-seconds N --out PLAN
//   apply     --config C --plan PLAN --approved-plan DIGEST --quiescence-ref REF --attempt-log LOG
//   inverse   --config C --plan PLAN --approved-plan DIGEST --quiescence-ref REF --attempt-log LOG
//   reconcile --config C --plan PLAN
//   dispose   --plan PLAN --attempt-log LOG --state preimage|postimage --ref REF
// After any outcome other than committed or rolled_back, apply and inverse refuse until `dispose` records the owner's
// settlement of that attempt.
import { appendFile, open, readFile } from 'node:fs/promises';
import { authorize, integer, MemoryError, requireThat } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { apply, freeze, inverse, reconcile, REPAIR_CONTRACT, stage } from '../src/one-turn-repair.mjs';
import { Neo4jStore } from '../src/store.mjs';

const COMMANDS = {
  freeze: ['--config', '--scope', '--turn', '--out'],
  stage: ['--config', '--frozen', '--max-pieces', '--max-seconds', '--out'],
  apply: ['--config', '--plan', '--approved-plan', '--quiescence-ref', '--attempt-log'],
  inverse: ['--config', '--plan', '--approved-plan', '--quiescence-ref', '--attempt-log'],
  reconcile: ['--config', '--plan'],
  dispose: ['--plan', '--attempt-log', '--state', '--ref'],
};
const REF = /^[A-Za-z0-9._:-]{1,128}$/u;
// `refused`: the step threw before any write transaction began (apply and inverse report every write outcome instead).
const SETTLED = ['committed', 'rolled_back', 'refused', 'disposed'];

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

// Written once, private and durable before the command reports success.
async function writePrivate(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
}

async function readLog(path) {
  let text = '';
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function appendLog(path, entry) {
  await appendFile(path, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// The last attempt of this plan must be settled before another write may start.
async function requireSettled(path, planDigest) {
  const entries = (await readLog(path)).filter(entry => entry.plan_digest === planDigest);
  requireThat(!entries.length || SETTLED.includes(entries.at(-1).outcome), 'repair_disposition_required');
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
  if (command === 'dispose') {
    const plan = await readJson(values['--plan']);
    requireThat(['preimage', 'postimage'].includes(values['--state']) && REF.test(values['--ref']), 'invalid_input');
    await appendLog(values['--attempt-log'], { plan_digest: plan.plan_digest, outcome: 'disposed', state: values['--state'], ref: values['--ref'] });
    return { contract: REPAIR_CONTRACT, step: 'dispose', plan_digest: plan.plan_digest, state: values['--state'] };
  }
  const config = await readJson(values['--config']);
  if (command === 'freeze') {
    const scope = grantedScope(config, values['--scope'], 'write');
    return withStore(config, async handles => {
      const frozen = await freeze({ ...handles, scope, turnUid: values['--turn'], embeddingKey: embeddingIdentity(config.embedding) });
      await writePrivate(values['--out'], frozen);
      return { contract: REPAIR_CONTRACT, step: 'freeze', frozen_digest: frozen.frozen_digest, targets: frozen.targets.length };
    });
  }
  if (command === 'stage') {
    const frozen = await readJson(values['--frozen']);
    grantedScope(config, frozen.scope, 'write');
    const budget = { max_pieces: integer(Number(values['--max-pieces']), undefined, 1, 256), max_seconds: integer(Number(values['--max-seconds']), undefined, 1, 3600) };
    const plan = await stage({ frozen, config, budget });
    await writePrivate(values['--out'], plan);
    return { contract: REPAIR_CONTRACT, step: 'stage', frozen_digest: plan.frozen_digest, plan_digest: plan.plan_digest,
      targets: plan.replacements.length, replacements: plan.postimage.created.length };
  }
  const plan = await readJson(values['--plan']);
  grantedScope(config, plan.frozen.scope, command === 'reconcile' ? 'read' : 'write');
  if (command === 'reconcile') return withStore(config, handles => reconcile({ ...handles, plan }));
  requireThat(values['--approved-plan'] === plan.plan_digest, 'repair_plan_not_approved');
  requireThat(REF.test(values['--quiescence-ref']), 'invalid_input');
  const log = values['--attempt-log'];
  await requireSettled(log, plan.plan_digest);
  // The attempt is logged as started before the write, so a crash leaves it unsettled rather than forgotten.
  await appendLog(log, { plan_digest: plan.plan_digest, step: command, outcome: 'started', quiescence_ref: values['--quiescence-ref'] });
  let receipt;
  try { receipt = await withStore(config, handles => (command === 'apply' ? apply : inverse)({ ...handles, plan, config })); }
  catch (error) {
    await appendLog(log, { plan_digest: plan.plan_digest, step: command, outcome: 'refused' });
    throw error;
  }
  await appendLog(log, { plan_digest: plan.plan_digest, step: command, outcome: receipt.outcome, cleanup: receipt.cleanup });
  return { ...receipt, quiescence_ref: values['--quiescence-ref'] };
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
