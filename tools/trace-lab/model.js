(function (root) {
  'use strict';
  const MAX_EVENTS = 500000;
  const finite = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e15;
  function requireValue(ok, message) { if (!ok) throw new Error(message); }
  function union(ranges) {
    const sorted = ranges.filter(r => r[1] > r[0]).map(r => [r[0], r[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push(r);
    }
    return out;
  }
  function measure(ranges, start, end) {
    let value = 0;
    for (const [a, b] of ranges) {
      if (a >= end) break;
      value += Math.max(0, Math.min(b, end) - Math.max(a, start));
    }
    return value;
  }
  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  }
  function category(name, gpu) {
    if (gpu) return 'gpu';
    if (/wait/i.test(name)) return 'wait';
    if (/compil|spirv|translate/i.test(name)) return 'compile';
    if (/copy|upload|readback|import|memory|alloc/i.test(name)) return 'memory';
    return 'work';
  }
  function summaryFor(records, filename) {
    const alias = filename.endsWith('.gz') ? filename.slice(0, -3) : filename + '.gz';
    for (const name of [filename, alias]) {
      const found = records.filter(r => r && r.trace === name && !Object.hasOwn(r, 'interval_start_s'));
      if (found.length) return found[found.length - 1];
    }
    return null;
  }
  function trace(document, filename = 'capture.json', records = []) {
    const events = Array.isArray(document) ? document : document?.traceEvents;
    requireValue(Array.isArray(events), 'The file must be an event array or a Chrome trace containing traceEvents.');
    requireValue(events.length <= MAX_EVENTS, 'The trace exceeds 500,000 events. Import a shorter capture.');
    const threads = new Map(), presents = [], pids = new Set(), losses = [];
    let folded = false;
    function threadFor(e, i) {
      requireValue(Number.isInteger(e.tid), `Event ${i + 1}: invalid thread ID.`);
      const pid = e.pid ?? 0;
      requireValue(Number.isInteger(pid) || typeof pid === 'string', `Event ${i + 1}: invalid process ID.`);
      const key = JSON.stringify([pid, e.tid]);
      pids.add(pid);
      if (!threads.has(key)) threads.set(key, {key, tid: e.tid, pid, name: `thread ${e.tid}`, events: []});
      return threads.get(key);
    }
    events.forEach((e, i) => {
      requireValue(e && typeof e === 'object' && !Array.isArray(e), `Event ${i + 1}: invalid event structure.`);
      if (e.ph === 'M' && e.name === 'thread_name') {
        requireValue(typeof e.args?.name === 'string', `Event ${i + 1}: invalid thread name.`);
        threadFor(e, i).name = e.args.name;
      } else if (e.ph === 'X') {
        requireValue(finite(e.ts) && finite(e.dur) && e.dur >= 0 && finite(e.ts + e.dur) && typeof e.name === 'string', `Event ${i + 1}: invalid timestamp, duration or name.`);
        threadFor(e, i).events.push({start: e.ts / 1000, end: (e.ts + e.dur) / 1000, name: e.name, batch: e.args?.batch ?? null});
      } else if (e.ph === 'i' && e.name === 'present') {
        requireValue(finite(e.ts), `Event ${i + 1}: invalid present timestamp.`);
        threadFor(e, i);
        presents.push({start: e.ts / 1000, id: e.args?.present ?? presents.length});
      } else if (e.ph === 'i' && e.name === 'trace buffer full') {
        requireValue(finite(e.ts) && Number.isInteger(e.args?.events_lost) && e.args.events_lost >= 0, `Event ${i + 1}: invalid lost-event count.`);
        const t = threadFor(e, i);
        if (e.args.events_lost) losses.push({thread: t.key, at: e.ts / 1000, count: e.args.events_lost});
      } else if (e.ph === 'C') folded = true;
    });
    requireValue(pids.size <= 1, 'This file contains multiple processes. Import a trace from one game process to keep timings separate.');
    presents.sort((a, b) => a.start - b.start);
    const summary = summaryFor(records, filename);
    const warnings = [];
    if (records.length && !summary) warnings.push('No summary matches this trace filename. Summary metadata was not assigned to this capture.');
    let stop = presents.length ? presents[presents.length - 1].start : null;
    if (summary) {
      requireValue(finite(summary.window?.ms) && summary.window.ms >= 0, 'The companion summary has an invalid window duration.');
      requireValue(stop === null || summary.window.ms >= stop, 'The summary ends before the final present. These files are inconsistent.');
      stop = summary.window.ms;
    }
    const frames = [];
    for (let i = 0; i < presents.length; i++) {
      const end = i + 1 < presents.length ? presents[i + 1].start : stop;
      if (i + 1 < presents.length || end > presents[i].start) frames.push({...presents[i], end, ms: end - presents[i].start});
    }
    const tracks = [...threads.values()].filter(t => t.events.length);
    for (const t of tracks) {
      t.gpu = t.name.toLowerCase() === 'gpu';
      t.events.sort((a, b) => a.start - b.start || b.end - a.end);
      const stack = [];
      for (const e of t.events) {
        while (stack.length && e.start >= stack[stack.length - 1].end) stack.pop();
        e.depth = stack.length;
        e.kind = category(e.name, t.gpu);
        stack.push(e);
      }
      t.ranges = union(t.events.map(e => [e.start, e.end]));
      t.waits = union(t.events.filter(e => e.kind === 'wait').map(e => [e.start, e.end]));
    }
    const bounds = tracks.flatMap(t => t.ranges);
    const start = frames.length ? frames[0].start : bounds.reduce((n, r) => Math.min(n, r[0]), Infinity);
    const end = frames.length ? frames[frames.length - 1].end : bounds.reduce((n, r) => Math.max(n, r[1]), -Infinity);
    requireValue(Number.isFinite(start) && Number.isFinite(end), 'This trace contains no complete frames or timed events.');
    if (!frames.length) warnings.push('Two presents or a valid end boundary are unavailable. Frame rate and percentiles were not calculated.');
    if (!summary && frames.length) warnings.push('The frame after the final present was excluded because no companion summary is available.');
    if (!tracks.some(t => t.gpu)) warnings.push('This capture has no GPU timeline. GPU underutilization or idleness cannot be inferred.');
    if (folded) warnings.push('Folded short events have no exact positions and are omitted from the timeline bars.');
    const incomplete = losses.length > 0 || summary?.trace_dropped === true;
    if (incomplete) warnings.unshift('Some events were not recorded. Bars and timings show only the remaining data.');
    const synthetic = !Array.isArray(document) && document.traceLab?.synthetic === true;
    return {type: 'trace', filename, summary, frames, tracks, start, end, warnings, losses, incomplete, demo: synthetic,
      mode: synthetic ? document.traceLab.mode : undefined, document: synthetic ? document : undefined};
  }
  function jsonl(text) {
    return text.replace(/^\uFEFF/, '').split('\n').flatMap((line, i) => {
      if (!line.trim()) return [];
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`Line ${i + 1}: invalid JSON. Record the incomplete capture again.`); }
      requireValue(row && typeof row === 'object' && !Array.isArray(row), `Line ${i + 1}: each record must be an object.`);
      return [row];
    });
  }
  const identityKeys = ['commit', 'dirty', 'gpu', 'driver', 'os', 'cpu', 'cpu_threads', 'memory_mib', 'resolution', 'title_id', 'title', 'content_version', 'env'];
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
  }
  function intervals(records, filename) {
    const rows = records.filter(r => Object.hasOwn(r, 'interval_start_s'));
    requireValue(rows.length, 'This file has no periodic interval records. Open it with its trace file.');
    const segments = [];
    let previous = null, identity = null;
    for (const [i, row] of rows.entries()) {
      requireValue(finite(row.interval_start_s) && finite(row.interval_end_s) && row.interval_start_s >= 0 && row.interval_end_s >= row.interval_start_s, `Interval ${i + 1}: invalid start or end time.`);
      requireValue(Number.isInteger(row.presents) && row.presents >= 0, `Interval ${i + 1}: invalid present count.`);
      const q = ['p50', 'p90', 'p99', 'max'].map(k => row.frame_ms?.[k]);
      requireValue(q.every(n => finite(n) && n >= 0) && q.every((n, j) => j === 0 || n >= q[j - 1]), `Interval ${i + 1}: frame time percentiles are invalid or out of order.`);
      requireValue(finite(row.gpu_busy_ms_per_present) && row.gpu_busy_ms_per_present >= 0, `Interval ${i + 1}: invalid GPU time.`);
      for (const field of ['worker_busy_pct', 'top_phases_ms_per_frame']) {
        const entries = Object.hasOwn(row, field) ? row[field] : {};
        requireValue(entries && typeof entries === 'object' && !Array.isArray(entries) && Object.values(entries).every(n => finite(n) && n >= 0), `Interval ${i + 1}: invalid ${field}.`);
      }
      requireValue(!Object.hasOwn(row, 'trace_dropped') || typeof row.trace_dropped === 'boolean', `Interval ${i + 1}: invalid dropped-event status.`);
      const id = JSON.stringify(canonical(Object.fromEntries(identityKeys.map(k => [k, row[k] ?? null]))));
      if (!previous || id !== identity || row.interval_start_s < previous.interval_end_s) segments.push([]);
      segments[segments.length - 1].push(row);
      previous = row; identity = id;
    }
    return segments.map((part, index) => ({type: 'intervals', filename, rows: part, summary: part[0], start: part[0].interval_start_s * 1000,
      end: part[part.length - 1].interval_end_s * 1000, incomplete: part.some(r => r.trace_dropped === true), tracks: [], frames: [], demo: false,
      warnings: ['This file contains only periodic summaries. Thread timelines and individual frames cannot be reconstructed.', 'worker_busy_pct measures scope occupancy and may include waits; it is not measured CPU utilization.', ...(segments.length > 1 ? [`The file was split into ${segments.length} independent segments. Segment ${index + 1} is selected.`] : [])]}));
  }
  function stats(data, budget) {
    if (data.type === 'intervals') return null;
    const times = data.frames.map(f => f.ms);
    const elapsed = times.reduce((n, x) => n + x, 0);
    return {count: times.length, fps: elapsed > 0 ? 1000 * times.length / elapsed : null, mean: times.length ? elapsed / times.length : null,
      p50: percentile(times, .5), p99: percentile(times, .99), max: times.length ? times.reduce((a, b) => Math.max(a, b), 0) : null,
      over: times.filter(t => t > budget).length};
  }
  function analyze(data, begin, end) {
    const span = Math.max(0, end - begin), phases = new Map();
    const threads = data.tracks.map(t => {
      const recorded = measure(t.ranges, begin, end), waiting = measure(t.waits, begin, end);
      let calls = 0;
      for (const e of t.events) {
        if (e.start >= end) break;
        const overlap = Math.max(0, Math.min(e.end, end) - Math.max(e.start, begin));
        if (overlap <= 0) continue;
        calls++;
        const key = JSON.stringify([t.gpu, e.name]);
        if (!phases.has(key)) phases.set(key, {name: e.name, kind: e.kind, ms: 0, calls: 0, max: 0, threads: new Set()});
        const entry = phases.get(key);
        entry.ms += overlap; entry.calls++; entry.max = Math.max(entry.max, overlap); entry.threads.add(t.key);
      }
      return {...t, recorded, waiting, working: Math.max(0, recorded - waiting), unknown: Math.max(0, span - recorded), calls};
    });
    const gpuRanges = union(data.tracks.filter(t => t.gpu).flatMap(t => t.ranges));
    return {begin, end, span, threads, gpuMs: data.tracks.some(t => t.gpu) ? measure(gpuRanges, begin, end) : null,
      phases: [...phases.values()].sort((a, b) => b.ms - a.ms).map(p => ({...p, threads: p.threads.size}))};
  }
  function demo(mode = 'compile') {
    const events = [], names = ['queue worker 0x0', 'draw committer', 'shader prepare', 'presenter', 'gpu', 'shader prepare'];
    names.forEach((name, i) => events.push({ph: 'M', name: 'thread_name', pid: 1, tid: i + 1, args: {name}}));
    function add(tid, name, start, dur, batch) { events.push({ph: 'X', pid: 1, tid, name, ts: Math.round(start * 1000), dur: Math.round(dur * 1000), args: {batch}}); }
    let time = 0;
    for (let i = 0; i < 150; i++) {
      const spike = mode === 'compile' && [37, 78, 113].includes(i);
      let duration = 15.1 + (Math.sin(i * .48) + 1) * 1.5;
      if (mode === 'cpu') duration += 9 + Math.sin(i * .13) * 2;
      if (mode === 'gpu') duration += 14 + Math.sin(i * .12) * 2;
      if (mode === 'wait' && i > 43 && i < 84) duration += 20;
      if (spike) duration = 67 + (i % 3) * 9;
      events.push({ph: 'i', name: 'present', pid: 1, tid: 4, ts: Math.round(time * 1000), args: {present: 600 + i}});
      add(1, 'Driver.WorkerWait', time, duration * .12, i);
      add(1, 'Driver.Packet', time + duration * .12, duration * (mode === 'cpu' ? .84 : .55), i);
      add(1, 'Driver.Packet.draw', time + duration * .18, duration * .26, i);
      add(2, 'Graphics.Draw', time + duration * .15, duration * (mode === 'cpu' ? .80 : .5), i);
      add(2, 'Buffer.UploadCopy', time + duration * .20, duration * .10, i);
      if (mode === 'wait' && i > 43 && i < 84) add(1, 'GpuMutex.wait.draw', time + duration * .2, duration * .44, i);
      if (spike) {
        add(3, 'Shader.Compile', time + .4, duration * .88, i);
        add(6, 'Pipeline.Compile', time + 2.5, duration * .61, i);
        add(2, 'Pipeline.wait', time + duration * .22, duration * .40, i);
      }
      add(4, 'Driver.Present', time + duration * .75, duration * .22, i);
      add(4, 'Driver.Present.inflight_wait', time + duration * .76, duration * .15, i);
      const gpuStart = mode === 'gpu' ? .02 : .60, gpuShare = mode === 'gpu' ? .94 : (spike ? .14 : .32);
      add(5, 'batch', time + duration * gpuStart, duration * gpuShare, i);
      add(5, 'draw', time + duration * (gpuStart + .01), duration * gpuShare * .8, i);
      add(5, 'copy', time + duration * (gpuStart + gpuShare * .8), duration * gpuShare * .14, i);
      time += duration;
    }
    events.push({ph: 'i', name: 'present', pid: 1, tid: 4, ts: Math.round(time * 1000), args: {present: 750}});
    const document = {traceLab: {synthetic: true, mode}, traceEvents: events};
    const data = trace(document, `demo-${mode}.json`);
    data.demo = true; data.mode = mode; data.document = document;
    data.warnings = data.warnings.filter(w => !w.startsWith('The frame after the final present'));
    return data;
  }
  const api = {union, measure, percentile, category, summaryFor, trace, jsonl, intervals, stats, analyze, demo};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TraceLabModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
