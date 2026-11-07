import { runCoveredInterval } from '../coverage.mjs';

const fail = code => Object.assign(new Error(code), { code });

export const checkpointId = result => result.through ?? result.cursor;

/** Evaluate each case before any later checkpoint mutates its pre-answer store. */
export async function runPilotSequence({ session, journal, checkpoints, cases, budget, evaluateCase, initialCursor = null, retryFirst = false, completedCaseIds = [],
  onBeforeCheckpoint = async () => {}, onCheckpoint = async () => {}, onCase = async () => {} }) {
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
  if (initialCursor !== null && (typeof initialCursor !== 'string' || !initialCursor)) throw fail('resume_invalid');
  const startIndex = initialCursor === null ? 0 : checkpoints.findIndex(row => row.id === initialCursor) + 1;
  if (initialCursor !== null && startIndex === 0) throw fail('resume_invalid');
  if (!Array.isArray(completedCaseIds) || new Set(completedCaseIds).size !== completedCaseIds.length
    || completedCaseIds.some(id => !cases.some(item => item.publicCase.id === id))) throw fail('resume_invalid');
  const completed = new Set(completedCaseIds);
  if (initialCursor !== null && cases.some(item => checkpoints.findIndex(row => row.id === item.through) < startIndex - 1
    && !completed.has(item.publicCase.id))) throw fail('resume_prior_cases_unsupported');
  if (typeof retryFirst !== 'boolean' || (retryFirst && startIndex >= checkpoints.length)) throw fail('resume_invalid');
  let cursor = initialCursor;
  const results = [], evaluated = [];
  if (initialCursor !== null) for (const item of cases.filter(row => row.through === initialCursor && !completed.has(row.publicCase.id))) {
    if (budget.state().stopped) return { status: 'budget_stopped', cursor, results, evaluated };
    let outcome;
    try { outcome = await evaluateCase(item, cursor); }
    catch (error) { return { status: 'case_failed', cursor, results, evaluated, failure: error?.code ?? 'case_failed' }; }
    evaluated.push(outcome);
    await onCase(outcome, budget.state());
  }
  for (const [index, checkpoint] of checkpoints.slice(startIndex).entries()) {
    if (budget.state().stopped) return { status: 'budget_stopped', cursor, results, evaluated };
    await onBeforeCheckpoint(checkpoint);
    const result = await runCoveredInterval({ journal, session, through: checkpoint.id, cursor, allowInterrupted: checkpoint.interrupted === true,
      retry: retryFirst && index === 0 });
    results.push(result);
    await onCheckpoint(result, budget.state());
    if (!['committed', 'abstained', 'ineligible_by_policy'].includes(result.disposition)) return { status: result.disposition, cursor, results, evaluated };
    cursor = result.cursor;
    for (const item of cases.filter(row => row.through === cursor && !completed.has(row.publicCase.id))) {
      if (budget.state().stopped) return { status: 'budget_stopped', cursor, results, evaluated };
      let outcome;
      try { outcome = await evaluateCase(item, cursor); }
      catch (error) { return { status: 'case_failed', cursor, results, evaluated, failure: error?.code ?? 'case_failed' }; }
      evaluated.push(outcome);
      await onCase(outcome, budget.state());
    }
  }
  return { status: 'complete', cursor, results, evaluated };
}
