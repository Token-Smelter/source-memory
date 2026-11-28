// Owner-only, one-shot repair of one retained turn's byte-oversized, vectorless derived chunks. Every step needs the owner's
// authority for that scope; apply and inverse also need the owner's attested writer quiescence. Private files (frozen
// preimage, plan with inverse) are written 0600 and never overwritten; stdout carries digests and counts only.
//   freeze    --config C --scope S --turn UID --expected N --out FROZEN
//   stage     --config C --frozen FROZEN --out PLAN
//   apply     --config C --plan PLAN --quiescence-ref REF
//   reconcile --config C --plan PLAN
//   inverse   --config C --plan PLAN --quiescence-ref REF
import { readFile, writeFile } from 'node:fs/promises';
import { authorize, integer, MemoryError, requireThat } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { apply, freeze, inverse, reconcile, REPAIR_CONTRACT, stage } from '../src/one-turn-repair.mjs';
import { Neo4jStore } from '../src/store.mjs';

const COMMANDS = {
  freeze: ['--config', '--scope', '--turn', '--expected', '--out'],
  stage: ['--config', '--frozen', '--out'],
  apply: ['--config', '--plan', '--quiescence-ref'],
  reconcile: ['--config', '--plan'],
  inverse: ['--config', '--plan', '--quiescence-ref'],
};

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
const writePrivate = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });

// The scope must be named verbatim in the grant: a subtree grant that covers it is not authority for this repair.
function grantedScope(config, scope, operation) {
  const exact = authorize(config, scope, operation);
  requireThat(Array.isArray(config.scopes?.[operation]) && config.scopes[operation].includes(exact), 'scope_denied');
  return exact;
}

async function run({ command, values }) {
  const config = await readJson(values['--config']);
  const store = new Neo4jStore(config.neo4j);
  const handles = { driver: store.driver, database: store.database, store };
  try {
    if (command === 'freeze') {
      const scope = grantedScope(config, values['--scope'], 'write');
      const frozen = await freeze({ ...handles, scope, turnUid: values['--turn'], embeddingKey: embeddingIdentity(config.embedding),
        expectedTargets: integer(Number(values['--expected']), undefined, 1, 16) });
      await writePrivate(values['--out'], frozen);
      return { contract: REPAIR_CONTRACT, step: 'freeze', frozen_digest: frozen.frozen_digest, targets: frozen.targets.length };
    }
    if (command === 'stage') {
      const frozen = await readJson(values['--frozen']);
      grantedScope(config, frozen.scope, 'write');
      const plan = await stage({ frozen, config });
      await writePrivate(values['--out'], plan);
      return { contract: REPAIR_CONTRACT, step: 'stage', frozen_digest: plan.frozen_digest, plan_digest: plan.plan_digest,
        targets: plan.replacements.length, replacements: plan.postimage.created.length };
    }
    const plan = await readJson(values['--plan']);
    grantedScope(config, plan.frozen.scope, command === 'reconcile' ? 'read' : 'write');
    if (command === 'reconcile') return reconcile({ ...handles, plan });
    const quiescence = values['--quiescence-ref'];
    requireThat(/^[A-Za-z0-9._:-]{1,128}$/u.test(quiescence), 'invalid_input');
    const receipt = await (command === 'apply' ? apply : inverse)({ ...handles, plan });
    return { ...receipt, quiescence_ref: quiescence };
  } finally {
    await store.close();
  }
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
// An `unknown` apply or inverse must be reconciled before anything else; it is never replayed.
if (output.ok && output.receipt.outcome && output.receipt.outcome !== 'committed') process.exitCode = 2;
