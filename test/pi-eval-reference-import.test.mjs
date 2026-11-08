import test from 'node:test';
import assert from 'node:assert/strict';
import { identity, namespace } from '../src/core.mjs';
import { prepareReferenceSnapshot } from '../pi-extension/evaluation/reference-import.mjs';

function fixture() {
  const scope = 'fiction', ns = namespace(scope);
  const entries = [{ id: 'short-a', role: 'user', text: 'Fictional source A.' },
    { id: 'huge', role: 'assistant', text: 'x'.repeat(32001) }, { id: 'short-b', role: 'user', text: 'Fictional source B.' },
    { id: 'image', role: 'user', text: `[image sha256=${'a'.repeat(64)} mime=image/png bytes=2]` }];
  const snapshot = { schema: 'source-memory-logical-snapshot/v1', scope, nodes: [
    { uid: 'turn', labels: ['SMTurn', `${ns}Turn`], properties: { uid: 'turn', scope, body: JSON.stringify({ entries }) } },
    { uid: 'chunk', labels: ['SMChunk', `${ns}Chunk`], properties: { uid: 'chunk', scope } },
    { uid: 'candidate', labels: ['SMRecord', `${ns}Record`], properties: { uid: 'candidate', scope } }],
  relationships: [{ from: 'turn', to: 'chunk', type: 'SM_HAS_CHUNK', properties: {} },
    { from: 'candidate', to: 'turn', type: 'SM_EVIDENCE', properties: {} }] };
  const ev = id => ({ source_key: 'fiction-source', entry_id: id });
  const reference = { schema: 'source-memory-r2-reference-cut/v1', source_key: 'fiction-source', scope, through_entry_id: 'checkpoint',
    records: [{ id: 'action', kind: 'action', text: 'Fictional action.', evidence: [ev('short-a')] },
      { id: 'outcome', kind: 'outcome', text: 'Fictional outcome.', evidence: [ev('short-a'), ev('huge'), ev('short-b')] },
      { id: 'decision', kind: 'decision', text: 'Fictional decision.', evidence: [ev('short-b')] },
      { id: 'uncitable', kind: 'question', text: 'Fictional question.', evidence: [ev('huge'), ev('image')] }],
    edges: [{ from: 'outcome', to: 'action', type: 'outcome_of', evidence: [ev('short-a')] },
      { from: 'outcome', to: 'decision', type: 'outcome_of', evidence: [ev('short-b')] },
      { from: 'decision', to: 'uncitable', type: 'depends_on', evidence: [ev('short-b')] }] };
  return { snapshot, reference, sourceKey: 'fiction-source', through: 'checkpoint' };
}

test('evaluation import preserves whole fitting citations, omits invalid edges and retains unlinked outcomes', () => {
  const f = fixture(); f.reference.edges.shift();
  const result = prepareReferenceSnapshot(f);
  const recordNode = result.snapshot.nodes.find(row => row.uid === identity('record', 'fiction', 'outcome'));
  const record = JSON.parse(recordNode.properties.body);
  assert.deepEqual([record.evidence.map(row => row.entry_id), result.audit.imported_records, result.audit.imported_edges,
    result.audit.omitted_items.length, result.audit.omitted_edges.map(row => row.reason)],
  [['short-a', 'short-b'], 3, 0, 1, ['outcome_of_non_action_or_non_outcome', 'endpoint_item_omitted']]);
});

test('evaluation import removes candidate records, retains raw turns and imports valid outcome relations', () => {
  const result = prepareReferenceSnapshot(fixture());
  assert.deepEqual([result.snapshot.nodes.some(row => row.uid === 'candidate'), result.audit.imported_records,
    result.audit.imported_edges, result.snapshot.relationships.filter(row => row.type === 'SM_HAS_CHUNK').length], [false, 3, 1, 1]);
});
