import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { digest } from '../../src/core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
export const CLIMB_RUN_SCHEMA = 'climb-run-graph/v1';
export const CLIMB_ALIGNMENT_SCHEMA = 'climb-alignment/v1';
export const MATCH_BUCKETS = ['stored_and_returned_provisional', 'stored_not_returned_provisional', 'not_stored_provisional',
  'no_match_provisional', 'alignment_uncertain'];

/** Development sessions only. Holdout references and results have no entry here and are refused everywhere. */
export const DEV_REFERENCES = Object.freeze({
  '01a083db-bf9a': { panel: 'panel v1', format: 'cut', root: '/var/tmp/source-memory-real-eval-r2-20261107T171141Z',
    manifest: 'development/CASE-MANIFEST.json', sha256: 'eb84b3f2c668cb6584994855415e438f1144faa77d3d58e771230a27a6f81625',
    cut: 'development/reference/reference-cut-044.json', source_sha256: 'eb36913d3ea58902ac99cb9050d706205e35de89cfe54b17a4ad3e86baf963de' },
  'doxagon-vault-software-presentations': { panel: 'panel v2', format: 'checkpoints', root: '/var/tmp/source-memory-real-eval-r2-20261108T194931Z',
    manifest: 'MANIFEST.json', sha256: 'fbee3eadeaa3205900133b6d9340555b8605cffc41bec1b787575aeaa8bf4ea2',
    source_sha256: 'a5500fe97b3aab256b45ba50030f1a1aaef6e7fde58f1bcc169b638aea55a74e' },
  'nes-launch-rpc-9de6d24c': { panel: 'panel v2', format: 'checkpoints', root: '/var/tmp/source-memory-real-eval-r2-20261109T000000Z-recovery',
    manifest: 'MANIFEST.json', sha256: '36137797d8ae8f41c3e5e8e2e9785253a49d1cf988249ceb5fe40f573aa3cb3e',
    source_sha256: 'ff6bfb477be6ea64b44bf31757824b04a227331e34286c4a513bb9fff566b88e' },
});
export const referenceCaption = panel => `model-adjudicated reference, ${panel}; not semantically reviewed`;

export function refuseHoldoutPaths(paths) {
  if (paths.some(path => typeof path !== 'string' || /holdout/i.test(path))) throw fail('holdout_refused');
}
export function assertDevelopment(sourceKey, paths = []) {
  if (!Object.hasOwn(DEV_REFERENCES, sourceKey)) throw fail('source_not_development');
  refuseHoldoutPaths(paths);
}
/** A run belongs to a development session only if its sealed source hash is that session's pinned source. */
export function assertDevelopmentSource(sourceKey, sourceSha256) {
  assertDevelopment(sourceKey);
  if (DEV_REFERENCES[sourceKey].source_sha256 !== sourceSha256) throw fail('source_binding_mismatch');
}

const bodies = (snapshot, label) => {
  if (!Array.isArray(snapshot?.nodes)) throw fail('snapshot_invalid');
  return snapshot.nodes.filter(node => node.labels?.includes(label)).map(node => JSON.parse(node.properties.body));
};

/**
 * Each record is dated by the checkpoint whose confirmed enrich effect created it: the memory receipt's value must
 * hash to a confirmed coverage-journal effect inside the interval ending at that checkpoint. Records without such a
 * receipt fall back to the first per-checkpoint snapshot containing them, never the final export.
 */
