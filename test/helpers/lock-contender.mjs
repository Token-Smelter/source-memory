import { createCoverageJournal } from '../../pi-extension/coverage.mjs';

// One process contending for a pid-locked journal: report whether it held it, hold, then release.
const [directory, sessionKey, holdMs] = process.argv.slice(2);
try {
  const journal = createCoverageJournal({ directory, sessionKey, pidLock: true });
  process.stdout.write('held\n');
  await new Promise(resolve => setTimeout(resolve, Number(holdMs)));
  journal.close();
} catch (error) { process.stdout.write(`${error.code ?? 'error'}\n`); }
