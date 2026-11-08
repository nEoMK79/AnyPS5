'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model.js');
const fs = require('node:fs');
const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'upstream.json'), 'utf8'));
const scope = (tid, name, ts, dur, pid = 7) => ({ph:'X', tid, pid, name, ts, dur});
const present = ts => ({ph:'i', name:'present', tid:1, pid:7, ts});
const metadata = (tid, name) => ({ph:'M', name:'thread_name', tid, pid:7, args:{name}});
const capture = () => M.trace(fixture.events, fixture.summary.trace, [fixture.summary]);
const interval = (start, end, extras={}) => ({interval_start_s:start, interval_end_s:end, presents:60, frame_ms:{p50:10,p90:15,p99:20,max:25}, gpu_busy_ms_per_present:8, commit:'abc', ...extras});
test('official fixture preserves frames and last summary boundary', () => {
  const d = capture(); assert.deepEqual(d.frames.map(f => f.ms), [10,20,10]);
  assert.deepEqual(d.frames.map(f => f.id), [600,601,602]); assert.equal(d.end,40);
});
test('CPU accounting agrees with upstream on its real nested fixture', () => {
  const a = M.analyze(capture(),0,40);
  for (const actual of a.threads) {
    const expected = fixture.digest.threads.find(t => t.thread===actual.name);
    assert.ok(Math.abs(actual.working - expected.busy_ms_per_frame*3)<1e-9);
    assert.ok(Math.abs(actual.waiting - expected.wait_ms_per_frame*3)<1e-9);
  }
});
test('missing summary excludes unbounded final frame', () => {
  assert.deepEqual(M.trace(fixture.events).frames.map(f=>f.ms),[10,20]);
});
test('only matching summary and compression alias extend the trace', () => {
  assert.equal(M.trace(fixture.events,fixture.summary.trace.slice(0,-3),[fixture.summary]).frames.length,3);
  assert.equal(M.trace(fixture.events,'another.json',[fixture.summary]).frames.length,2);
});
test('exact filename wins over later compression alias', () => {
  const exact={...fixture.summary,window:{ms:50}};
  assert.equal(M.trace(fixture.events,exact.trace,[exact,{...fixture.summary,trace:exact.trace.slice(0,-3)}]).end,50);
});
test('inconsistent summary end is rejected', () => {
  assert.throws(()=>M.trace(fixture.events,fixture.summary.trace,[{...fixture.summary,window:{ms:5}}]));
});
test('union clips and does not add overlapping GPU work twice', () => {
  const d=M.trace([metadata(1,'gpu'),present(0),present(20000),scope(1,'batch',0,10000),scope(1,'draw',5000,10000)]);
  const a=M.analyze(d,0,20); assert.equal(a.gpuMs,15); assert.equal(a.threads[0].unknown,5);
  assert.equal(M.analyze(d,5,12).gpuMs,7);
});
test('nested waits counted once and scope cost remains inclusive', () => {
  const d=M.trace([present(0),present(10000),scope(1,'work',0,10000),scope(1,'lock.wait',1000,6000),scope(1,'inner.wait',2000,2000)]);
  const a=M.analyze(d,0,10); assert.equal(a.threads[0].waiting,6);assert.equal(a.threads[0].working,4);
  assert.equal(a.phases.reduce((s,p)=>s+p.ms,0),18);
});
test('same-name threads keep separate identities', () => {
  const d=M.trace([metadata(1,'shader prepare'),metadata(2,'shader prepare'),scope(1,'compile',0,10),scope(2,'compile',0,10)]);
  assert.equal(d.tracks.length,2); assert.notEqual(d.tracks[0].key,d.tracks[1].key);
});
test('captures with multiple processes cannot mix', () => {
  assert.throws(()=>M.trace([scope(1,'work',0,10,1),scope(1,'work',0,10,2)]));
});
test('GPU missing is unknown, never measured zero', () => {assert.equal(M.analyze(capture(),0,40).gpuMs,null);});
test('zero duration frames stay finite', () => {
  const d=M.trace([present(0),present(0),scope(1,'work',0,0)]),s=M.stats(d,16);
  assert.equal(s.count,1);assert.equal(s.fps,null);assert.equal(s.mean,0);
});
test('no frame boundaries allow timeline but no fabricated FPS', () => {
  const d=M.trace([scope(1,'work',1000,4000)]);assert.equal(d.start,1);assert.equal(d.end,5);assert.equal(M.stats(d,16).fps,null);
});
test('invalid trace values are rejected', () => {
  for(const e of [scope(1,'work',0,-1),scope(1,'work',NaN,10),scope(true,'work',0,10),scope(1,{},0,10)]) assert.throws(()=>M.trace([e]));
  assert.throws(()=>M.trace({frames:5}));
});
test('dropped events are retained as a visible limitation', () => {
  const d=M.trace([scope(1,'work',0,10),{ph:'i',name:'trace buffer full',ts:8,tid:1,pid:7,args:{events_lost:4}}]);
  assert.equal(d.incomplete,true);assert.equal(d.losses[0].count,4);
});
test('frame stats use all observations and nearest-rank quantiles', () => {
  const d={type:'trace',frames:[{ms:10},{ms:10},{ms:40}]};const s=M.stats(d,16.667);
  assert.equal(s.fps,50);assert.equal(s.p99,40);assert.equal(s.p50,10);assert.equal(s.over,1);
});
test('large captures avoid argument-stack overflow in stats', () => {
  const d={type:'trace',frames:Array.from({length:200000},()=>({ms:10}))};assert.equal(M.stats(d,16).max,10);
});
test('JSONL preserves Unicode separators inside labels', () => {
  assert.deepEqual(M.jsonl('\ufeff'+JSON.stringify({title:'a\u2028b'})+'\r\n'),[{title:'a\u2028b'}]);
});
test('bad JSONL lines report physical line numbers', () => {
  assert.throws(()=>M.jsonl('{}\n\n{broken'),/3/);assert.throws(()=>M.jsonl('[]'));
});
test('interval identity changes and restarted clocks create separate captures', () => {
  const records=[interval(0,5),interval(5,10),interval(10,15,{commit:'other'}),interval(0,5,{commit:'other'})];
  assert.deepEqual(M.intervals(records,'x.jsonl').map(d=>d.rows.length),[2,1,1]);
});
test('identity object key order cannot create a fake run change', () => {
  assert.equal(M.intervals([interval(0,5,{env:{a:1,b:2}}),interval(5,10,{env:{b:2,a:1}})],'x').length,1);
});
test('host memory capacity changes split captures without implying memory usage', () => {
  const groups=M.intervals([interval(0,5,{memory_mib:32768}),interval(5,10,{memory_mib:65536})],'x');
  assert.equal(groups.length,2);assert.deepEqual(groups[0].frames,[]);
});
test('interval-only data never pretends to contain individual frames', () => {
  const d=M.intervals([interval(0,5)],'x')[0];assert.deepEqual(d.frames,[]);assert.equal(M.stats(d,16),null);
});
test('interval validation rejects corrupt fields without dropping valid zero values', () => {
  for(const extra of [{interval_end_s:-1},{presents:-1},{frame_ms:{p50:30,p90:20,p99:20,max:40}},{worker_busy_pct:null},{gpu_busy_ms_per_present:'0'},{trace_dropped:'true'}]) assert.throws(()=>M.intervals([interval(0,5,extra)],'x'));
  assert.equal(M.intervals([interval(0,0,{presents:0,worker_busy_pct:{worker:125}})],'x')[0].rows[0].presents,0);
});
test('all demo scenarios are explicitly synthetic and have valid coverage', () => {
  for(const mode of ['compile','cpu','gpu','wait']) {
    const d=M.demo(mode);assert.equal(d.demo,true);assert.equal(d.frames.length,150);
    const a=M.analyze(d,d.start,d.end);
    for(const t of a.threads) assert.ok(Math.abs(t.working+t.waiting+t.unknown-a.span)<1e-6);
    assert.ok(a.gpuMs<=a.span+1e-6);
  }
});
test('exported demo cannot lose its synthetic label on reimport', () => {
  const original=M.demo('gpu');const reopened=M.trace(original.document,'example.json');
  assert.equal(reopened.demo,true);assert.equal(reopened.mode,'gpu');assert.ok(reopened.document);
});
