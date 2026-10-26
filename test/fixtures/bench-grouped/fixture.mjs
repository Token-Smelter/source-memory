import { createHash } from 'node:crypto';
import { identity } from '../../../src/core.mjs';

export const BASELINE = '365c78f411bfc8e3cddc255869ae123fc21ec95f';
export const PRIMARY_SCOPE = 'f4m-fictional';
export const FOREIGN_SCOPE = 'f4m-foreign';
export const DIMENSIONS = 768;
export const MODEL = 'f4m-fictional-768-v1';
export const VECTOR_DEFINITION = Object.freeze({ dimensions: DIMENSIONS, similarity: 'cosine', quantization: false });

export function fixtureVector(value) {
  const hash = createHash('sha256').update(value).digest();
  return Array.from({ length: DIMENSIONS }, (_, index) => Math.sin((index + 1) * 0.17 + hash[index % hash.length] * 0.013)
    + Math.cos((index + 1) * 0.31 + hash[(index + 7) % hash.length] * 0.007) * 0.25);
}

export function groupedFixture() {
  const turns = [];
  const records = [];
  const relations = [];
  const legacyTurns = [];
  const source = 'f4m-fictional-host';
  const idOf = (scope, conversation, turn) => identity('turn', scope, source, conversation, `turn-${turn}`);
  const claimId = (scope, conversation, turn, kind) => `${scope}:${conversation}:${turn}:${kind}`;
  for (const scope of [PRIMARY_SCOPE, FOREIGN_SCOPE]) {
    const count = scope === PRIMARY_SCOPE ? 48 : 4;
    for (let conversation = 0; conversation < count; conversation += 1) {
      const name = conversation === 39 ? 'requester' : `conversation-${String(conversation).padStart(2, '0')}`;
      for (let index = 0; index < 10; index += 1) {
        const topic = `F4M_TOPIC_${String(conversation).padStart(2, '0')}`;
        const user = index === 9 && conversation === 41 ? `${topic} Newest correction: use amber, not teal.`
          : conversation % 5 === 0 ? `${topic} Which fictional release colour did we choose, teal or amber?`
            : `${topic} Fictional release choice ${index}: teal.`;
        const assistant = `${topic} Assistant interpretation ${index}; it is not user acceptance.`;
        const tool = `${topic} Fictional tool output: "quoted" \\ path\n\t\u0001界😀. `.repeat(8);
        let parent = index ? `turn-${index - 1}` : null;
        let root = index === 0;
        if (conversation === 42 && index === 9) parent = 'turn-7';
        if (conversation === 43 && index >= 8) { parent = index === 8 ? 'turn-9' : 'turn-8'; root = false; }
        const turn = { source, conversation_id: name, turn_id: `turn-${index}`, parent_turn_id: parent,
          ...(root ? { lineage_root: true } : {}), occurred_at: new Date(Date.UTC(2025, 0, 1, conversation, index)).toISOString(),
          entries: [{ id: 'user', role: 'user', text: user }, { id: 'assistant', role: 'assistant', text: assistant }, { id: 'tool', role: 'tool', text: tool }] };
        const uid = idOf(scope, name, index);
        turns.push({ scope, uid, turn });
        if (scope === PRIMARY_SCOPE && conversation >= 44) legacyTurns.push(uid);
        const cited = conversation % 5 === 0 ? turn.entries[1] : turn.entries[0];
        const evidence = [{ turn: uid, entry_id: cited.id, start: 0, end: cited.text.length }];
        const decision = claimId(scope, name, index, 'decision');
        const observation = claimId(scope, name, index, 'observation');
        records.push({ scope, record: { id: decision, kind: 'decision', text: `${topic} Extracted fictional choice ${index}.`,
          status: 'proposed', attribution: 'Fictional benchmark extraction, not authority', evidence } });
        records.push({ scope, record: { id: observation, kind: 'observation', text: `${topic} Extracted fictional observation ${index}.`,
          status: 'observed', attribution: 'Fictional benchmark extraction', evidence } });
        relations.push({ scope, relation: { id: `${decision}:qualifies`, type: 'qualifies', from: observation, to: decision,
          attribution: 'Fictional benchmark relation', evidence } });
        if (conversation === 41 && index === 9) relations.push({ scope, relation: { id: `${decision}:correction`, type: 'supersedes',
          from: decision, to: claimId(scope, name, 8, 'decision'), attribution: 'Fictional correction assertion', evidence } });
      }
    }
  }
  const from = turns.find(row => row.scope === PRIMARY_SCOPE && row.turn.conversation_id === 'conversation-00' && row.turn.turn_id === 'turn-0');
  const to = turns.find(row => row.scope === PRIMARY_SCOPE && row.turn.conversation_id === 'conversation-01' && row.turn.turn_id === 'turn-0');
  relations.push({ scope: PRIMARY_SCOPE, relation: { id: 'fictional-cross-conversation', type: 'qualifies',
    from: claimId(PRIMARY_SCOPE, from.turn.conversation_id, 0, 'decision'), to: claimId(PRIMARY_SCOPE, to.turn.conversation_id, 0, 'decision'),
    attribution: 'Fictional cross-conversation assertion', evidence: [from, to].map(row => ({ turn: row.uid, entry_id: 'user', start: 0, end: row.turn.entries[0].text.length })) } });
  const common = { mode: 'evidence_advice', group: 'conversation', per_conversation: 2, candidates: 64, limit: 12,
    max_nodes: 8, max_hops: 2, max_chars: 1000000, follow: { turns: 8, bytes: 16384 } };
  const queries = [
    { id: 'regular', scope: PRIMARY_SCOPE, input: { ...common, query: 'F4M_TOPIC_12 fictional release' } },
    { id: 'requester-exclusion', scope: PRIMARY_SCOPE, input: { ...common, query: 'F4M_TOPIC_39 fictional release',
      exclude_conversations: [{ source, conversation_id: 'requester' }] } },
    { id: 'correction-and-bounds', scope: PRIMARY_SCOPE, input: { ...common, query: 'F4M_TOPIC_41 amber teal correction F4M_TOPIC_40' } },
    { id: 'legacy-and-branch', scope: PRIMARY_SCOPE, input: { ...common, query: 'F4M_TOPIC_44 F4M_TOPIC_42 F4M_TOPIC_43' } },
  ];
  return { version: 'f4m-grouped-v1', source, turns, records, relations, legacyTurns, queries,
    chunking: { words: 64, overlap: 8 }, vector_definition: VECTOR_DEFINITION };
}
