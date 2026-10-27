import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BASE = 'f297cfeda39acba287c50e58ead5fe81c94c00cc';
const IMAGE = 'neo4j:5.26.14-community';
const IMAGE_ID = 'sha256:93b9442f84d72b8ebb4a6bb2cd38564e29ccb7dc265fdd3c1fe5fa3c42b38902';
const FIXTURE_HASH = 'e5dc138ca346a4059617e99a32a68a5010ff96d9dc71c4cf711ee25f1292e370';
const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), '..');
const fixturePath = join(project, 'test/fixtures/vector-census-validation.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value;
const errorData = error => ({ code: error.code ?? null, message: String(error.message).slice(0, 1500) });
const git = async (root, ...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();

const SELF_ID = `SHOW TRANSACTIONS YIELD database,transactionId,connectionId,clientAddress,currentQueryId,currentQuery,parameters,metaData,status
  WHERE database=$database AND metaData.census_run=$run AND metaData.census_leaf=$leaf
  RETURN database,transactionId,connectionId,clientAddress,currentQueryId,currentQuery,parameters,metaData,status LIMIT 2`;
const GATE = `SHOW TRANSACTIONS YIELD database,transactionId,connectionId,clientAddress,currentQueryId,currentQuery,parameters,metaData,status
  WHERE database=$database
  RETURN database,transactionId,connectionId,clientAddress,currentQueryId,currentQuery,parameters,metaData,status LIMIT 17`;
const PROJECTIONS = `RETURN count(CASE WHEN node.embedding_key=$model THEN 1 END) AS total,
          count(CASE WHEN node.embedding_key IS NULL OR node.embedding_key<>$model THEN 1 END) AS unindexed`;

function options(argv) {
  assert.equal(argv.length % 2, 0, 'arguments must be --name value pairs');
  const values = {};
  for (let n = 0; n < argv.length; n += 2) {
    assert.ok(['--before', '--after', '--freeze', '--report-dir', '--worker', '--config', '--request'].includes(argv[n]));
    assert.equal(Object.hasOwn(values, argv[n]), false);
    values[argv[n]] = argv[n + 1];
  }
  return values;
}

function operators(plan) {
  if (!plan) return [];
  return [{ operator: plan.operatorType, db_hits: number(plan.dbHits), rows: number(plan.rows),
    server_time_raw: number(plan.time), arguments: plan.arguments }, ...plan.children.flatMap(operators)];
}

async function query(tx, role, cypher, parameters, profile, log, progressPath) {
  const row = { role, cypher, cypher_sha256: hash(cypher), parameters, profile_requested: profile,
    started_at: new Date().toISOString(), db_hits: null };
  const started = performance.now();
  try {
    const result = await tx.run(profile ? `PROFILE ${cypher}` : cypher, parameters);
    row.operators = operators(result.summary?.profile);
    row.result_available_after_ms = number(result.summary?.resultAvailableAfter) ?? null;
    row.result_consumed_after_ms = number(result.summary?.resultConsumedAfter) ?? null;
    row.rows_returned = result.records.length;
    row.db_hits = row.operators.length && row.operators.every(op => Number.isFinite(op.db_hits))
      ? row.operators.reduce((sum, op) => sum + op.db_hits, 0) : null;
    row.db_hits_absence = row.db_hits === null
      ? profile ? 'server_returned_no_profile_db_hit_counters' : 'not_profiled_no_db_hit_counters_returned_not_zero' : null;
    return result;
  } catch (error) { row.failure = errorData(error); throw error; }
  finally {
    row.wall_ms = performance.now() - started;
    log.push(row);
    if (progressPath) await appendFile(progressPath, JSON.stringify(row) + '\n', { mode: 0o600 });
  }
}

async function worker(args) {
  assert.deepEqual(Object.keys(args).sort(), ['--config', '--request', '--worker']);
  const root = resolve(args['--worker']);
  const config = JSON.parse(await readFile(args['--config'], 'utf8'));
  const request = JSON.parse(await readFile(args['--request'], 'utf8'));
  assert.ok(['check', 'profile'].includes(request.phase));
  assert.ok(['chunk', 'record'].includes(request.kind));
  const { Neo4jStore } = await import(pathToFileURL(join(root, 'src/store.mjs')).href);
  const store = new Neo4jStore(config);
  const log = [];
  const progressPath = join(dirname(resolve(args['--request'])), 'worker.queries.jsonl');
  const reply = { ok: false, run: request.run, leaf: request.leaf, arm: request.arm, phase: request.phase,
    case: request.value.name, kind: request.kind, queries: log, transaction_attempts: 0,
    timing_scope: 'Instrumented standalone census transaction, not production recall latency' };
  const metadata = { census_run: request.run, census_leaf: request.leaf, census_scope: request.value.scope,
    census_model: request.value.model, census_kind: request.kind };
  store.transaction = async (mode, action) => {
    assert.equal(mode, 'read');
    const session = store.driver.session({ database: store.database });
    try {
      return await session.executeRead(async tx => {
        reply.transaction_attempts += 1;
        assert.equal(reply.transaction_attempts, 1, 'no workload retry is admitted');
        let workloadQuery;
        let workloadParameters;
        const counts = await action({ run: async (cypher, parameters) => {
          assert.equal(workloadQuery, undefined, 'census must issue exactly one workload count query');
          assert.ok(cypher.endsWith(PROJECTIONS), 'count projections changed');
          workloadQuery = cypher;
          workloadParameters = parameters;
          return query(tx, 'workload', cypher, parameters, request.phase === 'profile', log, progressPath);
        } });
        if (request.phase === 'check') {
          const membership = await query(tx, 'membership_oracle', workloadQuery.slice(0, -PROJECTIONS.length)
            + 'RETURN node.uid AS uid ORDER BY uid', workloadParameters, false, log, progressPath);
          reply.eligible_uids = membership.records.map(row => row.get('uid'));
        }
        const identity = await query(tx, 'self_id', SELF_ID,
          { database: store.database, run: request.run, leaf: request.leaf }, false, log, progressPath);
        assert.equal(identity.records.length, 1, 'same-transaction self identity is missing or ambiguous');
        reply.transaction_identity = identity.records[0].toObject();
        assert.ok(Buffer.byteLength(JSON.stringify(reply.transaction_identity)) <= 262144, 'post-materialization identity receipt cap exceeded');
        assert.deepEqual(reply.transaction_identity.metaData, metadata);
        for (const key of ['transactionId', 'connectionId', 'clientAddress']) {
          assert.ok(typeof reply.transaction_identity[key] === 'string' && reply.transaction_identity[key].length > 0);
        }
        return counts;
      }, { timeout: 15000, metadata });
    } finally { await session.close(); }
  };
  try {
    reply.counts = await store.vectorCounts(request.value.scope, request.kind, request.value.model, request.value.exclude);
    reply.ok = true;
  } catch (error) { reply.failure = errorData(error); process.exitCode = 1; }
  finally {
    try { await store.close(); reply.driver_closed = true; }
    catch (error) { reply.close_failure = errorData(error); reply.ok = false; process.exitCode = 1; }
    process.stdout.write(JSON.stringify(reply) + '\n');
  }
}

async function capture({ arm, configPath, requestPath, output, home }) {
  const argv = [script, '--worker', arm.root, '--config', configPath, '--request', requestPath];
  const started = performance.now();
  const result = await new Promise(resolve => {
    let callback;
    const child = execFile(process.execPath, argv, { cwd: arm.root, encoding: 'buffer', timeout: 4000,
      killSignal: 'SIGKILL', maxBuffer: 2065536,
      env: { HOME: home, TMPDIR: home, LANG: 'C.UTF-8', PATH: '/home/mike/.nvm/versions/node/v22.19.0/bin:/usr/bin:/bin' } },
    (error, stdout, stderr) => { callback = { error, stdout, stderr }; });
    child.once('close', (code, signal) => resolve({ ...callback, elapsed_ms: performance.now() - started,
      close: { observed: true, code, signal, bound_pid: child.pid ?? null }, callback_observed: Boolean(callback) }));
  });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  await writeFile(join(output, 'worker.stdout.bin'), stdout, { mode: 0o600 });
  await writeFile(join(output, 'worker.stderr.bin'), stderr.subarray(0, 8192), { mode: 0o600 });
  const summary = { command: { executable: process.execPath, argv }, elapsed_ms: result.elapsed_ms, close: result.close,
    callback_observed: result.callback_observed, error: result.error ? errorData(result.error) : null,
    callback_code: result.error ? result.error.code ?? null : 0,
    error_code_property_present: Boolean(result.error && Object.hasOwn(result.error, 'code')),
    callback_signal: result.error?.signal ?? null, killed: result.error?.killed ?? false,
    overflow_reported: result.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    stdout_bytes_collected: stdout.length, stdout_sha256: hash(stdout), stderr_bytes_collected: stderr.length,
    stderr_retained: Math.min(stderr.length, 8192), stderr_retention_truncated: stderr.length > 8192,
    collection_limit: 2065536, collection_caveat: 'Overflow bytes may be truncated, not total produced bytes',
    deadline_caveat: 'SIGKILL near4000ms is consistent with the leaf limit, not a timer-fired receipt' };
  await save(join(output, 'worker.close.json'), summary);
  return { summary, stdout };
}

function receiptGate({ neo4j, uri, run, output }) {
  const driver = neo4j.driver(uri, undefined, { disableLosslessIntegers: true, maxConnectionPoolSize: 1,
    connectionTimeout: 1000, connectionAcquisitionTimeout: 1000, maxTransactionRetryTime: 0,
    userAgent: `source-memory-census-observer/${run}` });
  async function snapshot(role, evidence) {
    const session = driver.session({ database: 'neo4j', defaultAccessMode: 'READ' });
    const metrics = [];
    let rows;
    try {
      const result = await query({ run: (cypher, params) => session.run(cypher, params,
        { timeout: 500, metadata: { owned_census_observer: run } }) }, role, GATE, { database: 'neo4j' }, false, metrics);
      rows = result.records.map(row => row.toObject());
    } finally { await session.close(); evidence.queries.push(...metrics); }
    const observation = { observed_at: new Date().toISOString(), role, rows };
    assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= 262144, 'post-materialization retention cap exceeded');
    evidence.snapshots.push(observation);
    await save(join(output, evidence.leaf + '-gate.json'), evidence);
    assert.ok(rows.length < 17, 'transaction inventory may be truncated');
    const self = rows.filter(row => row.metaData?.owned_census_observer === run);
    assert.equal(self.length, 1, 'observer identity missing or ambiguous');
    return rows.filter(row => row.metaData?.owned_census_observer !== run);
  }
  return {
    async observe(request, invoke) {
      const evidence = { leaf: request.leaf, queries: [], snapshots: [], gate: 'not_established',
        correlation: 'One private standalone worker; actual same-transaction server identity plus post-close cut. Not OS PID/socket proof or idle-connection absence.' };
      try {
        assert.equal((await snapshot('pre_leaf_gate', evidence)).length, 0, 'preexisting non-observer transaction');
        const { summary, stdout } = await invoke();
        evidence.close = summary;
        assert.equal(summary.close.observed, true);
        assert.ok(Number.isSafeInteger(summary.close.bound_pid) && summary.close.bound_pid > 0);
        // A failed worker still needs a diagnostic post-close cut; it never permits another leaf.
        const remaining = await snapshot('post_close_gate', evidence);
        assert.equal(summary.callback_observed, true);
        assert.equal(summary.error, null);
        assert.equal(summary.close.code, 0);
        assert.equal(summary.close.signal, null);
        assert.equal(summary.overflow_reported, false);
        const reply = JSON.parse(stdout.toString('utf8'));
        assert.equal(stdout.equals(Buffer.from(JSON.stringify(reply) + '\n')), true, 'noncanonical worker wire');
        assert.equal(reply.ok, true);
        assert.equal(reply.driver_closed, true);
        assert.equal(reply.transaction_attempts, 1);
        assert.deepEqual([reply.run, reply.leaf, reply.arm, reply.phase, reply.case, reply.kind],
          [run, request.leaf, request.arm, request.phase, request.value.name, request.kind]);
        const identity = reply.transaction_identity;
        assert.deepEqual(identity.metaData, { census_run: run, census_leaf: request.leaf, census_scope: request.value.scope,
          census_model: request.value.model, census_kind: request.kind });
        assert.equal(identity.database, 'neo4j');
        assert.equal(identity.currentQuery, SELF_ID);
        assert.deepEqual(identity.parameters, { database: 'neo4j', run, leaf: request.leaf });
        for (const key of ['transactionId', 'connectionId', 'clientAddress']) assert.ok(typeof identity[key] === 'string' && identity[key].length > 0);
        evidence.positive_identity = identity;
        assert.equal(remaining.length, 0, 'prior or unexpected transaction remains');
        evidence.gate = 'actual_close_positive_self_transaction_receipt_and_no_nonobserver_transaction_at_postcut';
        return { reply, close: summary, gate_queries: evidence.queries, gate_path: join(output, evidence.leaf + '-gate.json') };
      } catch (error) { evidence.failure = errorData(error); throw error; }
      finally { await save(join(output, evidence.leaf + '-gate.json'), evidence); }
    },
    close: () => driver.close(),
  };
}

async function pin(root) {
  root = resolve(root);
  assert.equal(await git(root, 'status', '--porcelain'), '', 'source must be clean and committed');
  const dependencies = [];
  const lockBytes = await readFile(join(root, 'package-lock.json'));
  for (const [path, declared] of Object.entries(JSON.parse(lockBytes).packages)) {
    if (!path) continue;
    const manifest = await readFile(join(root, path, 'package.json'));
    const installed = JSON.parse(manifest);
    assert.equal(installed.version, declared.version);
    dependencies.push({ path, version: installed.version, manifest_sha256: hash(manifest), real_path: await realpath(join(root, path)) });
  }
  return { root, head: await git(root, 'rev-parse', 'HEAD'), tree: await git(root, 'rev-parse', 'HEAD^{tree}'),
    lock_sha256: hash(lockBytes), dependencies };
}

async function controller(args) {
  assert.equal(process.version, 'v22.19.0');
  assert.deepEqual(Object.keys(args).sort(), ['--after', '--before', '--freeze', '--report-dir']);
  assert.equal(resolve(args['--after']), project, 'run the candidate harness from its frozen worktree');
  const freeze = JSON.parse(await readFile(args['--freeze'], 'utf8'));
  assert.equal(process.execPath, freeze.node_executable);
  const before = await pin(args['--before']);
  const after = await pin(args['--after']);
  assert.equal(before.head, BASE);
  assert.deepEqual({ before, after }, freeze.arms);
  assert.equal(hash(await readFile(script)), freeze.harness_sha256);
  const fixtureBytes = await readFile(fixturePath);
  assert.equal(hash(fixtureBytes), FIXTURE_HASH);
  assert.equal(FIXTURE_HASH, freeze.fixture_sha256);
  assert.equal(before.lock_sha256, after.lock_sha256);
  assert.deepEqual(before.dependencies, after.dependencies);
  assert.equal(await git(after.root, 'diff', '--name-only', BASE, after.head, '--', 'src'), 'src/store.mjs');
  for (const path of ['src/core.mjs', 'src/memory.mjs', 'src/models.mjs', 'src/envelope.mjs', 'bin/memory.mjs', 'package.json', 'package-lock.json']) {
    assert.equal(hash(await readFile(join(before.root, path))), hash(await readFile(join(after.root, path))), `non-census production drift: ${path}`);
  }
  const fixture = JSON.parse(fixtureBytes);
  assert.equal(fixture.cases.length, 16);
  const root = resolve(args['--report-dir']);
  await mkdir(root, { mode: 0o700 });
  const privateDir = join(root, 'private');
  await mkdir(privateDir, { mode: 0o700 });
  const run = randomUUID();
  const name = `source-memory-census-${run}`;
  const paths = { report: join(root, 'report.json'), method: join(root, 'method.json'), config: join(privateDir, 'database.json'),
    proceed: join(privateDir, 'container-record-relayed.json') };
  const method = { run_id: run, owner_pid: process.pid, name, id: null, paths, before, after,
    requested: { image: IMAGE, image_id: IMAGE_ID, memory_bytes: 2147483648, cpus: 2, heap_initial: '512m', heap_max: '512m',
      pagecache: '128m', transaction_memory: 'default', auth: 'none', loopback_random_bolt: true, bind_mounts: false },
    leaf_policy: '64 correctness plus80 PROFILE standalone workers at most; each4000ms/native execFile callback+close/SIGKILL/2065536bytes perstream. No retry, additional leaf or old-gate fallback.',
    receipt_method_delta: 'Same read transaction executes workload, optional correctness membership, then self-ID SHOW. Identical tagging/query operations in both arms. Transaction lifetime is extended; these are not pristine production plan or end-to-end latency timings.',
    query_accounting: 'Workload, membership, self-ID, pre-gate and post-close gate retain separate logs/times/dbhits. Catalog queries not PROFILEd have NULL dbhits, not0. No receipt/gate overhead credited as CASE savings.',
    timing_scope: 'Fresh worker processes on an already seeded database. No cold-database or warm production recall/API timing claim. PROFILE operator server_time_raw has no invented unit.',
    stop: 'docker stop --time10 exactrecordedID; docker rm --volumes exactrecordedID; independent absenceverification required. Owner stays live on closure UNKNOWN.' };
  const report = { started_at: new Date().toISOString(), method, fixture_sha256: FIXTURE_HASH, phase: 'identity', leaves: [],
    failure: null, observer_closed: false, container_closed: false, measured_end_to_end_latency: false, classification: 'uncompleted' };
  const persist = async () => { await save(paths.method, method); await save(paths.report, report); };
  const dockerEnv = { ...process.env };
  const docker = async (...argv) => (await exec('docker', argv, { env: dockerEnv })).stdout.trim();
  const inspect = async target => {
    try { return JSON.parse(await docker('inspect', target))[0]; }
    catch (error) { if (/No such (object|container)/iu.test(String(error.stderr))) return null; throw error; }
  };
  let store;
  let gate;
  let attemptedCreate = false;
  let observerCloseUnknown = false;
  const { Neo4jStore } = await import(pathToFileURL(join(after.root, 'src/store.mjs')).href);
  const { namespace } = await import(pathToFileURL(join(after.root, 'src/core.mjs')).href);
  const neo4j = createRequire(join(after.root, 'package.json'))('neo4j-driver');
  const fingerprint = async () => {
    const queries = [];
    for (const cypher of ['MATCH (n) RETURN labels(n) AS labels,properties(n) AS properties ORDER BY n.uid',
      'MATCH (a)-[r]->(b) RETURN a.uid AS source,type(r) AS type,b.uid AS target ORDER BY source,type,target',
      'SHOW INDEXES YIELD name,type,state,labelsOrTypes,properties,options RETURN name,type,state,labelsOrTypes,properties,options ORDER BY name']) {
      const result = await store.transaction('read', tx => tx.run(cypher));
      queries.push(result.records.map(row => row.toObject()));
    }
    return { nodes: queries[0], relationships: queries[1], indexes: queries[2] };
  };
  await persist();
  try {
    attemptedCreate = true;
    await docker('run', '--pull', 'never', '--detach', '--name', name, '--label', `source-memory.census-owner=${run}`, '--publish', '127.0.0.1::7687',
      '--memory', '2048m', '--cpus', '2', '--env', 'NEO4J_AUTH=none', '--env', 'NEO4J_server_memory_heap_initial__size=512m',
      '--env', 'NEO4J_server_memory_heap_max__size=512m', '--env', 'NEO4J_server_memory_pagecache_size=128m', IMAGE);
    const owned = await inspect(name);
    assert.equal(owned?.Config?.Labels?.['source-memory.census-owner'], run);
    method.id = owned.Id;
    await persist();
    assert.equal(owned.Config.Image, IMAGE);
    assert.equal(owned.Image, IMAGE_ID);
    assert.equal(owned.HostConfig.Memory, 2147483648);
    assert.equal(owned.HostConfig.NanoCpus, 2e9);
    assert.ok(owned.Mounts.every(mount => mount.Type === 'volume'));
    const bindings = owned.NetworkSettings.Ports['7687/tcp'];
    assert.equal(bindings.length, 1);
    const [binding] = bindings;
    assert.equal(binding.HostIp, '127.0.0.1');
    assert.ok(Number(binding.HostPort) > 0 && Number(binding.HostPort) !== 27690);
    const env = Object.fromEntries(owned.Config.Env.map(value => { const n = value.indexOf('='); return [value.slice(0, n), value.slice(n + 1)]; }));
    for (const [key, value] of Object.entries({ NEO4J_AUTH: 'none', NEO4J_server_memory_heap_initial__size: '512m',
      NEO4J_server_memory_heap_max__size: '512m', NEO4J_server_memory_pagecache_size: '128m' })) assert.equal(env[key], value);
    assert.equal(Object.keys(env).some(key => /transaction.*memory/iu.test(key)), false);
    const image = JSON.parse(await docker('image', 'inspect', owned.Image))[0];
    method.actual = { image: owned.Config.Image, image_id: owned.Image, image_digests: image.RepoDigests ?? [],
      binding: `${binding.HostIp}:${binding.HostPort}`, memory_bytes: owned.HostConfig.Memory, cpus: owned.HostConfig.NanoCpus / 1e9,
      auth: env.NEO4J_AUTH, heap_initial: env.NEO4J_server_memory_heap_initial__size, heap_max: env.NEO4J_server_memory_heap_max__size,
      pagecache: env.NEO4J_server_memory_pagecache_size, volumes: owned.Mounts.map(mount => ({ name: mount.Name, source: mount.Source, destination: mount.Destination })) };
    await persist();
    console.log(`CENSUS_IDENTITY ${JSON.stringify(method)}`);
    console.log(`CENSUS_WAITING_FOR_RECORD_RELAY ${paths.proceed}`);
    while (true) {
      let release;
      try { release = JSON.parse(await readFile(paths.proceed, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (release) { assert.equal(release.run_id, run); assert.equal(release.container_id, method.id); break; }
      await sleep(100);
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, { HOME: privateDir, TMPDIR: privateDir, LANG: 'C.UTF-8', PATH: dockerEnv.PATH });
    const config = { uri: `bolt://${method.actual.binding}`, auth: 'none', database: 'neo4j' };
    await save(paths.config, config);
    store = new Neo4jStore(config);
    report.phase = 'private_seed';
    const readyDeadline = Date.now() + 90000;
    while (true) {
      try { await store.transaction('read', tx => tx.run('RETURN 1 AS ready')); break; }
      catch (error) { if (Date.now() >= readyDeadline) throw error; await sleep(1000); }
    }
    for (const cypher of ['MATCH (n) RETURN count(n) AS count', 'MATCH ()-[r]->() RETURN count(r) AS count']) {
      assert.equal((await store.transaction('read', tx => tx.run(cypher))).records[0].get('count'), 0);
    }
    for (const value of fixture.cases) {
      await store.init(value.scope, 768);
      for (const node of value.nodes) {
        const labels = node.labels.map(label => label.startsWith('@') ? namespace(value.scope) + label.slice(1) : label);
        assert.ok(labels.every(label => /^[A-Za-z][A-Za-z0-9_]*$/u.test(label)));
        await store.transaction('write', tx => tx.run(`CREATE (n:${labels.join(':')}) SET n=$properties`, { properties: node.properties }));
      }
      for (const edge of value.relationships) {
        assert.ok(['SM_HAS_CHUNK', 'SM_EVIDENCE'].includes(edge.type));
        await store.transaction('write', tx => tx.run(`MATCH (a {uid:$source}),(b {uid:$target}) CREATE (a)-[:${edge.type}]->(b)`,
          { source: edge.from, target: edge.to }));
      }
    }
    const indexDeadline = Date.now() + 90000;
    while (true) {
      const catalog = await store.transaction('read', tx => tx.run('SHOW INDEXES YIELD state RETURN state'));
      if (catalog.records.every(row => row.get('state') === 'ONLINE')) break;
      if (Date.now() >= indexDeadline) throw new Error('fixture index population deadline exceeded');
      await sleep(100);
    }
    const frozen = await fingerprint();
    await save(join(root, 'frozen-graph-and-indexes.json'), frozen);
    report.frozen_sha256 = hash(JSON.stringify(frozen));
    await store.close();
    store = null;
    gate = receiptGate({ neo4j, uri: config.uri, run, output: root });
    let sequence = 0;
    async function leaf(phase, value, kind, armName, iteration) {
      const arm = armName === 'before' ? before : after;
      const id = `${String(sequence++).padStart(3, '0')}-${phase}-${value.name}-${kind}-${armName}-${iteration}`;
      const output = join(root, id);
      await mkdir(output, { mode: 0o700 });
      const request = { run, leaf: id, phase, value, kind, arm: armName };
      const requestPath = join(output, 'request.json');
      await save(requestPath, request);
      const record = { id, phase, case: value.name, kind, arm: armName, iteration, state: 'started', output };
      report.leaves.push(record);
      report.phase = phase;
      await persist();
      record.gate_path = join(root, id + '-gate.json');
      try {
        const result = await gate.observe(request, () => capture({ arm, configPath: paths.config, requestPath, output, home: privateDir }));
        const expected = value.expected[kind];
        assert.deepEqual(result.reply.counts, { total: expected.total, unindexed: expected.unindexed });
        assert.equal(result.reply.counts.total > value.limit, expected.exhausted_at_limit64);
        if (phase === 'check') assert.deepEqual(result.reply.eligible_uids, expected.eligible_uids);
        else {
          const workload = result.reply.queries.find(row => row.role === 'workload');
          assert.ok(workload?.operators.length > 0 && Number.isFinite(workload.db_hits), 'PROFILE proof unavailable');
        }
        record.state = 'passed';
        record.close = result.close;
        record.queries = result.reply.queries;
        record.gate_queries = result.gate_queries;
      } catch (error) { record.state = 'failed'; record.failure = errorData(error); throw error; }
      finally { await persist(); }
    }
    for (const value of fixture.cases) for (const kind of ['chunk', 'record']) {
      for (const armName of ['before', 'after']) await leaf('check', value, kind, armName, 0);
    }
    const profileCase = fixture.cases.find(value => value.name === '16-threshold-65');
    assert.ok(profileCase);
    report.profile_case = profileCase.name;
    for (let iteration = 0; iteration < 20; iteration += 1) for (const kind of ['chunk', 'record']) {
      for (const armName of iteration % 2 ? ['after', 'before'] : ['before', 'after']) await leaf('profile', profileCase, kind, armName, iteration);
    }
    assert.equal(report.leaves.length, 144);
    const quantiles = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
    };
    report.profile_summary = [];
    for (const armName of ['before', 'after']) for (const kind of ['chunk', 'record']) {
      const rows = report.leaves.filter(row => row.phase === 'profile' && row.arm === armName && row.kind === kind);
      const workload = rows.map(row => row.queries.find(item => item.role === 'workload'));
      report.profile_summary.push({ arm: armName, kind, case: profileCase.name, quantile_method: 'nearest_rank',
        workload_wall_ms: quantiles(workload.map(row => row.wall_ms)),
        workload_db_hits: quantiles(workload.map(row => row.db_hits)),
        self_id_wall_ms: quantiles(rows.map(row => row.queries.find(item => item.role === 'self_id').wall_ms)),
        post_gate_wall_ms: quantiles(rows.map(row => row.gate_queries.find(item => item.role === 'post_close_gate').wall_ms)),
        self_id_and_gate_db_hits: null, catalog_db_hits_absence: 'not_profiled_no_counters_returned_not_zero',
        scope: 'Each role is separate; these quantiles are not production latency or additive phase budgets' });
    }
    await gate.close();
    gate = null;
    report.observer_closed = true;
    store = new Neo4jStore(config);
    assert.deepEqual(await fingerprint(), frozen, 'fixture or schema changed during read-only experiment');
    assert.deepEqual(await pin(before.root), before);
    assert.deepEqual(await pin(after.root), after);
    assert.equal(hash(await readFile(script)), freeze.harness_sha256);
    assert.equal(hash(await readFile(fixturePath)), FIXTURE_HASH);
    report.classification = 'all_predeclared_membership_counts_and_profile_samples_completed';
  } catch (error) { report.failure = errorData(error); process.exitCode = 1; }
  finally {
    try { await store?.close(); } catch (error) { report.setup_close_unknown = errorData(error); process.exitCode = 1; }
    try { await gate?.close(); report.observer_closed = true; }
    catch (error) { observerCloseUnknown = true; report.observer_close_unknown = errorData(error); process.exitCode = 1; }
    try {
      const owned = attemptedCreate ? await inspect(method.id ?? name) : null;
      if (owned) {
        assert.equal(owned.Config?.Labels?.['source-memory.census-owner'], run);
        method.id ??= owned.Id;
        await persist();
        await docker('stop', '--time', '10', method.id);
        const stopped = await inspect(method.id);
        if (stopped) { assert.equal(stopped.State.Running, false); await docker('rm', '--volumes', method.id); }
        assert.equal(await inspect(method.id), null);
      }
      report.container_closed = true;
    } catch (error) { report.cleanup_unknown = errorData(error); process.exitCode = 1; }
    await persist();
    console.log(`CENSUS_REPORT ${paths.report}`);
    console.log(`CENSUS_CLOSURE ${JSON.stringify({ id: method.id, closed: report.container_closed, unknown: report.cleanup_unknown ?? null })}`);
    while (!report.container_closed || observerCloseUnknown || report.setup_close_unknown) {
      await sleep(1000);
      try {
        if (!report.container_closed && await inspect(method.id ?? name) === null) {
          report.container_closed = true;
          report.closure_after_external_recovery = true;
          await persist();
        }
      } catch (error) { report.last_closure_check = errorData(error); await persist(); }
    }
    report.finished_at = new Date().toISOString();
    await persist();
  }
}

const args = options(process.argv.slice(2));
if (args['--worker']) await worker(args);
else await controller(args);
