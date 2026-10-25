import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Memory } from '../src/memory.mjs';
import { indexNames, namespace } from '../src/core.mjs';

const exec = promisify(execFile);

export async function runIntegration(database, scratch) {
  const results = [];
  async function check(name, fn) {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  }
  let modelDown = false;
  const model = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (modelDown) { res.writeHead(503).end(); return; }
    const input = JSON.parse(body);
    if (req.url === '/embed') {
      const vector = value => /aubergine|purple/i.test(value) ? [0, 1, 0] : /amber/i.test(value) ? [-1, 0, 0] : /blue/i.test(value) ? [1, 0, 0]
        : /04:00/.test(value) ? [0, -1, 1] : /quartz/i.test(value) ? [0, -1, 0] : [0, 0, 1];
      res.end(JSON.stringify({ model: 'fixture-only', data: input.input.map((value, index) => ({ index, embedding: vector(value) })) }));
    } else res.end(JSON.stringify({ results: input.documents.map((_text, index) => ({ index, relevance_score: 1 / (index + 1) })) }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const url = `http://127.0.0.1:${model.address().port}`;
  const config = { neo4j: database, scopes: { read: ['demo', 'foreign', 'exclusion', 'lexical'], write: ['demo', 'foreign', 'exclusion', 'lexical'] },
    embedding: { url: `${url}/embed`, model: 'fixture-only', dimensions: 3 },
    reranker: { url: `${url}/rerank`, model: 'fixture-only' } };
  const memory = new Memory(config);
  const turn = (id, value) => ({ source: 'integration-fixture', conversation_id: 'conversation', turn_id: id,
    entries: [{ id: `u-${id}`, role: 'user', text: value }] });
  const oldInput = turn('old', 'Use blue for the dashboard.');
  const newInput = { ...turn('new', 'Replace that choice with amber.'), parent_turn_id: 'old' };
  let oldSource;
  let newSource;
  const span = (source, input) => ({ turn: source.id, entry_id: input.entries[0].id, start: 0, end: input.entries[0].text.length });
  try {
    await memory.init('demo');
    await memory.init('foreign');
    await memory.init('exclusion');
    const lexical = new Memory({ neo4j: database, scopes: config.scopes });
    try {
      const input = { ...turn('long', ''), entries: ['system', 'user', 'tool', 'assistant'].map(role => ({
        id: `${role}-entry`, role,
        text: `${'context '.repeat(600)}${role === 'tool' ? 'lexicalneedle' : `${role}note`} ${'context '.repeat(40)}`,
      })) };
      const source = await lexical.ingest('lexical', input);
      const entry = input.entries.find(row => row.role === 'tool');
      const start = 'context '.repeat(448).length;
      const end = entry.text.trimEnd().length;
      const hit = { kind: 'turn', id: source.id, text: entry.text.slice(start, end),
        match: { turn: source.id, entry_id: entry.id, start, end, role: entry.role },
        conversation: { scope: 'lexical', source: input.source, conversation_id: input.conversation_id } };
      await check('chunk lexical reports a missing index with a safe unavailable reason', async () => {
        const recalled = await lexical.recall('lexical', { query: 'lexicalneedle' });
        assert.deepEqual(recalled.channels.chunk_lexical, { status: 'unavailable', reason: 'chunk_index_missing' });
      });
      await check('init twice creates one scope chunk text index populated from existing chunks', async () => {
        const first = await lexical.init('lexical');
        const second = await lexical.init('lexical');
        const indexes = await lexical.store.transaction('read', tx => tx.run(`SHOW FULLTEXT INDEXES YIELD name,labelsOrTypes,properties
          WHERE name=$name RETURN labelsOrTypes,properties`, { name: indexNames('lexical').chunks }));
        assert.deepEqual([first, second, indexes.records.map(row => row.toObject()),
          await lexical.store.chunkLexicalStatus('lexical'), await lexical.store.chunkLexical('lexical', 'lexicalneedle', 1)],
          [{ initialized: true, scope: 'lexical' }, { initialized: true, scope: 'lexical' },
            [{ labelsOrTypes: [`${namespace('lexical')}Chunk`], properties: ['text'] }], { status: 'ready' }, [hit]]);
      });
      await check('new chunks store the role of every entry', async () => {
        const roles = await lexical.store.transaction('read', tx => tx.run(`MATCH (c:SMChunk {turn_uid:$uid})
          RETURN DISTINCT c.entry_id AS entry_id,c.role AS role ORDER BY entry_id`, { uid: source.id }));
        assert.deepEqual(roles.records.map(row => row.toObject()), input.entries.map(row => ({ entry_id: row.id, role: row.role }))
          .sort((a, b) => a.entry_id.localeCompare(b.entry_id)));
      });
      await check('chunk lexical returns the exact matching entry and span in a long multi-entry turn without embeddings', async () => {
        const recalled = await lexical.recall('lexical', { query: 'lexicalneedle', limit: 1 });
        const bundle = recalled.bundles[0];
        assert.deepEqual([recalled.channels.chunk_lexical, recalled.channels.chunk_vector.status,
          bundle?.match.channels.map(row => row.channel).sort(), bundle?.source.excerpts[0]],
          [{ status: 'ready' }, 'unconfigured', ['chunk_lexical', 'turn_lexical'], { ...hit.match, text: hit.text }]);
      });
      await check('legacy chunk roles resolve from the exact parent entry without backfill writes', async () => {
        await lexical.store.transaction('write', tx => tx.run('MATCH (c:SMChunk {turn_uid:$uid,entry_id:$entry}) REMOVE c.role',
          { uid: source.id, entry: entry.id }));
        const hits = await lexical.store.chunkLexical('lexical', 'lexicalneedle', 1);
        const recalled = await lexical.recall('lexical', { query: 'lexicalneedle', limit: 1 });
        const stored = await lexical.store.transaction('read', tx => tx.run('MATCH (c:SMChunk {turn_uid:$uid,entry_id:$entry}) RETURN count(c.role) AS roles',
          { uid: source.id, entry: entry.id }));
        assert.deepEqual([hits, recalled.bundles[0]?.source.excerpts[0], stored.records[0].get('roles')],
          [[hit], { ...hit.match, text: hit.text }, 0]);
      });
      const stored = await lexical.store.transaction('read', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) RETURN t.body AS body', { uid: source.id }));
      const body = stored.records[0].get('body');
      const original = JSON.parse(body);
      for (const [name, entries] of [['missing', original.entries.filter(row => row.id !== entry.id)],
        ['ambiguous', [...original.entries, { ...entry, role: 'assistant' }]]]) {
        await check(`${name} parent entry joins retain the chunk lexical hit with unknown role`, async () => {
          try {
            await lexical.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) SET t.body=$body',
              { uid: source.id, body: JSON.stringify({ ...original, entries }) }));
            assert.deepEqual(await lexical.store.chunkLexical('lexical', 'lexicalneedle', 1), [{ ...hit, match: { ...hit.match, role: 'unknown' } }]);
          } finally {
            await lexical.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) SET t.body=$body', { uid: source.id, body }));
          }
        });
      }
      await check('legacy chunk conversation keys come from the parent body and remain informational', async () => {
        try {
          await lexical.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) REMOVE t.source,t.conversation_id', { uid: source.id }));
          const hits = await lexical.store.chunkLexical('lexical', 'lexicalneedle', 1, [{ source: input.source, conversation_id: input.conversation_id }]);
          const properties = await lexical.store.transaction('read', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) RETURN t.source AS source,t.conversation_id AS conversation',
            { uid: source.id }));
          assert.deepEqual([hits, properties.records[0].toObject()],
            [[{ ...hit, conversation: { ...hit.conversation, legacy: true } }], { source: null, conversation: null }]);
        } finally {
          await lexical.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) SET t.source=$source,t.conversation_id=$conversation',
            { uid: source.id, source: input.source, conversation: input.conversation_id }));
        }
      });
      await check('scope chunk indexes isolate identical source conversation and turn keys in both directions', async () => {
        const foreignText = 'lexicalneedle belongs to another scope.';
        const foreign = await lexical.ingest('foreign', { ...input, entries: [{ ...entry, text: foreignText }] });
        const foreignHit = { kind: 'turn', id: foreign.id, text: foreignText,
          match: { turn: foreign.id, entry_id: entry.id, start: 0, end: foreignText.length, role: entry.role },
          conversation: { ...hit.conversation, scope: 'foreign' } };
        assert.deepEqual([await lexical.store.chunkLexical('lexical', 'lexicalneedle', 32),
          await lexical.store.chunkLexical('foreign', 'lexicalneedle', 32)], [[hit], [foreignHit]]);
      });
    } finally { await lexical.close(); }
    // The asker's own conversation outranks everything else in every channel; one other conversation holds the answer.
    const said = (conversation, id, value) => ({ source: 'integration-fixture', conversation_id: conversation, turn_id: id,
      entries: [{ id: `u-${id}`, role: 'user', text: value }] });
    const asked = [];
    for (let index = 0; index < 6; index += 1) {
      const input = said('asker', `q${index}`, `Quartz quartz quartz: when does the quartz backup window start? Question ${index}.`);
      asked.push({ input, source: await memory.ingest('exclusion', input) });
    }
    const answerInput = said('decider', 'd1', `After a long review of the rota, the staffing plan, the storage costs and several unrelated scheduling notes, the decision is that the quartz backup window should start at 04:00 from now on. ${'Other notes follow. '.repeat(12)}`);
    const answer = await memory.ingest('exclusion', answerInput);
    const claim = (id, input, source, extra = []) => ({ id, kind: 'decision', status: 'proposed', attribution: 'fixture', text: input.entries[0].text,
      evidence: [span(source, input), ...extra] });
    await memory.enrich('exclusion', { records: [
      ...asked.map(({ input, source }, index) => claim(`asker-claim-${index}`, input, source)),
      claim('decider-decision', answerInput, answer),
      claim('mixed-claim', asked[0].input, asked[0].source, [span(answer, answerInput)]),
    ], relations: [] });
    await memory.index('exclusion');
    const asker = [{ source: 'integration-fixture', conversation_id: 'asker' }];
    await check('chunk lexical excludes dominating conversations before its candidate limit', async () => {
      const plain = await memory.store.chunkLexical('exclusion', 'quartz backup window start', 1);
      const excluded = await memory.store.chunkLexical('exclusion', 'quartz backup window start', 1, asker);
      const recalled = await memory.recall('exclusion', { query: 'quartz backup window start', candidates: 1, limit: 1, exclude_conversations: asker });
      assert.deepEqual([asked.some(row => row.source.id === plain[0]?.id), excluded.map(row => row.id),
        recalled.bundles[0]?.source?.id, recalled.bundles[0]?.match.channels.some(row => row.channel === 'chunk_lexical')],
        [true, [answer.id], answer.id, true], 'chunk lexical exclusion must precede the candidate limit');
    });
    const conversationsOf = bundle => [...new Set([bundle.source?.conversation_id,
      ...bundle.records.flatMap(row => (row.supporting_evidence ?? []).map(span => span.conversation_id))].filter(Boolean))].sort();
    await check('without exclusion the asker\'s own conversation fills the first four in every channel', async () => {
      const recalled = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4 });
      assert.deepEqual([recalled.excluded_conversations, recalled.bundles.every(bundle => conversationsOf(bundle).includes('asker'))], [0, true]);
    });
    await check('excluding the asker returns the other conversation\'s eligible matches through every channel', async () => {
      const recalled = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4, exclude_conversations: asker });
      const seed = bundle => bundle.match.kind === 'turn' ? [bundle.source.conversation_id]
        : bundle.records.find(row => row.id === bundle.match.id).supporting_evidence.map(span => span.conversation_id);
      assert.equal(recalled.bundles.some(bundle => seed(bundle).every(conversation => conversation === 'asker')), false);
      const channels = bundle => bundle?.match.channels.map(row => row.channel).sort();
      const turn = recalled.bundles.find(bundle => bundle.match.kind === 'turn' && bundle.source.conversation_id === 'decider');
      const record = recalled.bundles.find(bundle => bundle.match.kind === 'record' && bundle.match.id === 'decider-decision');
      assert.deepEqual([channels(turn), channels(record), recalled.excluded_conversations],
        [['chunk_lexical', 'chunk_vector', 'turn_lexical'], ['record_lexical', 'record_vector'], 1]);
    });
    await check('a record citing the asker and another conversation is still returned, for the caller to refuse', async () => {
      const recalled = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 32, exclude_conversations: asker });
      assert.ok(recalled.bundles.some(bundle => bundle.records.some(row => row.id === 'mixed-claim')));
    });
    await check('the asker\'s unindexed text does not hold back recall of the others', async () => {
      // As the live pilot runs: the asker's current turn is stored at admission and indexed later.
      const deferred = new Memory({ ...config, index_on_write: false });
      await deferred.ingest('exclusion', said('asker', 'q-new', 'Quartz again: the quartz window?'));
      await deferred.close?.();
      const excluded = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4, exclude_conversations: asker });
      const plain = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4 });
      assert.deepEqual([excluded.channels.chunk_vector.status, plain.channels.chunk_vector.status], ['ready', 'partial']);
      await memory.index('exclusion');
    });
    await check('a turn stored without conversation properties is never excluded, nor are its chunks, records or pending text', async () => {
      const legacyInput = said('legacy', 'old1', 'Quartz legacy note about the window.');
      const later = new Memory({ ...config, index_on_write: false });
      const legacy = await later.ingest('exclusion', legacyInput);
      await later.close();
      // As turns stored before lineage properties existed.
      await memory.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) REMOVE t.source, t.conversation_id', { uid: legacy.id }));
      const pending = await memory.recall('exclusion', { query: 'quartz legacy note', limit: 32, exclude_conversations: asker });
      await memory.enrich('exclusion', { records: [claim('legacy-claim', legacyInput, legacy),
        claim('asker-legacy-claim', asked[1].input, asked[1].source, [span(legacy, legacyInput)])], relations: [] });
      await memory.index('exclusion');
      const recalled = await memory.recall('exclusion', { query: 'quartz legacy note', limit: 32, exclude_conversations: asker });
      const turn = recalled.bundles.find(bundle => bundle.match.kind === 'turn' && bundle.source.id === legacy.id);
      const records = new Set(recalled.bundles.flatMap(bundle => bundle.records.map(row => row.id)));
      assert.deepEqual([pending.channels.chunk_vector.status, turn?.match.channels.map(row => row.channel).sort(), records.has('legacy-claim'), records.has('asker-legacy-claim')],
        ['partial', ['chunk_lexical', 'chunk_vector', 'turn_lexical'], true, true]);
    });
    await check('exclusion names a source and conversation exactly and is bounded', async () => {
      const otherSource = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4, exclude_conversations: [{ source: 'other', conversation_id: 'asker' }] });
      assert.equal(otherSource.bundles.every(bundle => conversationsOf(bundle).includes('asker')), true);
      await assert.rejects(memory.recall('exclusion', { query: 'q', exclude_conversations: Array.from({ length: 17 }, () => asker[0]) }), { code: 'invalid_input' });
      await assert.rejects(memory.recall('exclusion', { query: 'q', exclude_conversations: [{ ...asker[0], extra: 1 }] }), { code: 'invalid_input' });
    });
    await check('concurrent source replay produces one retained turn', async () => {
      const inserted = await Promise.all([memory.ingest('demo', oldInput), memory.ingest('demo', oldInput)]);
      oldSource = inserted[0];
      assert.deepEqual([new Set(inserted.map(row => row.id)).size, (await memory.status('demo')).turns], [1, 1]);
    });
    await check('changed bytes cannot overwrite an accepted source identity', async () => {
      await assert.rejects(memory.ingest('demo', { ...oldInput, entries: [{ ...oldInput.entries[0], text: 'Changed' }] }), { code: 'source_identity_conflict' });
    });
    newSource = await memory.ingest('demo', newInput);
    const record = (id, source, input) => ({ id, kind: 'decision', status: 'accepted', attribution: 'fixture operator', text: input.entries[0].text, evidence: [span(source, input)] });
    const enrichment = { records: [record('old-decision', oldSource, oldInput), record('new-decision', newSource, newInput)],
      relations: [{ id: 'replacement', type: 'supersedes', from: 'new-decision', to: 'old-decision', attribution: 'fixture operator', evidence: [span(newSource, newInput)] }] };
    await check('structured enrichment replays without duplicate records or relations', async () => {
      await memory.enrich('demo', enrichment);
      await memory.enrich('demo', enrichment);
      const counts = await memory.status('demo');
      assert.deepEqual([counts.records, counts.relations], [2, 1]);
    });
    await check('an old lexical match includes the semantically dissimilar successor', async () => {
      const recalled = await memory.recall('demo', { query: 'blue', limit: 1 });
      assert.deepEqual(recalled.bundles[0].records.map(row => row.id).sort(), ['new-decision', 'old-decision']);
    });
    await check('source evidence is exact and survives independently of session files', async () => {
      assert.deepEqual((await memory.show('demo', { kind: 'turn', id: oldSource.id })).turn.entries[0], { ...oldInput.entries[0], occurred_at: null });
    });
    await check('a turn without extracted memories is lexically retrievable', async () => {
      const source = await memory.ingest('demo', turn('unextracted', 'The weather vane points east.'));
      const recalled = await memory.recall('demo', { query: 'weather', limit: 8 });
      assert.ok(recalled.bundles.some(bundle => bundle.source?.id === source.id && bundle.match.channels.some(channel => channel.channel === 'turn_lexical')));
    });
    await check('fixture vectors recover a source absent from lexical matches', async () => {
      const source = await memory.ingest('demo', turn('semantic', 'The aubergine release is scheduled.'));
      const recalled = await memory.recall('demo', { query: 'purple', limit: 8 });
      const match = recalled.bundles.find(bundle => bundle.source?.id === source.id);
      assert.deepEqual(match.match.channels.map(channel => channel.channel), ['chunk_vector']);
    });
    let foreign;
    await check('scope-specific indexes and graph expansion exclude foreign source', async () => {
      foreign = await memory.ingest('foreign', turn('private', 'Use blue FORBIDDEN_FIXTURE.'));
      const recalled = await memory.recall('demo', { query: 'blue', limit: 32 });
      assert.equal(JSON.stringify(recalled).includes('FORBIDDEN_FIXTURE'), false);
    });
    await check('foreign evidence is rejected atomically', async () => {
      await assert.rejects(memory.enrich('demo', { records: [
        record('must-not-persist', oldSource, oldInput),
        record('foreign-record', foreign, turn('private', 'Use blue FORBIDDEN_FIXTURE.')),
      ], relations: [] }), { code: 'evidence_unavailable' });
      await assert.rejects(memory.show('demo', { kind: 'record', id: 'must-not-persist' }), { code: 'not_found' });
    });
    await check('a conflict late in enrichment rolls back earlier creates', async () => {
      await assert.rejects(memory.enrich('demo', { records: [
        record('rolled-back', oldSource, oldInput),
        { ...record('old-decision', oldSource, oldInput), text: 'This would overwrite history.' },
      ], relations: [] }), { code: 'record_identity_conflict' });
      await assert.rejects(memory.show('demo', { kind: 'record', id: 'rolled-back' }), { code: 'not_found' });
    });
    await check('bounded expansion reports missing successor context', async () => {
      const recalled = await memory.recall('demo', { query: 'blue', max_nodes: 1, limit: 1 });
      assert.equal(recalled.relationship_context_complete, false);
    });
    await check('a seed bundle read without a query reveals a newly added relationship', async () => {
      const before = await memory.show('demo', { kind: 'bundle', seed: { kind: 'record', id: 'old-decision' }, max_nodes: 8, max_hops: 2 });
      await memory.enrich('demo', { records: [{ ...record('qualifier', newSource, newInput), status: 'proposed' }],
        relations: [{ id: 'qualifies-old', type: 'qualifies', from: 'qualifier', to: 'old-decision', attribution: 'fixture', evidence: [span(newSource, newInput)] }] });
      const after = await memory.show('demo', { kind: 'bundle', seed: { kind: 'record', id: 'old-decision' }, max_nodes: 8, max_hops: 2 });
      assert.deepEqual([before.bundle.relations.length, after.bundle.relations.length, after.bundle.records.some(row => row.id === 'qualifier')], [1, 2, true]);
    });
    const lineageTurn = (id, parent, words) => ({ source: 'integration-fixture', conversation_id: 'lineage', turn_id: id,
      ...(parent ? { parent_turn_id: parent } : { lineage_root: true }), entries: [{ id: `u-${id}`, role: 'user', text: words }] });
    const first = await memory.ingest('demo', lineageTurn('l1', null, 'Use teal.'));
    await memory.ingest('demo', lineageTurn('l2', 'l1', 'Actually use amber.'));
    await memory.ingest('demo', lineageTurn('l3', 'l2', 'No, use violet.'));
    await memory.ingest('demo', lineageTurn('l4', 'l3', 'Final answer: green.'));
    await check('following returns later turns by parent link and reports more beyond the limit', async () => {
      const read = await memory.show('demo', { kind: 'following', turn: first.id, limit: 2 });
      assert.deepEqual([read.turns.map(row => row.turn_id), read.has_more, read.end, read.lineage], [['l2', 'l3'], true, 'limit', 'linked']);
    });
    await check('following to the last recorded turn reports a linked recorded end', async () => {
      const read = await memory.show('demo', { kind: 'following', turn: first.id, limit: 3 });
      assert.deepEqual([read.turns.map(row => row.turn_id), read.has_more, read.end, read.lineage], [['l2', 'l3', 'l4'], false, 'recorded_end', 'linked']);
    });
    await check('two children of one turn are reported as branched, not chosen', async () => {
      await memory.ingest('demo', lineageTurn('l2b', 'l1', 'Regenerated: use amber.'));
      const read = await memory.show('demo', { kind: 'following', turn: first.id, limit: 3 });
      assert.deepEqual([read.turns.length, read.lineage, read.end], [0, 'branched', 'branched']);
    });
    await check('a same-conversation turn stored without lineage makes following unknown', async () => {
      const lone = await memory.ingest('demo', { ...lineageTurn('m1', null, 'Use teal.'), conversation_id: 'legacy-conversation' });
      // A turn written before lineage properties existed: same conversation, no parent recorded.
      await memory.store.transaction('write', tx => tx.run('CREATE (t:SMTurn {uid:$uid, scope:$scope, body:$body})',
        { uid: 'legacy-turn', scope: 'demo', body: JSON.stringify({ ...lineageTurn('m0', null, 'Earlier.'), conversation_id: 'legacy-conversation' }) }));
      const read = await memory.show('demo', { kind: 'following', turn: lone.id });
      assert.deepEqual([read.lineage, read.unlinked_turns], ['unknown', 1]);
    });
    await check('a later turn with an unknown parent makes an earlier turn\'s following unknown', async () => {
      const root = await memory.ingest('demo', { ...lineageTurn('g1', null, 'Use teal.'), conversation_id: 'gap' });
      await memory.ingest('demo', { ...lineageTurn('g3', 'g2-never-captured', 'Use amber.'), conversation_id: 'gap' });
      const { lineage_root: _root, ...unrooted } = lineageTurn('g4', null, 'Use violet.');
      await memory.ingest('demo', { ...unrooted, conversation_id: 'gap' });
      const read = await memory.show('demo', { kind: 'following', turn: root.id });
      assert.deepEqual([read.turns.length, read.end, read.lineage, read.unlinked_turns], [0, 'recorded_end', 'unknown', 2]);
    });
    await check('a declared root with a parent is refused', async () => {
      await assert.rejects(memory.ingest('demo', { ...lineageTurn('bad', 'l1', 'x'), lineage_root: true }), { code: 'invalid_input' });
    });
    await check('turns stored by an older caller replay when a newer caller adds lineage, keeping the first placement', async () => {
      const plainRoot = { source: 'integration-fixture', conversation_id: 'upgrade', turn_id: 'v1', entries: [{ id: 'u-v1', role: 'user', text: 'First.' }] };
      const plainNext = { ...plainRoot, turn_id: 'v2', entries: [{ id: 'u-v2', role: 'user', text: 'Second.' }] };
      const root = await memory.ingest('demo', plainRoot);
      const next = await memory.ingest('demo', plainNext);
      const rootRetry = await memory.ingest('demo', { ...plainRoot, lineage_root: true });
      const nextRetry = await memory.ingest('demo', { ...plainNext, parent_turn_id: 'v1' });
      const read = await memory.show('demo', { kind: 'following', turn: root.id });
      assert.deepEqual([rootRetry.id, rootRetry.replayed, nextRetry.id, nextRetry.replayed, read.turns.length, read.lineage],
        [root.id, true, next.id, true, 0, 'unknown']);
    });
    await check('turn_by_key reports exactly the candidate keys that name stored turns, in this scope only', async () => {
      const read = await memory.show('demo', { kind: 'turn_by_key', source: 'integration-fixture', conversation_id: 'upgrade', turn_ids: ['missing', 'v2', 'v1'] });
      const foreign = await memory.show('foreign', { kind: 'turn_by_key', source: 'integration-fixture', conversation_id: 'upgrade', turn_ids: ['v1'] });
      assert.deepEqual([read.found.map(row => row.turn_id), foreign.found.length], [['v2', 'v1'], 0]);
    });
    await check('a changed source text is still a conflict even with lineage added', async () => {
      await assert.rejects(memory.ingest('demo', { source: 'integration-fixture', conversation_id: 'upgrade', turn_id: 'v1', lineage_root: true,
        entries: [{ id: 'u-v1', role: 'user', text: 'Rewritten.' }] }), { code: 'source_identity_conflict' });
    });
    await check('an envelope without the new lineage field keeps its identity on replay', async () => {
      const plain = { source: 'integration-fixture', conversation_id: 'plain', turn_id: 'p1', entries: [{ id: 'u-p1', role: 'user', text: 'Plain turn.' }] };
      const once = await memory.ingest('demo', plain);
      const again = await memory.ingest('demo', plain);
      assert.deepEqual([again.id, again.replayed], [once.id, true]);
    });
    await check('a cyclic relationship graph terminates', async () => {
      await memory.enrich('demo', { records: [], relations: [{ id: 'cycle', type: 'depends_on', from: 'old-decision', to: 'new-decision', attribution: 'fixture', evidence: [span(oldSource, oldInput)] }] });
      const recalled = await memory.recall('demo', { query: 'blue', limit: 1 });
      assert.equal(recalled.bundles[0].relations.length, 3);
    });
    await check('output budget omission never claims complete relationship context', async () => {
      const recalled = await memory.recall('demo', { query: 'blue', max_chars: 256 });
      assert.deepEqual([recalled.status, recalled.bundles.length, recalled.relationship_context_complete, recalled.budget_omitted > 0], ['budget_limited', 0, false, true]);
    });
    await check('configured model failure preserves lexical recall and reports degradation', async () => {
      modelDown = true;
      const source = await memory.ingest('demo', turn('outage', 'Outage safety keeps this exact source.'));
      const recalled = await memory.recall('demo', { query: 'Outage', limit: 1 });
      assert.deepEqual([source.retained, source.indexing.status, recalled.status, recalled.bundles.length], [true, 'unavailable', 'degraded', 1]);
      modelDown = false;
    });
    await check('index retries complete embeddings without another source occurrence', async () => {
      const before = (await memory.status('demo')).turns;
      const result = await memory.index('demo');
      const after = await memory.status('demo');
      assert.deepEqual([result.status, after.unindexed, after.turns], ['ready', 0, before]);
    });
    const attemptInput = turn('attempt', 'I ran the demonstration check. It passed. Should we run another?');
    const attemptSource = await memory.ingest('demo', attemptInput);
    const attemptEvidence = [span(attemptSource, attemptInput)];
    const typedRecord = (id, kind) => ({ id, kind, text: kind, status: 'observed', attribution: 'fixture', evidence: attemptEvidence });
    const outcomeEdge = (id, from, to) => ({ id, type: 'outcome_of', from, to, attribution: 'fixture', evidence: attemptEvidence });
    await check('new outcome cannot use a new question as its referent', async () => {
      await assert.rejects(memory.enrich('demo', { records: [typedRecord('bad-outcome', 'outcome'), typedRecord('new-question', 'question')],
        relations: [outcomeEdge('bad-new', 'bad-outcome', 'new-question')] }), { code: 'invalid_outcome_relation' });
      await assert.rejects(memory.show('demo', { kind: 'record', id: 'bad-outcome' }), { code: 'not_found' });
    });
    await check('outcome can refer to a new action and replay against its stored referent', async () => {
      const outcome = typedRecord('good-outcome', 'outcome');
      await memory.enrich('demo', { records: [outcome, typedRecord('good-action', 'action'), typedRecord('existing-question', 'question')],
        relations: [outcomeEdge('good-new', 'good-outcome', 'good-action')] });
      const replay = await memory.enrich('demo', { records: [outcome], relations: [] });
      assert.deepEqual(replay.records, ['good-outcome']);
    });
    await check('new outcome cannot use an existing question as its referent', async () => {
      await assert.rejects(memory.enrich('demo', { records: [typedRecord('bad-existing-outcome', 'outcome')],
        relations: [outcomeEdge('bad-existing', 'bad-existing-outcome', 'existing-question')] }), { code: 'invalid_outcome_relation' });
    });
    await check('relation-only enrichment enforces an action target', async () => {
      await assert.rejects(memory.enrich('demo', { records: [],
        relations: [outcomeEdge('bad-target', 'good-outcome', 'existing-question')] }), { code: 'invalid_outcome_relation' });
    });
    await check('relation-only enrichment enforces an outcome source', async () => {
      await assert.rejects(memory.enrich('demo', { records: [],
        relations: [outcomeEdge('bad-source', 'existing-question', 'good-action')] }), { code: 'invalid_outcome_relation' });
    });
    await check('relation-only enrichment accepts existing outcome and action endpoints', async () => {
      const result = await memory.enrich('demo', { records: [], relations: [outcomeEdge('good-existing', 'good-outcome', 'good-action')] });
      assert.deepEqual(result.relations, ['good-existing']);
    });
    await check('CLI init, ingest, enrich, recall and show work across fresh processes', async () => {
      const configPath = join(scratch, 'cli-config.json');
      await writeFile(configPath, JSON.stringify({ neo4j: database, scopes: { read: ['cli'], write: ['cli'] } }), { mode: 0o600 });
      const run = async (command, input) => {
        const args = ['bin/memory.mjs', command, '--config', configPath, '--scope', 'cli'];
        if (input) {
          const path = join(scratch, `${command}.json`);
          await writeFile(path, JSON.stringify(input));
          args.push('--input', path);
        }
        return JSON.parse((await exec(process.execPath, args, { timeout: 30000, maxBuffer: 4_000_000 })).stdout);
      };
      await run('init');
      const input = turn('cli', 'CLI preserves unabridged evidence.');
      const source = await run('ingest', input);
      await run('enrich', { records: [{ ...record('cli-record', source, input), kind: 'observation', status: 'observed' }], relations: [] });
      const recalled = await run('recall', { query: 'unabridged' });
      const shown = await run('show', { kind: 'turn', id: source.id });
      assert.deepEqual([recalled.ok, recalled.bundles.length > 0, shown.turn.entries[0].text], [true, true, input.entries[0].text]);
    });
    if (process.env.SOURCE_MEMORY_REAL_EMBEDDING_URL) {
      await check('a real local embedding endpoint indexes and recalls by meaning', async () => {
        const real = new Memory({ neo4j: database, scopes: { read: ['real'], write: ['real'] },
          embedding: { url: process.env.SOURCE_MEMORY_REAL_EMBEDDING_URL,
            model: process.env.SOURCE_MEMORY_REAL_EMBEDDING_MODEL ?? 'embeddinggemma', dimensions: 768, timeout_ms: 60000 } });
        try {
          await real.init('real');
          const target = await real.ingest('real', turn('real-1', 'We postponed the product launch because the payment provider failed certification.'));
          await real.ingest('real', turn('real-2', 'The office plants need watering on Fridays.'));
          const recalled = await real.recall('real', { query: 'Why was the release delayed?', limit: 2 });
          const vector = recalled.bundles.find(bundle => bundle.match.channels.some(channel => channel.channel === 'chunk_vector'));
          assert.deepEqual([recalled.channels.chunk_vector.status, vector?.source?.id], ['ready', target.id]);
        } finally { await real.close(); }
      });
    }
    return results;
  } finally {
    await memory.close();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  }
}
