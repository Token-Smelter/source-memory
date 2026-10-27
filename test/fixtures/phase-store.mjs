// In-memory store double for recall tests: one turn, one record citing it, no relations. Calls are logged with
// function arguments (trace callbacks) removed, so logs compare equal with and without phase markers.
const KEY = { scope: 's', source: 'src', conversation_id: 'c1' };
const TURN = { id: 't1', scope: 's', source: 'src', conversation_id: 'c1', turn_id: 'x1', parent_turn_id: null, occurred_at: null,
  entries: [{ id: 'e1', role: 'user', text: 'the dashboard color changed to teal' }] };
const RECORD = { uid: 'r-uid', id: 'r1', kind: 'claim', text: 'color is teal', evidence: [{ turn: 't1', entry_id: 'e1', start: 4, end: 13 }] };

export function phaseStore(log = []) {
  const call = (name, impl) => async (...args) => {
    log.push([name, ...args.filter(arg => typeof arg !== 'function')]);
    return impl(...args);
  };
  const store = {
    lexicalStatus: call('lexicalStatus', () => ({ status: 'ready' })),
    chunkLexicalStatus: call('chunkLexicalStatus', () => ({ status: 'ready' })),
    admittedLexical: call('admittedLexical', (_scope, kind) => ({
      hits: kind === 'chunk' ? [] : [kind === 'turn' ? { kind, id: 't1', text: TURN.entries[0].text, conversations: [{ key: KEY }] }
        : { kind, id: 'r1', text: RECORD.text, conversations: [{ key: KEY }] }],
      omitted: [], admitted_conversations: 1, exhausted: true })),
    lexical: call('lexical', (_scope, kind) => [kind === 'turn' ? { kind, id: 't1', text: TURN.entries[0].text } : { kind, id: 'r1', text: RECORD.text }]),
    chunkLexical: call('chunkLexical', () => []),
    getTurn: call('getTurn', () => structuredClone(TURN)),
    getRecord: call('getRecord', () => structuredClone(RECORD)),
    recordsForTurn: call('recordsForTurn', () => [structuredClone(RECORD)]),
    neighbors: call('neighbors', () => []),
    childTurns: call('childTurns', () => []),
    unlinkedTurns: call('unlinkedTurns', () => 0),
    close: call('close', () => undefined),
  };
  return { store, log };
}
