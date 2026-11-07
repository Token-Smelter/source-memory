import { createHash } from 'node:crypto';
import { constants, closeSync, fsyncSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { METERED_RUNTIME } from './pi-wrapper.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const validUnits = usage => ['input', 'cacheRead', 'cacheWrite', 'output'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)
  && usage.input + usage.cacheRead + usage.cacheWrite > 0;

/** API-equivalent soft estimates, not a provider charge or a bound on gateway-internal attempts. */
export function createSoftBudget({ path, capNano, routes, sessionKey, sealSha256, onRaw = () => {} }) {
  if (!isAbsolute(path ?? '') || !/^[1-9]\d*$/.test(capNano ?? '') || typeof sessionKey !== 'string' || !sessionKey
    || !/^[a-f0-9]{64}$/.test(sealSha256 ?? '') || !routes || typeof routes !== 'object' || typeof onRaw !== 'function') throw fail('soft_budget_invalid');
  routes = JSON.parse(JSON.stringify(routes));
  const parent = realpathSync(dirname(path));
  const state = statSync(parent);
  if (!state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o077) !== 0) throw fail('work_dir_invalid');
  for (const [route, config] of Object.entries(routes)) {
    if (!route || !Number.isSafeInteger(config?.maxOutputTokens) || config.maxOutputTokens < 1
      || !['input', 'cacheRead', 'cacheWrite', 'output'].every(key => Number.isSafeInteger(config.ratesNanoPerToken?.[key]) && config.ratesNanoPerToken[key] >= 0)
      || typeof config.rateEvidence !== 'string' || !config.rateEvidence.trim()) throw fail('soft_budget_invalid');
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_APPEND, 0o600);
  const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  let spent = 0n, active = null, stopped = null, count = 0, closed = false;
  const totals = new Map();
  function record(row) {
    if (closed) throw fail('soft_budget_closed');
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    try {
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } catch { stopped = 'ledger_write_unknown'; throw fail('ledger_write_unknown'); }
  }
  record({ type: 'open', version: 'soft-sdk-ledger/v1', cap_nano: capNano, seal_sha256: sealSha256, session_key: sessionKey,
    ledger_completeness: 'partial: gateway-internal failover/retry attempts not correlatable',
    estimate_basis: 'measured UTF-8 JSON context bytes treated as token estimate plus configured maximum output; maximum published SDK rate tier', routes });
  const api = {
    wrap(runtime, metadata) {
      if (typeof runtime?.streamSimple !== 'function' || typeof metadata !== 'function') throw fail('soft_runtime_invalid');
      return new Proxy(runtime, {
        get(target, key) {
          if (key === METERED_RUNTIME) return true;
          if (['stream', 'complete', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'cancelDeferred'].includes(key)) return () => { throw fail('unmetered_api_refused'); };
          if (key !== 'streamSimple') {
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (model, context, options = {}) => {
            if (stopped) throw fail(stopped);
            if (active) throw fail('model_call_in_flight');
            const route = `${model?.provider}/${model?.id}`;
            const config = routes[route];
            if (!config) throw fail('route_unsealed');
            const output = options.maxTokens ?? config.maxOutputTokens;
            if (!Number.isSafeInteger(output) || output < 1 || output > config.maxOutputTokens) throw fail('output_limit_invalid');
            const payload = JSON.stringify(context);
            if (typeof payload !== 'string') throw fail('context_invalid');
            const measuredBytes = Buffer.byteLength(payload);
            const rate = config.ratesNanoPerToken;
            const inputRate = Math.max(rate.input, rate.cacheRead, rate.cacheWrite);
            const estimate = BigInt(measuredBytes) * BigInt(inputRate) + BigInt(output) * BigInt(rate.output);
            if (spent + estimate > BigInt(capNano)) { stopped = 'soft_cap_exhausted'; throw fail(stopped); }
            const meta = metadata();
            if (!meta || typeof meta.purpose !== 'string' || !meta.purpose || typeof meta.arm !== 'string' || !meta.arm
              || typeof meta.checkpoint !== 'string' || !meta.checkpoint || typeof meta.task_version !== 'string' || !meta.task_version
              || typeof meta.policy_version !== 'string' || !meta.policy_version) throw fail('call_metadata_invalid');
            const id = ++count;
            active = { id, estimate, route };
            record({ ...meta, type: 'started', id, requested_route: route, session_key: sessionKey, seal_sha256: sealSha256,
              context_sha256: sha(payload), measured_context_bytes: measuredBytes, estimated_input_tokens: measuredBytes,
              max_output_tokens: output, estimated_nano: estimate.toString(), rate_evidence: config.rateEvidence,
              cache_markers: 'not_exposed', cache_ttl: 'unknown', at: new Date().toISOString() });
            const started = Date.now();
            try {
              const stream = target.streamSimple(model, context, { ...options, maxTokens: output, maxRetries: 0 });
              if (!stream || typeof stream.result !== 'function' || typeof stream[Symbol.asyncIterator] !== 'function') throw fail('pi_stream_invalid');
              const recorded = Promise.resolve(stream.result()).then(message => {
                let captureFailed = false;
                try { onRaw({ id, ...meta, message: structuredClone(message) }); } catch { captureFailed = true; }
                const usage = message?.usage;
                const actualRoute = typeof message?.provider === 'string' && typeof message?.model === 'string' ? `${message.provider}/${message.model}` : null;
                const known = validUnits(usage) && ['stop', 'length', 'toolUse'].includes(message?.stopReason) && actualRoute === route;
                let actual = null;
                if (known) {
                  actual = BigInt(usage.input) * BigInt(rate.input) + BigInt(usage.cacheRead) * BigInt(rate.cacheRead)
                    + BigInt(usage.cacheWrite) * BigInt(rate.cacheWrite) + BigInt(usage.output) * BigInt(rate.output);
                  spent += actual;
                  const total = totals.get(route) ?? { input: 0, cache_read: 0, cache_write: 0, output: 0, api_equivalent_nano: 0n, calls: 0 };
                  total.input += usage.input; total.cache_read += usage.cacheRead; total.cache_write += usage.cacheWrite;
                  total.output += usage.output; total.api_equivalent_nano += actual; total.calls++;
                  totals.set(route, total);
                  if (actual > estimate * 2n) stopped = 'over_twice_estimate';
                  else if (spent >= BigInt(capNano)) stopped = 'soft_cap_exhausted';
                } else stopped = 'usage_or_outcome_unknown';
                if (captureFailed && !stopped) stopped = 'raw_output_capture_failed';
                record({ type: 'result', id, outcome: known ? 'received' : 'unknown', actual_route: actualRoute,
                  stop_reason: message?.stopReason ?? null, actual_reasoning: message?.providerThinkingLevel ?? null,
                  usage: known ? { input: usage.input, cache_read: usage.cacheRead,
                    cache_write: usage.cacheWrite, cache_write_1h: Number.isSafeInteger(usage.cacheWrite1h) ? usage.cacheWrite1h : null,
                    output: usage.output, inclusion: 'Pi Anthropic input excludes cache classes' } : null,
                  usage_provenance: known ? 'sdk_reported_provider_usage' : 'unknown', provider_charge: null,
                  sdk_cost_estimate: typeof usage?.cost?.total === 'number' && Number.isFinite(usage.cost.total) ? usage.cost.total : null,
                  api_equivalent_nano: actual?.toString() ?? null, latency_ms: Date.now() - started, stop: stopped, at: new Date().toISOString() });
                active = null;
                if (stopped) throw fail(stopped);
                return message;
              }, error => {
                stopped = 'usage_or_outcome_unknown';
                record({ type: 'result', id, outcome: 'unknown', usage: null, provider_charge: null,
                  latency_ms: Date.now() - started, stop: stopped, at: new Date().toISOString() });
                active = null;
                throw error;
              });
              recorded.catch(() => {});
              return new Proxy(stream, { get(target, key) {
                if (key === 'result') return () => recorded;
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              } });
            } catch (error) {
              const prevented = error?.dispatch_prevented === true && ['input_budget_exhausted', 'input_budget_unknown'].includes(error.code);
              stopped = prevented ? error.code : 'dispatch_unknown';
              record({ type: 'result', id, outcome: prevented ? 'not_sent' : 'unknown', usage: null, provider_charge: null,
                ...(prevented ? { reason: error.code, provenance: 'bound-runtime-pre-dispatch' } : {}), stop: stopped, at: new Date().toISOString() });
              active = null;
              throw error;
            }
          };
        },
      });
    },
    state: () => ({ spent_nano: spent.toString(), cap_nano: capNano, in_flight: Boolean(active), stopped, calls_started: count,
      by_model: Object.fromEntries([...totals].map(([route, total]) => [route, { ...total, api_equivalent_nano: total.api_equivalent_nano.toString() }])) }),
    close() {
      if (active) throw fail('model_call_in_flight');
      if (!closed) { record({ type: 'close', ...api.state(), at: new Date().toISOString() }); closed = true; closeSync(fd); }
    },
  };
  return api;
}
