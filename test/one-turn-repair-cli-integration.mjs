import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Memory } from '../src/memory.mjs';
import { chunkEntries, indexNames, normalizeTurn } from '../src/core.mjs';
import { evidenceSpansForEntry } from '../src/evidence-spans.mjs';
import { DEFAULT_TREATMENT } from '../src/chunk-policy.mjs';
import { embeddingIdentity } from '../src/models.mjs';

// Rehearsal of the written live procedure through the command-line tool, on a disposable store, with the same commands and
// journal layout. It uses the verified served tokenizer and the local Ollama on fictional text only: the native transport
// for the repair, the existing vector key for everything else. It needs the served blob on this host and an owner's slot.
const exec = promisify(execFile);
// The command under rehearsal; REPAIR_CLI may name the exact checkout the live run will use.
const SCRIPT = process.env.REPAIR_CLI ?? fileURLToPath(new URL('../scripts/one-turn-repair.mjs', import.meta.url));
const SCOPE = 'repair-cli-fixture';
const BLOB = '/usr/share/ollama/.ollama/models/blobs/sha256-0800cbac9c2064dde519420e75e512a83cb360de3ad5df176185dc69652fc515';
const words = (count, word) => Array.from({ length: count }, (_, i) => `${word}${i % 13}`).join(' ');