export function storeGraph({ schedule, snapshots, journal, receipts }) {
  if (!Array.isArray(schedule) || !schedule.length || new Set(schedule).size !== schedule.length
    || !Array.isArray(snapshots) || snapshots.length !== schedule.length || !Array.isArray(journal) || !Array.isArray(receipts)) throw fail('snapshot_invalid');
  const byThrough = new Map(snapshots.map(row => [row.through, row.snapshot]));
  if (byThrough.size !== schedule.length || schedule.some(through => !byThrough.has(through))) throw fail('checkpoint_schedule_mismatch');
  const ordered = schedule.map(through => byThrough.get(through)), index = new Map(schedule.map((through, i) => [through, i + 1]));
  const intervals = new Map(journal.filter(row => row.type === 'begin').map(row => [row.id, row.through]));
  const enrichEffects = new Set(journal.filter(row => row.type === 'effect_begin' && row.method === 'enrich').map(row => row.effect));
  const confirmed = new Map(journal.filter(row => row.type === 'effect_end' && row.outcome === 'confirmed' && enrichEffects.has(row.effect))
    .map(row => [row.receipt_sha256, intervals.get(row.id)]));
  const created = new Map();
  for (const receipt of receipts.filter(row => row.method === 'enrich' && row.ok === true)) {
    const through = confirmed.get(digest(receipt.value));
    if (!through || through !== receipt.checkpoint || !index.has(through)) continue;
    for (const id of receipt.value.records ?? []) if (!created.has(id)) created.set(id, index.get(through));
  }
  const firstSeen = new Map();
  ordered.forEach((snapshot, i) => { for (const record of bodies(snapshot, 'SMRecord')) if (!firstSeen.has(record.id)) firstSeen.set(record.id, i + 1); });
  const final = ordered.at(-1);
  const records = bodies(final, 'SMRecord').map(row => ({ id: row.id, kind: row.kind, text: row.text,
    checkpoint_index: created.get(row.id) ?? firstSeen.get(row.id), dated_by: created.has(row.id) ? 'write_receipt' : 'first_snapshot' }))
    .sort((a, b) => a.checkpoint_index - b.checkpoint_index || a.id.localeCompare(b.id));
  const relations = bodies(final, 'SMRelation').map(row => ({ from: row.from, to: row.to, type: row.type }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { checkpoints: schedule.length, schedule: [...schedule], records, relations };
}

/**
 * Normalizes a pinned as-labeled reference: a cumulative cut (panel v1) or per-checkpoint additions (panel v2).
 * Each ordinal is bound to its checkpoint entry so it can be compared with a run schedule.
 */
export function referenceGraph({ format, cut, checkpoints }) {
  if (format === 'cut') {
    if (!Array.isArray(cut?.records) || !Array.isArray(cut?.edges) || !Number.isSafeInteger(cut.through_ordinal)) throw fail('reference_invalid');
    const schedule = new Array(cut.through_ordinal).fill(null);
    schedule[cut.through_ordinal - 1] = cut.through_entry_id;
    for (const row of [...cut.records, ...cut.edges]) {
      const at = row.created_at_checkpoint_ordinal - 1;
      if (!Number.isSafeInteger(at) || at < 0 || at >= schedule.length || (schedule[at] && schedule[at] !== row.created_at_entry_id)) throw fail('reference_invalid');
      schedule[at] = row.created_at_entry_id;
    }
    return checked({ checkpoints: cut.through_ordinal, schedule,
      records: cut.records.map(row => ({ id: row.id, kind: row.kind, text: row.text, checkpoint_index: row.created_at_checkpoint_ordinal })),
      relations: cut.edges.map(row => ({ from: row.from, to: row.to, type: row.type })) });
  }
  if (format !== 'checkpoints' || !Array.isArray(checkpoints) || !checkpoints.length) throw fail('reference_invalid');
  const ordered = [...checkpoints].sort((a, b) => a.ordinal - b.ordinal);
  if (ordered.some((row, index) => row.ordinal !== index + 1 || typeof row.checkpoint_entry_id !== 'string'
    || !Array.isArray(row.records) || !Array.isArray(row.edges))) throw fail('reference_invalid');
  return checked({ checkpoints: ordered.length, schedule: ordered.map(row => row.checkpoint_entry_id),
    records: ordered.flatMap(row => row.records.map(record => ({ id: record.id, kind: record.kind, text: record.text, checkpoint_index: row.ordinal }))),
    relations: ordered.flatMap(row => row.edges.map(edge => ({ from: edge.from, to: edge.to, type: edge.type }))) });
}
// Panel deltas only add: a repeated record ID or a dangling relation would mean the layout is not additions-only.
function checked(graph) {
  const ids = new Set(graph.records.map(row => row.id));
  if (ids.size !== graph.records.length || graph.relations.some(edge => !ids.has(edge.from) || !ids.has(edge.to))) throw fail('reference_invalid');
  return graph;
}

/** Reference ordinals must name the run's own checkpoints; unknown cut ordinals (no labels there) are not compared. */
export function assertSameSchedule(reference, schedule) {
  if (!Array.isArray(schedule) || reference.schedule.length !== schedule.length
    || reference.schedule.some((through, i) => through !== null && through !== schedule[i])) throw fail('reference_schedule_mismatch');
}

/** Reads a regular, non-symlinked file whose bytes must match the expected SHA-256. */
export function readPinned(path, expected, max = 256_000_000) {
  if (!isAbsolute(path ?? '') || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw fail('path_invalid');
  refuseHoldoutPaths([path]);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw fail('input_invalid');
    const bytes = readFileSync(fd);
    if (sha(bytes) !== expected) throw fail('input_changed');
    return bytes;
  } finally { closeSync(fd); }
}

export function readDevReference(sourceKey) {
  assertDevelopment(sourceKey);
  const ref = DEV_REFERENCES[sourceKey], manifest = JSON.parse(readPinned(join(ref.root, ref.manifest), ref.sha256, 20_000_000));
  if (manifest.source_key !== sourceKey || manifest.source_sha256 !== ref.source_sha256) throw fail('reference_source_mismatch');
  const file = key => {
    if (!manifest.files?.[key]?.sha256) throw fail('reference_file_unpinned');
    return JSON.parse(readPinned(join(ref.root, key), manifest.files[key].sha256));
  };
  const graph = ref.format === 'cut' ? referenceGraph({ format: 'cut', cut: file(ref.cut) })
    : referenceGraph({ format: 'checkpoints', checkpoints: Object.keys(manifest.files)
      .filter(key => /^development\/reference\/checkpoint-\d{3}-[0-9a-f]+\.json$/.test(key)).map(file) });
  return { ...graph, panel: ref.panel, caption: referenceCaption(ref.panel), manifest_sha256: ref.sha256 };
}

const tally = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));

