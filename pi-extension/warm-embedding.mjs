const port = Number(process.argv[2]), model = process.argv[3], dimensions = Number(process.argv[4]);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || typeof model !== 'string' || !model
  || !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4096) process.exit(1);
const started = Date.now();
try {
  const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: ['source-memory warm-up'] }),
    signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('warm_failed');
  const result = await response.json();
  if (!Array.isArray(result.data) || result.data.length !== 1 || !Array.isArray(result.data[0].embedding)
    || result.data[0].embedding.length !== dimensions) throw new Error('warm_failed');
  process.stdout.write(`${JSON.stringify({ ready: true, elapsed_ms: Date.now() - started })}\n`);
} catch { process.stderr.write('{"ready":false,"code":"warm_failed"}\n'); process.exitCode = 1; }
