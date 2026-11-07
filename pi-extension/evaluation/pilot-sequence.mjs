import { runCoveredInterval } from '../coverage.mjs';

const fail = code => Object.assign(new Error(code), { code });

export const checkpointId = result => result.through ?? result.cursor;

/** Evaluate each case before any later checkpoint mutates its pre-answer store. */
export async function runPilotSequence({ session, journal, checkpoints, cases, budget, evaluateCase, onBeforeCheckpoint = async () => {}, onCheckpoint = async () => {}, onCase = async () => {} }) {
  if (!session || !journal || !Array.isArray(checkpoints) || !checkpoints.length || !Array.isArray(cases)
    || typeof budget?.state !== 'function' || typeof evaluateCase !== 'function' || typeof onBeforeCheckpoint !== 'function'
    || typeof onCheckpoint !== 'function' || typeof onCase !== 'function') throw fail('pilot_invalid');
  const seen = new Set();
  for (const [index, checkpoint] of checkpoints.entries()) {
    if (typeof checkpoint?.id !== 'string' || !checkpoint.id || seen.has(checkpoint.id) || !Number.isFinite(Date.parse(checkpoint.time))
      || (index && Date.parse(checkpoint.time) < Date.parse(checkpoints[index - 1].time))) throw fail('schedule_invalid');
    seen.add(checkpoint.id);
  }
  for (const item of cases) {
    const index = checkpoints.findIndex(row => row.id === item.through);
    if (index < 0 || !Number.isFinite(Date.parse(item.publicCase?.queryTime))
      || Date.parse(item.publicCase.queryTime) < Date.parse(checkpoints[index].time)
      || (checkpoints[index + 1] && Date.parse(item.publicCase.queryTime) >= Date.parse(checkpoints[index + 1].time))) throw fail('case_schedule_invalid');
  }
  let cursor = null;
  const results = [], evaluated = [];
  for (const checkpoint of checkpoints) {
    if (budget.state().stopped) return { status: 'budget_stopped', cursor, results, evaluated };
    await onBeforeCheckpoint(checkpoint);
    const result = await runCoveredInterval({ journal, session, through: checkpoint.id, cursor, allowInterrupted: checkpoint.interrupted === true });
    results.push(result);
    await onCheckpoint(result, budget.state());
    if (!['committed', 'abstained', 'ineligible_by_policy'].includes(result.disposition)) return { status: result.disposition, cursor, results, evaluated };
    cursor = result.cursor;
    for (const item of cases.filter(row => row.through === cursor)) {
      if (budget.state().stopped) return { status: 'budget_stopped', cursor, results, evaluated };
      const outcome = await evaluateCase(item, cursor);
      evaluated.push(outcome);
      await onCase(outcome, budget.state());
    }
  }
  return { status: 'complete', cursor, results, evaluated };
}
