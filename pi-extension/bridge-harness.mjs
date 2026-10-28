import { performance } from 'node:perf_hooks';
import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { replay } from './replay.mjs';

const fail = code => Object.assign(new Error(code), { code });

async function within(action, ms) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([action(controller.signal), new Promise((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail('recall_timeout')); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Probe only explicitly supplied, syntactically valid gateway and pilot IPs. */
export async function verifyPilotIsolation({ gateway, pilotIps, connect }) {
  if (!isIP(gateway) || !Array.isArray(pilotIps) || !pilotIps.length || pilotIps.some(ip => !isIP(ip)) || typeof connect !== 'function') throw fail('isolation_targets_invalid');
  const targets = [...new Set(['127.0.0.1', gateway, ...pilotIps])];
  const results = [];
  for (const host of targets) {
    const outcome = await connect(host, 27690);
    if (!['connected', 'timeout', 'error'].includes(outcome)) throw fail('isolation_unknown');
    results.push({ host, port: 27690, outcome });
  }
  return { ok: results.every(row => row.outcome !== 'connected'), targets: results };
}

/** Bounded relay protocol; the caller owns binding a server to the admitted bridge gateway. */
export function createEmbeddingHandler({ fetchFn = fetch, timeoutMs = 10000, maxBytes = 256000 } = {}) {
  let busy = false;
  return async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(body); };
    if (request.method !== 'POST' || request.url !== '/v1/embeddings') return send(404, '{"error":"not_found"}');
    if (busy) return send(429, '{"error":"busy"}');
    busy = true;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > maxBytes) throw fail('request_too_large');
        chunks.push(data);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['model', 'input'].includes(key))
        || typeof body.model !== 'string' || !Array.isArray(body.input) || body.input.some(item => typeof item !== 'string')) throw fail('request_invalid');
      const result = await fetchFn('http://127.0.0.1:11434/v1/embeddings', { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!result.ok || !result.body) throw fail('relay_unavailable');
      const output = [];
      let received = 0;
      for await (const part of result.body) {
        const data = Buffer.from(part);
        received += data.length;
        if (received > 8_000_000) throw fail('response_too_large');
        output.push(data);
      }
      return send(200, Buffer.concat(output).toString('utf8'));
    } catch { return send(502, '{"error":"relay_unavailable"}'); }
    finally { busy = false; }
  };
}

/** Bind only a caller-verified bridge gateway; wildcard and loopback addresses are refused. */
export async function openEmbeddingRelay({ gateway, port, serverFactory = createServer, fetchFn }) {
  if (isIP(gateway) !== 4 || gateway === '0.0.0.0' || gateway.startsWith('127.')
    || !Number.isInteger(port) || port < 1024 || port > 65535) throw fail('gateway_invalid');
  const server = serverFactory(createEmbeddingHandler({ fetchFn }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: gateway, port }, () => { server.removeListener('error', reject); resolve(); });
  });
  return { async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

/** Adapter-driven orchestration. Docker/relay effects must be supplied by the caller and independently admitted. */
export async function runHarness({ docker, relay, isolation, memory, memoryFactory, sessions, sessionFactory, cases,
  onTurn = async () => {}, onIsolation = async () => {}, maxTurns = 110, clock = () => performance.now() }) {
  let network, database, driver, listener, activeMemory = memory;
  let outcome = { status: 'failed' };
  let cleanupFailed = false;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 110) return { status: 'failed', code: 'turn_limit_invalid' };
  try {
    network = await docker.createNetwork({ internal: true });
    database = await docker.createDatabase({ network, publishedPorts: false });
    driver = await docker.createDriver({ network, database });
    listener = await relay.open({ network, database, driver, gateway: docker.gateway });
    const gate = await isolation({ network, database, driver });
    await onIsolation(gate);
    if (gate?.ok !== true || !Array.isArray(gate.targets) || gate.targets.length < 3
      || !gate.targets.some(row => row.host === '127.0.0.1' && row.port === 27690)
      || gate.targets.some(row => !isIP(row.host) || row.port !== 27690 || !['error', 'timeout'].includes(row.outcome))) {
      return outcome = { status: 'isolation_failed', isolation: gate };
    }
    if (typeof docker.waitReady === 'function') await docker.waitReady({ network, database, driver });
    if (!activeMemory && typeof memoryFactory === 'function') activeMemory = await memoryFactory({ network, database, driver, gateway: docker.gateway });
    if (!sessions && typeof sessionFactory === 'function') sessions = await sessionFactory(activeMemory);
    if (!activeMemory || !Array.isArray(sessions) || !sessions.length || !Array.isArray(cases) || !cases.length) throw fail('input_invalid');
    await activeMemory.init();
    const replayed = [];
    let processed = 0;
    for (const item of sessions) {
      if (processed >= maxTurns) return outcome = { status: 'turn_limit', replayed };
      const result = await replay(item.session, item.leaves, item.cursor ?? null, { maxTurns: maxTurns - processed,
        onTurn: turn => onTurn(turn, { session: item.session.conversation_id }) });
      replayed.push(result);
      processed += result.results.length;
      if (result.status !== 'complete') return outcome = { status: result.status, replayed };
    }
    const results = [];
    for (const item of cases) {
      const start = clock();
      const result = await within(signal => activeMemory.recall(item.scope ?? sessions[0]?.session.scopes[0], { query: item.query,
        exclude_conversations: [{ source: 'pi-memory', conversation_id: item.asker_conversation_id }] }, { signal }), 15000);
      results.push({ id: item.id, evidence_not_ingestable: item.evidence_not_ingestable === true, elapsed_ms: clock() - start, result });
    }
    outcome = { status: 'complete', replayed, cases: results };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'harness_failed';
    outcome = { status: ['creation_unknown', 'cleanup_unknown'].includes(code) ? 'cleanup_unknown' : 'failed', code };
    if (outcome.status === 'cleanup_unknown') cleanupFailed = true;
  }
  finally {
    try { if (activeMemory?.close && await activeMemory.close() !== 'closed') cleanupFailed = true; } catch { cleanupFailed = true; }
    try { await listener?.close(); } catch { cleanupFailed = true; }
    for (const id of [driver, database].filter(Boolean)) try { await docker.removeContainer(id); } catch { cleanupFailed = true; }
    if (network) try { await docker.removeNetwork(network); } catch { cleanupFailed = true; }
    if (cleanupFailed) outcome.status = 'cleanup_unknown';
  }
  return outcome;
}