/** One completed run's candidate graph plus the metadata the climb dashboard compares across runs. */
export function runExport({ treatment, seal, report, reportSha256, graph, answers }) {
  if (typeof treatment !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(treatment)) throw fail('treatment_invalid');
  if (seal?.digest !== report?.seal_sha256 || report.coverage?.status !== 'complete' || !report.scorecard?.deltas
    || !/^[a-f0-9]{64}$/.test(reportSha256 ?? '')) throw fail('run_unqualified');
  // The export label must agree with the sealed treatment; an unsealed run is a baseline.
  if (seal.spec.treatment ? !(treatment === seal.spec.treatment.id || treatment.startsWith(`${seal.spec.treatment.id}-`)) : /^(D|T)\d/.test(treatment)) throw fail('treatment_label_mismatch');
  const sourceKey = Object.keys(DEV_REFERENCES).find(key => DEV_REFERENCES[key].source_sha256 === seal.spec.sourceSha256);
  assertDevelopmentSource(sourceKey, seal.spec.sourceSha256);
  const dispositions = report.coverage.dispositions;
  if (JSON.stringify(dispositions.map(row => row.through)) !== JSON.stringify(graph.schedule)) throw fail('checkpoint_schedule_mismatch');
  const byArm = arm => answers.filter(row => row.arm === arm).map(row => row.answer.trace);
  const arms = [...new Set(answers.map(row => row.arm))].sort();
  return { schema: CLIMB_RUN_SCHEMA, treatment, source_key: sourceKey, source_sha256: seal.spec.sourceSha256, run_id: report.run_id, run_dir: report.run_dir,
    treatment_spec: seal.spec.treatment ?? null, code_sha: seal.spec.codeSha, mixed_code: seal.spec.resume?.codeTransition
      ? { from: seal.spec.resume.codeTransition.from, to: seal.spec.resume.codeTransition.to, cursor: seal.spec.resume.cursor } : null,
    seal_sha256: report.seal_sha256, report_sha256: reportSha256, dataset_sha256: seal.spec.datasetSha256,
    models: Object.fromEntries(Object.entries(seal.spec.budget?.purposes ?? {}).map(([purpose, row]) => [purpose, row.route])),
    primary: { metric: 'candidate usefulness delta vs no-memory baseline', value: report.scorecard.deltas.candidate,
      sensitivity: report.scorecard.sensitivity, confidence: report.scorecard.confidence, cases: answers.filter(row => row.arm === 'candidate').length,
      status: 'provisional pending owner semantic review' },
    diagnostics: { deltas: report.scorecard.deltas, safety: report.scorecard.safety,
      coverage: { scheduled: report.coverage.scheduled, dispositions: tally(dispositions.map(row => row.disposition)),
        search_incomplete: dispositions.filter(row => row.search_incomplete).length,
        budget_limited: dispositions.filter(row => (row.search_statuses ?? []).some(status => status.status === 'budget_limited')).length,
        trigger_context_omitted: dispositions.map(row => (row.search_statuses ?? []).reduce((sum, status) => sum + (status.trigger_context_omitted ?? 0), 0)) },
      abstention: Object.fromEntries(arms.map(arm => [arm, tally(byArm(arm).map(trace => trace.abstention))])),
      record_dating: tally(graph.records.map(row => row.dated_by)) },
    cost: { spent_nano: report.budget.spent_nano, calls: report.budget.calls_started, basis: 'SDK-rate API-equivalent; not a provider charge' },
    returned_item_ids: [...new Set(byArm('candidate').flatMap(trace => trace.returnedItemIds))].sort(),
    graph };
}