async function cli(args) {
  try {
    const { stdout } = await exec(process.execPath, [SCRIPT, ...args], { timeout: 900_000 });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (error) {
    const text = (error.stdout || error.stderr || '').trim();
    return { code: error.code, out: text ? JSON.parse(text) : null };
  }
}

async function run(driver, query, params = {}) {
  const session = driver.session();
  try { return (await session.run(query, params)).records; } finally { await session.close(); }
}

// Three vectorless, oversized rows over one entry, as an older chunker left them.
async function plantOversized(driver, turnUid, entryId, text, key) {
  const first = text.indexOf(' ', Math.floor(text.length / 3));
  const second = text.indexOf(' ', Math.floor((2 * text.length) / 3));
  const [template] = await run(driver, `MATCH (t:SMTurn {uid:$turn})-[:SM_HAS_CHUNK]->(c:SMChunk {entry_id:$entry})
    RETURN labels(c) AS labels, c.role AS role, c.ordinal AS ordinal ORDER BY c.ordinal LIMIT 1`, { turn: turnUid, entry: entryId });
  await run(driver, 'MATCH (t:SMTurn {uid:$turn})-[:SM_HAS_CHUNK]->(c:SMChunk {entry_id:$entry}) DETACH DELETE c', { turn: turnUid, entry: entryId });
  const labels = template.get('labels').map(label => `\`${label}\``).join(':');
  for (const [index, [start, end]] of [[0, first], [first + 1, second], [second + 1, text.length]].entries()) {
    assert.ok(Buffer.byteLength(text.slice(start, end)) > 8192);
    await run(driver, `MATCH (t:SMTurn {uid:$turn}) CREATE (c:${labels}) SET c.uid=$uid, c.scope=$scope, c.turn_uid=$turn, c.entry_id=$entry,
      c.role=$role, c.ordinal=$ordinal, c.start=$start, c.end=$end, c.text=$text, c.embedding_oversized_key=$key,
      c.embedding_oversized_cap=8192, c.embedding_oversized_text=$text CREATE (t)-[:SM_HAS_CHUNK]->(c)`, { turn: turnUid,
      uid: `chunk_cli_planted_${index}`, scope: SCOPE, entry: entryId, role: template.get('role'), ordinal: template.get('ordinal') + index,
      start, end, text: text.slice(start, end), key });
  }
}

export async function runOneTurnRepairCli(database, scratch) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const journalRoot = join(scratch, 'repair-journal');
  await mkdir(journalRoot, { mode: 0o700 });
  const embedding = { url: 'http://127.0.0.1:11434/v1/embeddings', model: 'embeddinggemma', dimensions: 768, timeout_ms: 60_000 };
  const owner = { neo4j: database, scopes: { read: [SCOPE], write: [SCOPE] }, index_on_write: false, repair_journal_dir: journalRoot,
    embedding: { ...embedding, ollama_transport: 'native_no_truncate', ollama_context_revision: DEFAULT_TREATMENT.serving_revision,
      tokenizer: { gguf: BLOB, sha256: DEFAULT_TREATMENT.tokenizer_sha256 } } };
  const paths = { owner: join(scratch, 'OWNER.json'), frozen: join(scratch, 'FROZEN.json'), plan: join(scratch, 'PLAN.json') };
  await writeFile(paths.owner, JSON.stringify(owner), { mode: 0o600 });
  const memory = new Memory({ neo4j: database, scopes: owner.scopes, index_on_write: false, embedding });
  const driver = memory.store.driver;
  const key = embeddingIdentity(embedding);
  assert.equal(key, embeddingIdentity(owner.embedding), 'the owner config names the scope\'s existing vector key');
  const big = `${words(2600, 'lantern')} ${words(1800, 'harbor')} quartzbeacon ${words(1500, 'meadow')}`;
  let frozenDigest;
  let planDigest;
  const journal = () => readdir(join(journalRoot, planDigest)).catch(() => []);
  try {
    await memory.init(SCOPE);
    const legacy = normalizeTurn({ source: 'repair-cli-fixture', conversation_id: 'c', turn_id: 't1', lineage_root: true,
      entries: [{ id: 'e0', role: 'user', text: 'A short fictional preface.' }, { id: 'e1', role: 'assistant', text: big }] });
    const turnUid = (await memory.store.ingest(SCOPE, legacy, chunkEntries(legacy))).id;
    await memory.enrich(SCOPE, { records: [{ id: 'r1', kind: 'observation', text: 'The long entry names harbors.', attribution: 'fixture',
      evidence: [{ turn: turnUid, entry_id: 'e1', start: 0, end: 40 }] }], relations: [] });
    await plantOversized(driver, turnUid, 'e1', big, key);
    await memory.index(SCOPE, { limit: 2048 });
    const storeId = (await memory.store.identity()).database_id;
    const recordBefore = await memory.show(SCOPE, { kind: 'record', id: 'r1' });
    const apply = (command = 'apply') => cli([command, '--config', paths.owner, '--plan', paths.plan, '--approved-plan', planDigest,
      '--custody-ref', 'rehearsal-custodian', '--quiescence-ref', 'rehearsal-quiet']);
    const reconcile = async () => (await cli(['reconcile', '--config', paths.owner, '--plan', paths.plan])).out.state;

    await check('P1 freeze through the command selects the one turn, binds the three rows in the named store and prints no content', async () => {
      const wrong = await cli(['freeze', '--config', paths.owner, '--store-id', 'another-store', '--scope', SCOPE, '--out', join(scratch, 'unused-frozen.json')]);
      assert.equal(wrong.out.error, 'repair_store_mismatch');
      const result = await cli(['freeze', '--config', paths.owner, '--store-id', storeId, '--scope', SCOPE, '--out', paths.frozen]);
      assert.equal(result.code, 0, JSON.stringify(result.out));
      assert.deepEqual([result.out.targets, result.out.store_id, result.out.turn_uid], [3, storeId, turnUid]);
      frozenDigest = result.out.frozen_digest;
      assert.ok(!JSON.stringify(result.out).includes('lantern'), 'no content on stdout');
    });

    await check('P2 stage through the command embeds each piece alone on the served model with an exact count', async () => {
      const refused = await cli(['stage', '--config', paths.owner, '--frozen', paths.frozen, '--approved-frozen', 'f'.repeat(64),
        '--max-pieces', '64', '--max-seconds', '600', '--out', join(scratch, 'unused.json')]);
      assert.equal(refused.out.error, 'repair_frozen_not_approved');
      const result = await cli(['stage', '--config', paths.owner, '--frozen', paths.frozen, '--approved-frozen', frozenDigest,
        '--max-pieces', '64', '--max-seconds', '600', '--out', paths.plan]);
      assert.equal(result.code, 0, JSON.stringify(result.out));
      assert.ok(result.out.replacements > 3);
      planDigest = result.out.plan_digest;
    });

    await check('P3 apply commits once, and the verification of step 4 holds', async () => {
      assert.deepEqual((await apply()).out.outcome, 'committed');
      assert.equal(await reconcile(), 'postimage');
      assert.equal((await memory.status(SCOPE)).unindexed, 0);
      assert.deepEqual(await memory.show(SCOPE, { kind: 'record', id: 'r1' }), recordBefore, 'citations unchanged');
      const offered = evidenceSpansForEntry(legacy.entries[1], await memory.sourceChunks(SCOPE, turnUid));
      assert.deepEqual(offered.omissions, []);
      const names = indexNames(SCOPE);
      const states = await run(driver, 'SHOW INDEXES YIELD name, state WHERE name IN $names RETURN state', { names: [names.chunks, names.vectorChunks] });
      assert.deepEqual(states.map(row => row.get('state')), ['ONLINE', 'ONLINE']);
      const lexical = await run(driver, 'CALL db.index.fulltext.queryNodes($index, $query) YIELD node RETURN node.repair_of AS of',
        { index: names.chunks, query: 'quartzbeacon' });
      assert.ok(lexical.length > 0 && lexical.every(row => typeof row.get('of') === 'string'));
      const recall = await memory.recall(SCOPE, { query: 'quartzbeacon meadow', limit: 8 });
      assert.deepEqual([recall.channels.chunk_vector.status, recall.channels.chunk_lexical.status], ['ready', 'ready']);
      assert.equal((await apply()).out.error, 'repair_preimage_changed', 'a second apply is refused');
    });

    await check('P4 inverse restores the preimage through the command, and the same plan applies again', async () => {
      assert.equal((await apply('inverse')).out.outcome, 'committed');
      assert.equal(await reconcile(), 'preimage');
      assert.equal((await memory.status(SCOPE)).unindexed, 3, 'the original blocker is back by design');
      assert.equal((await apply()).out.outcome, 'committed');
      assert.equal(await reconcile(), 'postimage');
    });

    await check('P5 an attempt killed mid-run is a stop: writes are held until reconcile and an attempt-bound disposition', async () => {
      // Kill the inverse as soon as its attempt is durably started, so its outcome is never recorded.
      const before = (await journal()).filter(name => /^attempt-\d+\.json$/u.test(name)).length;
      const child = spawn(process.execPath, [SCRIPT, 'inverse', '--config', paths.owner, '--plan', paths.plan, '--approved-plan', planDigest,
        '--custody-ref', 'rehearsal-custodian', '--quiescence-ref', 'rehearsal-quiet'], { stdio: 'ignore' });
      const number = before + 1;
      for (let tries = 0; !(await journal()).includes(`attempt-${number}.json`); tries++) {
        assert.ok(tries < 2000, 'the attempt started');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
      assert.ok(!(await journal()).includes(`attempt-${number}.outcome.json`), 'no outcome was recorded');
      assert.equal((await apply()).out.error, 'repair_disposition_required', 'the next write is held');
      const state = await reconcile();
      assert.ok(['preimage', 'postimage'].includes(state), state);
      const disposed = await cli(['dispose', '--config', paths.owner, '--plan', paths.plan, '--attempt', String(number), '--state', state,
        '--ref', 'rehearsal-disposition']);
      assert.equal(disposed.out.attempt, number);
      // After the disposition, the owner chooses the step that matches the observed state.
      const next = await apply(state === 'postimage' ? 'inverse' : 'apply');
      assert.equal(next.out.outcome, 'committed');
      assert.equal(await reconcile(), state === 'postimage' ? 'preimage' : 'postimage');
    });
  } finally {
    await memory.close();
  }
  return results;
}
