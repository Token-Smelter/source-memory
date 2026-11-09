import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A scripted default-option journal session; its bytes must not change while the harness depends on them. */
export async function defaultJournalBytes(createCoverageJournal) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-default-journal-'));
  chmodSync(directory, 0o700);
  try {
    const journal = createCoverageJournal({ directory, sessionKey: 'fiction-golden' });
    const lock = readFileSync(journal.path.replace(/\.jsonl$/, '.lock'));
    let enrichCalls = 0;
    const memory = journal.track({
      async ingest() { return { id: 'turn-fiction' }; },
      async enrich() { if (++enrichCalls === 1) throw new Error('timeout'); return { records: ['record-fiction'] }; },
      async beginOutcome() { return { token: 'outcome-token' }; },
      async applyOutcome() { return { status: 'written', records: ['outcome-fiction'] }; },
      async beginLinks() { return { token: 'links', packet: { retrieval: { omitted_prior_records: 1, omitted_prior_spans: 0, trigger_omissions: [] } } }; },
      async applyLinks() { return { applied: 1 }; },
    });
    const first = journal.begin({ cursor: null, through: 'a' });
    await memory.ingest('private', { turn_id: 'fiction' });
    await memory.enrich('private', { records: [{ id: 'record-fiction' }] }, { trigger: 'turn-fiction' }).catch(() => {});
    journal.finish('failed', 'request_timeout');
    journal.reconcile({ id: first, disposition: 'failed', evidenceRef: 'fiction-proof' });
    journal.begin({ cursor: null, through: 'a', retry: true });
    await memory.ingest('private', { turn_id: 'fiction' });
    await memory.enrich('private', { records: [{ id: 'record-fiction' }] }, { trigger: 'turn-fiction' });
    await memory.beginOutcome('private', 'turn-fiction', { id: 'outcome-fiction' }, null, 'action-handle');
    await memory.applyOutcome('private', 'outcome-token', null);
    await memory.beginLinks('private', 'turn-fiction', ['record-fiction']);
    await memory.applyLinks('links', {});
    journal.finish('committed', null, { incomplete: false, statuses: [] });
    journal.begin({ cursor: 'a', through: 'b' });
    journal.finish('failed', 'fiction');
    journal.close();
    const reopened = createCoverageJournal({ directory, sessionKey: 'fiction-golden' });
    const bytes = readFileSync(reopened.path);
    reopened.close();
    return { bytes, lock };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[2]) {
  const { createCoverageJournal } = await import(process.argv[2]);
  const { createHash } = await import('node:crypto');
  const { bytes, lock } = await defaultJournalBytes(createCoverageJournal);
  process.stdout.write(`${JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), rows: bytes.toString().trim().split('\n').length, lock: lock.length })}\n`);
}
