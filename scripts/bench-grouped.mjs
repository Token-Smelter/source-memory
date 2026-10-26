import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, realpath, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runIntegration } from '../test/integration.mjs';
import { BASELINE, PRIMARY_SCOPE, FOREIGN_SCOPE, MODEL, groupedFixture, fixtureVector } from '../test/fixtures/bench-grouped/fixture.mjs';

const exec = promisify(execFile);
const IMAGE = 'neo4j:5.26.14-community';
const STDOUT_LIMIT = 2065536;
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = value => JSON.stringify(value, null, 2);
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value;
const errorData = error => ({ code: error.code ?? null, message: String(error.message).slice(0, 1000) });

function options(argv) {
  assert.equal(argv.length % 2, 0, 'arguments must be --name value pairs');
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    assert.ok(['--before', '--after', '--repetitions', '--report-dir', '--profile-worker', '--integration-worker', '--config', '--request', '--query-log', '--results', '--scratch'].includes(key), key);
    assert.equal(Object.hasOwn(values, key), false, `duplicate argument ${key}`);
    values[key] = argv[index + 1];
  }
  return values;
}

async function save(path, value) {
  await writeFile(path, json(value) + '\n', { mode: 0o600 });
}

async function git(root, ...args) {
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args])).stdout.trim();
}

async function arm(root) {
  root = resolve(root);
  assert.equal(await git(root, 'status', '--porcelain'), '', `dirty source: ${root}`);
  const head = await git(root, 'rev-parse', 'HEAD');
  const tree = await git(root, 'rev-parse', 'HEAD^{tree}');
  const lockBytes = await readFile(join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const dependencies = [];
  for (const [path, declared] of Object.entries(lock.packages)) {
    if (!path) continue;
    const manifestBytes = await readFile(join(root, path, 'package.json'));
    const installed = JSON.parse(manifestBytes);
    assert.equal(installed.version, declared.version, `dependency mismatch: ${root}/${path}`);
    dependencies.push({ path, real_path: await realpath(join(root, path)), name: installed.name, version: installed.version, manifest_sha256: hash(manifestBytes),
      declared_integrity: declared.integrity ?? null });
  }
  const fixedSources = {};
  for (const path of ['src/core.mjs', 'src/models.mjs', 'src/envelope.mjs', 'bin/memory.mjs', 'package.json']) {
    fixedSources[path] = hash(await readFile(join(root, path)));
  }
  return { root, head, tree, lock_sha256: hash(lockBytes), dependencies, fixed_sources: fixedSources };
}

async function modules(root) {
  const { Memory } = await import(pathToFileURL(join(root, 'src/memory.mjs')).href);
  const { Neo4jStore } = await import(pathToFileURL(join(root, 'src/store.mjs')).href);
  const core = await import(pathToFileURL(join(root, 'src/core.mjs')).href);
  return { Memory, Neo4jStore, ...core };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

function profileOperators(plan) {
  if (!plan) return [];
  return [{ operator: plan.operatorType, db_hits: number(plan.dbHits), rows: number(plan.rows),
    server_time_raw: number(plan.time), arguments: plan.arguments }, ...plan.children.flatMap(profileOperators)];
}

async function profileWorker(args) {
  const root = resolve(args['--profile-worker']);
  const config = JSON.parse(await readFile(args['--config'], 'utf8'));
  const request = JSON.parse(await readFile(args['--request'], 'utf8'));
  const { Memory, Neo4jStore } = await modules(root);
  const store = new Neo4jStore(config.neo4j);
  const transaction = store.transaction.bind(store);
  let sequence = 0;
  store.transaction = (mode, action) => {
    assert.equal(mode, 'read', 'profile recall must be read-only');
    return transaction(mode, tx => action(new Proxy(tx, { get(target, key) {
      if (key !== 'run') { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; }
      return async (query, params = {}) => {
        const id = sequence++;
        const supported = !/^\s*SHOW\b/i.test(query);
        const started = performance.now();
        try {
          const result = await target.run(supported ? `PROFILE ${query}` : query, params);
          const operators = profileOperators(result.summary?.profile);
          const hits = operators.map(row => row.db_hits);
          await appendFile(args['--query-log'], JSON.stringify({ id, cypher: query, cypher_sha256: hash(query),
            parameters_sha256: hash(JSON.stringify(canonical(params))), wall_ms: performance.now() - started,
            result_available_after_ms: number(result.summary?.resultAvailableAfter) ?? null,
            result_consumed_after_ms: number(result.summary?.resultConsumedAfter) ?? null,
            profile: supported ? operators.length ? 'available' : 'unavailable' : 'not_supported_catalog',
            db_hits: operators.length && hits.every(Number.isFinite) ? hits.reduce((sum, value) => sum + value, 0) : null,
            operators, rows: result.records.length }) + '\n', { mode: 0o600 });
          return result;
        } catch (error) {
          await appendFile(args['--query-log'], JSON.stringify({ id, cypher: query, cypher_sha256: hash(query),
            parameters_sha256: hash(JSON.stringify(canonical(params))), wall_ms: performance.now() - started, failure: errorData(error) }) + '\n', { mode: 0o600 });
          throw error;
        }
      };
    } })));
  };
  const memory = new Memory(config, store);
  try {
    const reply = await memory.recall(request.scope, request.input);
    const { serializePoolReply } = await import(pathToFileURL(join(root, 'src/envelope.mjs')).href);
    process.stdout.write(serializePoolReply({ ok: true, ...reply }, request.input.max_chars));
  } finally { await memory.close(); }
}

async function integrationWorker(args) {
  const database = JSON.parse(await readFile(args['--config'], 'utf8'));
  const result = { checks: null, failure: null, real_embedding_disabled: !process.env.SOURCE_MEMORY_REAL_EMBEDDING_URL };
  try {
    assert.equal(result.real_embedding_disabled, true, 'real embedding integration is forbidden');
    result.checks = await runIntegration(database, args['--scratch']);
  } catch (error) { result.failure = errorData(error); process.exitCode = 1; }
  finally { await save(args['--results'], result); }
}

async function child(args, cwd, home) {
  const started = performance.now();
  const processHandle = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: home, TMPDIR: home, LANG: 'C.UTF-8', PATH: process.env.PATH } });
  const output = [];
  const errors = [];
  let bytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let startError = null;
  processHandle.on('error', error => { startError = errorData(error); });
  processHandle.stdout.on('data', part => { bytes += part.length; if (bytes <= STDOUT_LIMIT) output.push(part); else overflow = true; });
  processHandle.stderr.on('data', part => { stderrBytes += part.length; if (stderrBytes <= 8192) errors.push(part); });
  const [code, signal] = await once(processHandle, 'close');
  return { pid: processHandle.pid, code, signal, closed: true, elapsed_ms: performance.now() - started,
    stdout_bytes: bytes, overflow, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'),
    stderr_truncated: stderrBytes > 8192, start_error: startError };
}

