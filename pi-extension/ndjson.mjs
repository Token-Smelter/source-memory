import { createInterface } from 'node:readline';

const error = code => Object.assign(new Error(code), { code });
const MAX_LINE = 4_000_000;

function write(output, value) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_LINE) throw error('message_too_large');
  output.write(`${line}\n`);
}

/** Correlated requests share one connection; a timeout or caller cancellation sends a separate cancellation frame. */
export function createClient({ input, output, timeoutMs = 30000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw error('timeout_invalid');
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Map();
  let next = 0;
  let closed = false;
  const finish = (id, problem, value) => {
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    clearTimeout(slot.timer);
    slot.signal?.removeEventListener('abort', slot.abort);
    if (problem) slot.reject(problem); else slot.resolve(value);
  };
  lines.on('line', line => {
    if (Buffer.byteLength(line) > MAX_LINE) { close(); return; }
    let message;
    try { message = JSON.parse(line); } catch { close(); return; }
    if (typeof message?.id !== 'string' || typeof message.ok !== 'boolean') { close(); return; }
    finish(message.id, message.ok ? null : error(message.error ?? 'request_failed'), message.value);
  });
  function close() {
    if (closed) return;
    closed = true;
    lines.close();
    for (const id of [...pending.keys()]) finish(id, error('transport_closed'));
  }
  lines.on('close', close);
  return {
    request(method, args, { signal } = {}) {
      if (closed) return Promise.reject(error('transport_closed'));
      if (signal?.aborted) return Promise.reject(error('request_cancelled'));
      const id = String(++next);
      return new Promise((resolve, reject) => {
        const cancel = code => {
          try { write(output, { cancel: id }); } catch { /* local cancellation still completes */ }
          finish(id, error(code));
        };
        const abort = () => cancel('request_cancelled');
        const timer = setTimeout(() => cancel('request_timeout'), timeoutMs);
        pending.set(id, { resolve, reject, timer, signal, abort });
        signal?.addEventListener('abort', abort, { once: true });
        try { write(output, { id, method, args }); } catch (problem) { finish(id, problem); }
      });
    },
    close,
  };
}

/** Each request runs independently so a pending model comparison cannot block a cancel or another request. */
export async function serve({ input, output, handlers, signal }) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const active = new Map();
  const stop = () => { for (const controller of active.values()) controller.abort(); lines.close(); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > MAX_LINE) throw error('message_too_large');
      let request;
      try { request = JSON.parse(line); } catch { throw error('invalid_json'); }
      if (typeof request?.cancel === 'string') { active.get(request.cancel)?.abort(); continue; }
      if (typeof request?.id !== 'string' || typeof request?.method !== 'string' || active.has(request.id)) throw error('request_invalid');
      const controller = new AbortController();
      active.set(request.id, controller);
      const handler = handlers[request.method];
      void Promise.resolve().then(() => {
        if (typeof handler !== 'function') throw error('method_unavailable');
        return handler(request.args, { signal: controller.signal });
      }).then(value => write(output, { id: request.id, ok: true, value }), problem => {
        const code = typeof problem?.code === 'string' && /^[a-z_]+$/.test(problem.code) ? problem.code
          : controller.signal.aborted ? 'request_cancelled' : 'request_failed';
        write(output, { id: request.id, ok: false, error: code });
      }).catch(() => {}).finally(() => active.delete(request.id));
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    stop();
  }
}
