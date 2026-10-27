// Opt-in recall phase markers for localizing slow spans. Everything here is best effort: a marker may be dropped,
// but it can never throw into, delay, or alter the operation it describes.
export const MAX_MARKERS = 48;
export const MAX_BYTES = 6144;
export const MAX_LINE_BYTES = 128;

const safeName = name => String(name).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 64);
// Lines are ASCII, so length is byte length. The newline counts toward the line bound.
const fit = line => (line.length < MAX_LINE_BYTES ? `${line}\n` : `${line.slice(0, MAX_LINE_BYTES - 1)}\n`);

/**
 * `write(line)` receives complete newline-terminated ASCII lines; its failures are swallowed. Markers past the count or
 * byte bound are dropped and counted, and `finish()` writes the single footer. Markers plus footer stay within `maxBytes`.
 */
export function createPhaseSink({ write, now = () => performance.now(), maxMarkers = MAX_MARKERS, maxBytes = MAX_BYTES }) {
  const started = now();
  const markerBytes = maxBytes - MAX_LINE_BYTES;
  let emitted = 0;
  let dropped = 0;
  let bytes = 0;
  let finished = false;
  const send = line => { try { write(line); } catch { /* a failing sink never reaches recall */ } };
  return {
    mark(name, edge) {
      if (finished) return;
      try {
        const elapsed = Math.min(999_999_999, Math.max(0, Math.trunc(now() - started) || 0));
        const line = fit(`phase v1 ${safeName(name)} ${edge === 'end' ? 'end' : 'start'} +${elapsed}ms`);
        if (emitted >= maxMarkers || bytes + line.length > markerBytes) { dropped += 1; return; }
        emitted += 1;
        bytes += line.length;
        send(line);
      } catch { dropped += 1; }
    },
    finish() {
      if (finished) return;
      finished = true;
      send(fit(`phase v1 footer emitted=${emitted} dropped=${dropped}`));
    },
  };
}

// An error on a closed stream is emitted asynchronously; without a listener it would crash the process.
export function createStreamSink(stream) {
  stream.on?.('error', () => {});
  return createPhaseSink({ write: line => { stream.write(line); } });
}

export const passthrough = (_name, run) => run();

/** Returns `(name, run)` that brackets `run()` with start/end markers, or `passthrough` when there is no sink. */
export function tracer(sink) {
  if (!sink) return passthrough;
  const mark = (name, edge) => { try { sink.mark(name, edge); } catch { /* ignore a throwing sink */ } };
  return async (name, run) => {
    mark(name, 'start');
    try { return await run(); } finally { mark(name, 'end'); }
  };
}

export const scoped = (trace, prefix) => (name, run) => trace(`${prefix}.${name}`, run);