function percentile(samples, value) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
}

async function controller(args) {
  const before = await arm(args['--before']);
  const after = await arm(args['--after']);
  assert.equal(before.head, BASELINE, 'baseline must remain pinned');
  assert.equal(before.lock_sha256, after.lock_sha256, 'lockfiles differ');
  assert.deepEqual(before.dependencies, after.dependencies, 'installed dependency manifests differ');
  assert.deepEqual(before.fixed_sources, after.fixed_sources, 'non-optimization source conditions differ');
  const repetitions = Number(args['--repetitions'] ?? 20);
  assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 20, 'at least20 repetitions per query per arm are required');
  const runId = randomUUID();
  assert.ok(args['--report-dir'], 'an explicit private report root is required');
  const reportDir = resolve(args['--report-dir']);
  await mkdir(dirname(reportDir), { recursive: true, mode: 0o700 });
  await mkdir(reportDir, { mode: 0o700 });
  const scratch = join(reportDir, 'private');
  await mkdir(scratch, { mode: 0o700 });
  const paths = { scratch, report_dir: reportDir, config: join(scratch, 'recall-config.json'), fixture: join(reportDir, 'fixture.json'),
    method: join(reportDir, 'method.json'), report: join(reportDir, 'report.json'), proceed: join(scratch, 'container-record-relayed.json'),
    integration_config: join(scratch, 'integration-database.json'), integration_report: join(reportDir, 'integration.json') };
  const name = `source-memory-grouped-${runId}`;
  const method = { kind: 'existing-project-docker-method', owner_pid: process.pid, run_id: runId, name, id: null, paths,
    requested: { image: IMAGE, binding: '127.0.0.1::7687', auth: 'none', memory_bytes: 2048 * 1024 * 1024, cpus: 2,
      heap_initial: '512m', heap_max: '512m', pagecache: '128m', live_mounts: false },
    stop: 'docker stop --time 10 <exact recorded id>', remove: 'docker rm --volumes <exact recorded id>',
    closure: 'docker inspect <exact recorded id> must report no such object', execution_kind: 'direct product diagnostic; not Work Core or B1b qualification' };
  const report = { started_at: new Date().toISOString(), before, after, repetitions, paths, method, integration: null, conditions: {},
    quantiles: 'nearest-rank p50 and p95; no failed samples silently removed', warmups_per_query_per_arm: 2,
    profile_time_units: 'driver available/consumed and wall times are ms; operator server_time_raw is retained without inventing a unit',
    trials: [], comparisons: [], failure: null, container_closed: false, semantic_match: false };
  const persist = async () => { await save(paths.method, method); await save(paths.report, report); };
  const docker = async (...argv) => (await exec('docker', argv)).stdout.trim();
  const inspect = async target => {
    try { return JSON.parse(await docker('inspect', target))[0]; }
    catch (error) { if (/No such (object|container)/i.test(String(error.stderr))) return null; throw error; }
  };
  let attemptedCreate = false;
  let model;
  let writer;
  await persist();
  console.log(`GROUPED_METHOD ${JSON.stringify(method)}`);
  try {
    attemptedCreate = true;
    await docker('run', '--detach', '--name', name, '--label', `source-memory.grouped-owner=${runId}`,
      '--publish', '127.0.0.1::7687', '--memory', '2048m', '--cpus', '2', '--env', 'NEO4J_AUTH=none',
      '--env', 'NEO4J_server_memory_heap_initial__size=512m', '--env', 'NEO4J_server_memory_heap_max__size=512m',
      '--env', 'NEO4J_server_memory_pagecache_size=128m', IMAGE);
    const owned = await inspect(name);
    assert.equal(owned?.Config?.Labels?.['source-memory.grouped-owner'], runId, 'container ownership label mismatch');
    method.id = owned.Id;
    await persist();
    console.log(`GROUPED_CONTAINER_CREATED ${JSON.stringify({ name, id: method.id, paths })}`);
    assert.equal(owned.Config.Image, IMAGE);
    const [binding] = owned.NetworkSettings.Ports['7687/tcp'] ?? [];
    assert.equal(owned.NetworkSettings.Ports['7687/tcp'].length, 1);
    assert.equal(binding.HostIp, '127.0.0.1');
    assert.notEqual(Number(binding.HostPort), 27690, 'pilot port is forbidden');
    assert.ok(Number(binding.HostPort) > 0);
    const env = Object.fromEntries(owned.Config.Env.map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)]; }));
    assert.equal(env.NEO4J_AUTH, 'none');
    assert.equal(owned.HostConfig.Memory, method.requested.memory_bytes);
    assert.equal(owned.HostConfig.NanoCpus, 2e9);
    assert.equal(env.NEO4J_server_memory_heap_initial__size, '512m');
    assert.equal(env.NEO4J_server_memory_heap_max__size, '512m');
    assert.equal(env.NEO4J_server_memory_pagecache_size, '128m');
    assert.ok(owned.Mounts.every(mount => mount.Type === 'volume'), 'live bind mounts are forbidden');
    const image = JSON.parse(await docker('image', 'inspect', owned.Image))[0];
    method.actual = { image: owned.Config.Image, image_id: owned.Image, image_digests: image.RepoDigests ?? [],
      binding: `${binding.HostIp}:${binding.HostPort}`, auth: 'none', memory_bytes: owned.HostConfig.Memory, cpus: owned.HostConfig.NanoCpus / 1e9,
      heap_initial: env.NEO4J_server_memory_heap_initial__size, heap_max: env.NEO4J_server_memory_heap_max__size,
      pagecache: env.NEO4J_server_memory_pagecache_size,
      volumes: owned.Mounts.map(mount => ({ name: mount.Name, source: mount.Source, destination: mount.Destination })) };
    await persist();
    console.log(`GROUPED_ENV ${JSON.stringify(method.actual)}`);
    console.log(`GROUPED_WAITING_FOR_RECORD_RELAY ${paths.proceed}`);
    // The actual identity record must be relayed before this one workload starts seeding or querying its database.
    while (true) {
      let released;
      try { released = JSON.parse(await readFile(paths.proceed, 'utf8')); } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (released) {
        assert.equal(released.run_id, runId);
        assert.equal(released.container_id, method.id);
        break;
      }
      await sleep(100);
    }
    const uri = `bolt://${method.actual.binding}`;
    const base = await modules(before.root);
    writer = new base.Memory({ neo4j: { uri, auth: 'none' }, scopes: { read: [], write: [] } });
    const readyDeadline = Date.now() + 90000;
    while (true) {
      try { await writer.store.transaction('read', tx => tx.run('RETURN 1 AS ready')); break; }
      catch (error) { if (Date.now() >= readyDeadline) throw error; await sleep(1000); }
    }
    const integrationConfig = paths.integration_config;
    const integrationResult = paths.integration_report;
    await save(integrationConfig, { uri, auth: 'none', database: 'neo4j' });
    const integration = await child([resolve(process.argv[1]), '--integration-worker', after.root,
      '--config', integrationConfig, '--scratch', scratch, '--results', integrationResult], after.root, scratch);
    await writeFile(join(reportDir, 'integration.stdout.txt'), integration.stdout, { mode: 0o600 });
    report.integration_worker = { ...integration, stdout: undefined };
    await persist();
    assert.equal(integration.code, 0, 'existing fictional integration failed; no retry');
    assert.equal(integration.signal, null);
    assert.equal(integration.overflow, false);
    report.integration = JSON.parse(await readFile(integrationResult, 'utf8'));
    assert.equal(report.integration.failure, null);
    // Only this newly created, label-verified, disposable database is cleared between its integration and benchmark phases.
    const constraints = await writer.store.transaction('read', tx => tx.run('SHOW CONSTRAINTS YIELD name RETURN name'));
    const quote = name => '`' + name.replaceAll('`', '``') + '`';
    for (const row of constraints.records) await writer.store.transaction('write', tx => tx.run(`DROP CONSTRAINT ${quote(row.get('name'))}`));
    const indexes = await writer.store.transaction('read', tx => tx.run('SHOW INDEXES YIELD name,type RETURN name,type'));
    for (const row of indexes.records.filter(row => row.get('type') !== 'LOOKUP')) {
      await writer.store.transaction('write', tx => tx.run(`DROP INDEX ${quote(row.get('name'))}`));
    }
    await writer.store.transaction('write', tx => tx.run('MATCH (n) DETACH DELETE n'));
    const empty = await writer.store.transaction('read', tx => tx.run('MATCH (n) RETURN count(n) AS count'));
    assert.equal(number(empty.records[0].get('count')), 0, 'integration data remains');
    report.conditions.integration_reset = { nodes: 0, only_lookup_indexes_retained: true };
    await persist();
    model = createServer(async (req, res) => {
      try {
        let body = '';
        for await (const part of req) body += part;
        const input = JSON.parse(body);
        assert.equal(input.model, MODEL);
        assert.ok(Array.isArray(input.input));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: MODEL,
          data: input.input.map((value, index) => ({ index, embedding: fixtureVector(value) })) }));
      } catch { res.writeHead(500).end(JSON.stringify({ error: 'fictional_model_fixture_failed' })); }
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const fixture = groupedFixture();
    assert.ok(fixture.turns.length >= 400);
    await save(paths.fixture, fixture);
    const config = { neo4j: { uri, auth: 'none' }, scopes: { read: [PRIMARY_SCOPE], write: [] }, index_on_write: false,
      embedding: { url: `http://127.0.0.1:${model.address().port}/embed`, model: MODEL, dimensions: fixture.vector_definition.dimensions },
      chunking: fixture.chunking };
    await save(paths.config, config);
    await writer.close();
    writer = new base.Memory({ ...config, scopes: { read: [PRIMARY_SCOPE, FOREIGN_SCOPE], write: [PRIMARY_SCOPE, FOREIGN_SCOPE] } });
    for (const scope of [PRIMARY_SCOPE, FOREIGN_SCOPE]) await writer.init(scope);
    for (const row of fixture.turns) {
      const stored = await writer.ingest(row.scope, row.turn);
      assert.equal(stored.id, row.uid);
    }
    for (const scope of [PRIMARY_SCOPE, FOREIGN_SCOPE]) {
      const rows = fixture.records.filter(row => row.scope === scope).map(row => row.record);
      for (let index = 0; index < rows.length; index += 120) await writer.enrich(scope, { records: rows.slice(index, index + 120), relations: [] });
      const edges = fixture.relations.filter(row => row.scope === scope).map(row => row.relation);
      for (let index = 0; index < edges.length; index += 240) await writer.enrich(scope, { records: [], relations: edges.slice(index, index + 240) });
      while (true) {
        const result = await writer.index(scope, { limit: 2048 });
        if (result.status === 'ready') break;
        assert.equal(result.status, 'pending', 'fictional embedding setup failed');
      }
    }
    await writer.store.transaction('write', tx => tx.run(`UNWIND $ids AS uid MATCH (t:SMTurn {uid:uid,scope:$scope})
      REMOVE t.source,t.conversation_id,t.turn_key,t.parent_turn_id,t.lineage,t.lineage_root`, { ids: fixture.legacyTurns, scope: PRIMARY_SCOPE }));
    const indexDeadline = Date.now() + 180000;
    while (true) {
      const states = await Promise.all([PRIMARY_SCOPE, FOREIGN_SCOPE].map(scope => writer.status(scope)));
      if (states.every(state => Object.values(state.vector_indexes).every(value => value === 'online'))) break;
      if (Date.now() >= indexDeadline) throw new Error('fictional vector population deadline exceeded');
      await sleep(100);
    }
    const names = [PRIMARY_SCOPE, FOREIGN_SCOPE].flatMap(scope => Object.values(base.indexNames(scope)));
    const fingerprint = async () => {
      const graph = await writer.store.transaction('read', tx => tx.run('MATCH (n) RETURN labels(n) AS labels,properties(n) AS properties ORDER BY n.uid'));
      const catalog = await writer.store.transaction('read', tx => tx.run(`SHOW INDEXES YIELD name,type,state,labelsOrTypes,properties,options
        WHERE name IN $names RETURN name,type,state,labelsOrTypes,properties,options ORDER BY name`, { names }));
      const indexRows = catalog.records.map(row => row.toObject());
      assert.equal(indexRows.length, names.length);
      assert.ok(indexRows.every(row => row.state === 'ONLINE'));
      return { graph_sha256: hash(JSON.stringify(canonical(graph.records.map(row => row.toObject())))),
        index_sha256: hash(JSON.stringify(canonical(indexRows))), index_rows: indexRows,
        fixture_sha256: hash(await readFile(paths.fixture)), config_sha256: hash(await readFile(paths.config)),
        model: config.embedding, vector_definition: fixture.vector_definition, actual_container: method.actual };
    };
    const frozen = await fingerprint();
    report.conditions.frozen = frozen;
    await persist();
    const expected = new Map();
    const checked = new Set();
    const recordTrial = async (which, query, phase, index) => {
      if (!checked.has(which)) {
        assert.deepEqual(await fingerprint(), frozen, `fixture conditions changed before ${which}`);
        checked.add(which);
      }
      const entry = which === 'before' ? before : after;
      const prefix = `${query.id}-${phase}-${which}-${index}`;
      const requestPath = join(scratch, `${query.id}.json`);
      await save(requestPath, query);
      const queryLog = join(reportDir, `${prefix}.queries.jsonl`);
      const argv = phase === 'profile' ? [resolve(process.argv[1]), '--profile-worker', entry.root, '--config', paths.config,
        '--request', requestPath, '--query-log', queryLog]
        : [join(entry.root, 'bin/memory.mjs'), 'recall', '--config', paths.config, '--scope', query.scope, '--input', requestPath];
      if (phase !== 'profile') await save(requestPath, query.input);
      const result = await child(argv, entry.root, scratch);
      const outputPath = join(reportDir, `${prefix}.stdout.json`);
      await writeFile(outputPath, result.stdout, { mode: 0o600 });
      const metadata = { ...result, stdout: undefined, arm: which, case: query.id, phase, iteration: index, output: outputPath,
        output_sha256: hash(result.stdout), ...(phase === 'profile' ? { queries: queryLog } : {}) };
      report.trials.push(metadata);
      await persist();
      assert.equal(result.code, 0, `${prefix} failed: ${result.stderr}`);
      assert.equal(result.signal, null);
      assert.equal(result.overflow, false);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      if (!expected.has(query.id)) expected.set(query.id, result.stdout);
      assert.equal(result.stdout, expected.get(query.id), `${prefix} semantic output changed; evidence retained`);
      report.comparisons.push({ case: query.id, arm: which, phase, iteration: index, equal: true });
    };
    for (const query of fixture.queries) {
      for (let index = 0; index < 2; index += 1) for (const which of ['before', 'after']) await recordTrial(which, query, 'warmup', index);
      for (let index = 0; index < repetitions; index += 1) {
        for (const which of index % 2 ? ['after', 'before'] : ['before', 'after']) await recordTrial(which, query, 'latency', index);
      }
    }
    assert.deepEqual(await fingerprint(), frozen, 'fixture conditions changed after latency arms');
    checked.clear();
    for (const query of fixture.queries) for (let index = 0; index < repetitions; index += 1) {
      for (const which of index % 2 ? ['after', 'before'] : ['before', 'after']) await recordTrial(which, query, 'profile', index);
    }
    assert.deepEqual(await fingerprint(), frozen, 'fixture conditions changed after profile arms');
    report.results = fixture.queries.map(query => ({ case: query.id, arms: Object.fromEntries(['before', 'after'].map(which => {
      const samples = report.trials.filter(row => row.case === query.id && row.arm === which && row.phase === 'latency').map(row => row.elapsed_ms);
      assert.equal(samples.length, repetitions);
      return [which, { n: samples.length, p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95), samples_ms: samples }];
    })) }));
    const profiles = new Map();
    for (const trial of report.trials.filter(row => row.phase === 'profile')) {
      const rows = (await readFile(trial.queries, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      for (const row of rows) {
        const key = JSON.stringify([trial.arm, trial.case, row.cypher_sha256]);
        if (!profiles.has(key)) profiles.set(key, { arm: trial.arm, case: trial.case, cypher: row.cypher,
          cypher_sha256: row.cypher_sha256, calls: 0, db_hits: [], wall_ms: [], available_after_ms: [], consumed_after_ms: [], profile_states: {} });
        const summary = profiles.get(key);
        summary.calls += 1;
        summary.db_hits.push(row.db_hits);
        summary.wall_ms.push(row.wall_ms);
        summary.available_after_ms.push(row.result_available_after_ms);
        summary.consumed_after_ms.push(row.result_consumed_after_ms);
        summary.profile_states[row.profile ?? 'failed'] = (summary.profile_states[row.profile ?? 'failed'] ?? 0) + 1;
      }
    }
    report.profile_queries = [...profiles.values()];
    report.semantic_match = true;
  } catch (error) {
    report.failure = errorData(error);
    process.exitCode = 1;
  } finally {
    try { await writer?.close(); } catch (error) { report.failure ??= errorData(error); process.exitCode = 1; }
    if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
    try {
      const owned = attemptedCreate ? await inspect(method.id ?? name) : null;
      if (owned) {
        assert.equal(owned.Config?.Labels?.['source-memory.grouped-owner'], runId, 'cleanup ownership mismatch');
        method.id ??= owned.Id;
        await persist();
        await docker('stop', '--time', '10', method.id);
        const stopped = await inspect(method.id);
        if (stopped) { assert.equal(stopped.State.Running, false); await docker('rm', '--volumes', method.id); }
        assert.equal(await inspect(method.id), null, 'owned container remains');
      }
      report.container_closed = true;
    } catch (error) {
      report.cleanup_unknown = errorData(error);
      process.exitCode = 1;
    }
    await persist();
    console.log(`GROUPED_REPORT ${paths.report}`);
    console.log(`GROUPED_CLOSURE ${JSON.stringify({ id: method.id, closed: report.container_closed, unknown: report.cleanup_unknown ?? null })}`);
    // UNKNOWN is not permission to abandon the owner. External recovery uses the exact recorded Docker controls.
    while (!report.container_closed) {
      await sleep(1000);
      try {
        if (await inspect(method.id ?? name) === null) {
          report.container_closed = true;
          report.closure_after_external_recovery = true;
          await persist();
          console.log(`GROUPED_CLOSURE ${JSON.stringify({ id: method.id, closed: true, after_external_recovery: true })}`);
        }
      } catch (error) { report.last_closure_check = errorData(error); await persist(); }
    }
    report.finished_at = new Date().toISOString();
    await persist();
  }
}

const args = options(process.argv.slice(2));
if (args['--profile-worker']) await profileWorker(args);
else if (args['--integration-worker']) await integrationWorker(args);
else await controller(args);