const embed = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** A self-contained page: data is embedded as inert JSON and rendered only through textContent and SVG attributes. */
export function dashboardHtml({ generatedAt, sessions }) {
  for (const session of sessions) assertDevelopment(session.source_key);
  const data = embed({ generatedAt, buckets: MATCH_BUCKETS, sessions });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Source Memory climb (private)</title><style>${STYLE}</style></head><body>
<header><h1>Source Memory climb</h1><p id="meta"></p><label>Run <select id="run"></select></label><div id="legend"></div></header>
<main id="sessions"></main><section><h2>Progression across runs</h2><div id="charts"></div></section><div id="tip"></div>
<script type="application/json" id="data">${data}</script><script>${SCRIPT}</script></body></html>`;
}

export const dashboardSha256 = html => sha(html);

const STYLE = `
:root{--bg:#f4f1ea;--ink:#1d1c1a;--muted:#6b665c;--line:#d8d1c3;--panel:#fffdf8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 18px;display:flex;flex-wrap:wrap;gap:14px;align-items:center}
h1{font:600 17px/1 ui-serif,Georgia,serif;margin:0}h2{font:600 15px ui-serif,Georgia,serif;margin:18px 18px 6px}h3{margin:0 0 4px;font-size:14px}
#meta{margin:0;color:var(--muted)}select{font:inherit;padding:3px 6px}
#legend{display:flex;flex-wrap:wrap;gap:10px;color:var(--muted)}.sw{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px}
.ln{display:inline-block;width:16px;height:3px;margin-right:4px;vertical-align:3px}
.session{margin:14px 18px;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cap{color:var(--muted);font-size:12px;margin-bottom:4px}
.stats{color:var(--muted);font-size:12px}svg{width:100%;height:auto;display:block}
#charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;margin:0 18px 30px}
.chart{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px}
#tip{position:fixed;pointer-events:none;max-width:460px;background:#1d1c1a;color:#f4f1ea;padding:8px 10px;border-radius:5px;display:none;z-index:9;white-space:pre-wrap}
.none{color:var(--muted);padding:30px;text-align:center}`;

const SCRIPT = `
const D=JSON.parse(document.getElementById('data').textContent);
const KIND={observation:'#3b6ea5',decision:'#c2562f',intention:'#7a8f3a',action:'#8a4f9e',outcome:'#c79a2b',question:'#2f8f86'};
const TYPE={supersedes:'#b3261e',qualifies:'#5b7fa6',depends_on:'#6b665c',outcome_of:'#c79a2b',contradicts:'#8a4f9e'};
const BUCKET={stored_and_returned_provisional:'#3f7d4f',stored_not_returned_provisional:'#c79a2b',not_stored_provisional:'#8c2a1f',no_match_provisional:'#b3261e',alignment_uncertain:'#a39e93'};
const NS='http://www.w3.org/2000/svg',tip=document.getElementById('tip');
const el=(tag,attrs={},parent)=>{const n=tag.includes(':')?document.createElementNS(NS,tag.slice(4)):document.createElement(tag);for(const[k,v]of Object.entries(attrs))k==='text'?n.textContent=v:n.setAttribute(k,v);parent&&parent.appendChild(n);return n};
const hover=(node,text)=>{node.addEventListener('mousemove',e=>{tip.textContent=text;tip.style.display='block';tip.style.left=Math.min(e.clientX+14,innerWidth-480)+'px';tip.style.top=(e.clientY+14)+'px'});node.addEventListener('mouseleave',()=>tip.style.display='none')};
const usd=n=>'$'+(Number(BigInt(n))/1e9).toFixed(2);
const runs=[...new Map(D.sessions.flatMap(s=>s.runs).map(r=>[r.treatment,r.treatment])).keys()];
const sel=document.getElementById('run');for(const t of runs)el('option',{value:t,text:t},sel);sel.value=runs.at(-1)??'';
document.getElementById('meta').textContent='Generated '+D.generatedAt+' · development sessions only · scores provisional pending owner semantic review';
const leg=document.getElementById('legend');for(const[k,c]of Object.entries(KIND)){const s=el('span',{},leg);el('span',{class:'sw',style:'background:'+c},s);s.append(k)}
for(const[k,c]of Object.entries(TYPE)){const s=el('span',{},leg);el('span',{class:'ln',style:'background:'+c},s);s.append(k)}
function graph(parent,g,maxCp){
  const W=900,H=300,pad=26,kinds=Object.keys(KIND),lane=(H-2*pad)/kinds.length,svg=el('svg:svg',{viewBox:'0 0 '+W+' '+H},parent);
  const x=i=>pad+(W-2*pad)*((i-1)/Math.max(1,maxCp-1));
  for(let i=1;i<=maxCp;i+=Math.max(1,Math.round(maxCp/11)))el('svg:text',{x:x(i),y:H-6,'font-size':10,fill:'#6b665c','text-anchor':'middle',text:'cp '+i},svg);
  kinds.forEach((k,i)=>el('svg:line',{x1:pad,x2:W-pad,y1:pad+lane*(i+.5),y2:pad+lane*(i+.5),stroke:'#ece6da'},svg));
  const pos=new Map(),count=new Map();
  for(const r of g.records){const li=Math.max(0,kinds.indexOf(r.kind)),key=li+':'+r.checkpoint_index,n=count.get(key)??0;count.set(key,n+1);
    pos.set(r.id,[x(r.checkpoint_index||1)+(n%3-1)*5,pad+lane*li+6+((n*7)%Math.max(8,lane-12))])}
  for(const e of g.relations){const a=pos.get(e.from),b=pos.get(e.to);if(!a||!b)continue;
    const p=el('svg:path',{d:'M'+a[0]+','+a[1]+' Q'+((a[0]+b[0])/2)+','+(Math.min(a[1],b[1])-18)+' '+b[0]+','+b[1],fill:'none',stroke:TYPE[e.type]??'#999','stroke-width':1.3,opacity:.75},svg);hover(p,e.type)}
  for(const r of g.records){const[a,b]=pos.get(r.id),c=el('svg:circle',{cx:a,cy:b,r:4.2,fill:KIND[r.kind]??'#999',stroke:'#fffdf8','stroke-width':1},svg);hover(c,r.kind+' · cp '+r.checkpoint_index+'\\n'+r.text)}
}
function stats(g){const k={};for(const r of g.records)k[r.kind]=(k[r.kind]||0)+1;return g.records.length+' records, '+g.relations.length+' relations · '+Object.entries(k).map(([a,b])=>a+' '+b).join(', ')}
function render(){
  const host=document.getElementById('sessions');host.replaceChildren();
  for(const s of D.sessions){
    const box=el('div',{class:'session'},host);el('h3',{text:s.source_key},box);const pair=el('div',{class:'pair'},box);
    const run=s.runs.find(r=>r.treatment===sel.value&&r.graph&&r.primary&&r.cost),maxCp=Math.max(s.reference?.checkpoints??1,run?.graph.checkpoints??1);
    const left=el('div',{},pair);el('div',{class:'cap',text:'Reference as labeled — '+s.reference_caption},left);
    if(s.reference){el('div',{class:'stats',text:stats(s.reference)},left);graph(left,s.reference,maxCp)}else el('div',{class:'none',text:'reference unavailable'},left);
    const right=el('div',{},pair);
    if(run){const a=run.alignment;el('div',{class:'cap',text:'Candidate · '+run.treatment+' · code '+run.code_sha.slice(0,7)+' · seal '+run.seal_sha256.slice(0,8)+' · Δ '+run.primary.value.toFixed(3)+' · '+usd(run.cost.spent_nano)},right);
      el('div',{class:'stats',text:stats(run.graph)+(a?' · match: '+D.buckets.map(b=>b.replace('_provisional','')+' '+(a.item_counts?.[b]??0)).join(', ')+' (returned = returned to the candidate answerer in any case)':' · alignment not run')},right);graph(right,run.graph,maxCp)}
    else el('div',{class:'none',text:'no completed run for this treatment'},right);
  }
}
function chart(title,series,stacks,colors,opts={}){
  const box=el('div',{class:'chart'},document.getElementById('charts'));el('h3',{text:title},box);
  const W=360,H=170,pad=30,svg=el('svg:svg',{viewBox:'0 0 '+W+' '+H},box);
  const totals=series.map(r=>opts.range?Math.max(r.hi??r.v,r.v):stacks.reduce((t,k)=>t+(r.v[k]??0),0)),top=Math.max(1e-9,...totals),bw=(W-2*pad)/Math.max(1,series.length);
  const floor=opts.range?Math.min(0,...series.map(r=>r.lo)):0;
  el('svg:text',{x:4,y:pad,'font-size':9,fill:'#6b665c',text:opts.fmt?opts.fmt(top):String(+top.toFixed(3))},svg);
  series.forEach((r,i)=>{const x=pad+i*bw+bw*.18,w=bw*.64;let y=H-pad;
    if(opts.range){const sy=v=>H-pad-(H-2*pad)*((v-floor)/(top-floor));el('svg:line',{x1:x+w/2,x2:x+w/2,y1:sy(r.lo),y2:sy(r.hi),stroke:'#6b665c','stroke-width':2},svg);
      const c=el('svg:circle',{cx:x+w/2,cy:sy(r.v),r:4,fill:'#c2562f'},svg);hover(c,r.label+': '+r.v.toFixed(3)+' (sensitivity '+r.lo.toFixed(3)+'–'+r.hi.toFixed(3)+'; '+r.note+')')}
    else for(const k of stacks){const v=r.v[k]??0,h=(H-2*pad)*(v/top);if(!v)continue;y-=h;const b=el('svg:rect',{x,y,width:w,height:h,fill:colors[k]??'#999'},svg);hover(b,r.label+' · '+k+': '+(opts.fmt?opts.fmt(v):v))}
    el('svg:text',{x:x+w/2,y:H-pad+12,'font-size':9,fill:'#6b665c','text-anchor':'middle',text:r.label.slice(0,14)},svg)});
}
function charts(){
  for(const s of D.sessions){
    const runs=s.runs.filter(r=>r.graph&&r.primary&&r.cost),lab=r=>r.treatment,sum=(o,k)=>o[k]??0;
    const kinds=r=>{const o={};for(const x of r.graph.records)o[x.kind]=(o[x.kind]||0)+1;return o},types=r=>{const o={};for(const x of r.graph.relations)o[x.type]=(o[x.type]||0)+1;return o};
    chart(s.source_key+' · records per kind',runs.map(r=>({label:lab(r),v:kinds(r)})),Object.keys(KIND),KIND);
    chart(s.source_key+' · relations per type',runs.map(r=>({label:lab(r),v:types(r)})),Object.keys(TYPE),TYPE);
    chart(s.source_key+' · supersedes',runs.map(r=>({label:lab(r),v:{supersedes:sum(types(r),'supersedes')}})),['supersedes'],TYPE);
    chart(s.source_key+' · reference match (provisional; returned = any case)',runs.map(r=>({label:lab(r),v:r.alignment?.item_counts??{}})),D.buckets,BUCKET);
    chart(s.source_key+' · primary score Δ',runs.map(r=>{const v=r.primary.value,sv=r.primary.sensitivity??{},xs=[v,sv.conservative,sv.excluded,sv.inclusive].filter(Number.isFinite);
      return{label:lab(r),v,lo:Math.min(...xs),hi:Math.max(...xs),note:r.primary.confidence?.kind??'unknown'}}),[],{},{range:true});
    chart(s.source_key+' · cost',runs.map(r=>({label:lab(r),v:{run:Number(BigInt(r.cost.spent_nano))/1e9,alignment:r.alignment?Number(BigInt(r.alignment.spent_nano))/1e9:0}})),['run','alignment'],{run:'#3b6ea5',alignment:'#a39e93'},{fmt:v=>'$'+v.toFixed(2)});
  }
}
sel.addEventListener('change',render);render();charts();`;
