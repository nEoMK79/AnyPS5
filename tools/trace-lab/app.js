(function () {
  'use strict';
  const M = window.TraceLabModel, $ = id => document.getElementById(id);
  const state = {data: null, groups: [], selected: 0, target: 60, zoom: 5, search: '', batch: null, analysis: null, samples: [], chartPoints: [], slowest: [], frameStats: null};
  let loading = null, resizeTimer;
  const names = {compile: 'Shader compilation stutter', cpu: 'Busy thread', gpu: 'Busy GPU', wait: 'Lock contention'};
  const colors = {work: '#72a9ff', wait: '#efbb69', compile: '#bd97f5', memory: '#68d6b0', gpu: '#ed947c', muted: '#9daac0', line: '#283142', cyan: '#69d9e7'};
  const number = (n, decimals = 1) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals});
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
  function svgNode(tag, attrs = {}, text) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  }
  function add(parent, tag, attrs, text) { const n = svgNode(tag, attrs, text); parent.append(n); return n; }
  function tip(text, event) {
    const t = $('tooltip'); t.textContent = text; t.hidden = false;
    const x = event.clientX ?? 20, y = event.clientY ?? 20;
    t.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - t.offsetWidth - 8)) + 'px';
    t.style.top = Math.max(8, Math.min(y + 15, window.innerHeight - t.offsetHeight - 8)) + 'px';
  }
  function hideTip() { $('tooltip').hidden = true; }
  function length() { return !state.data ? 0 : state.data.type === 'trace' ? state.data.frames.length : state.data.rows.length; }
  function select(index) { if (!state.data) return; state.selected = Math.max(0, Math.min(Math.max(0, length() - 1), index)); state.batch = null; hideTip(); render(); }
  function setData(data) {
    state.data = data; state.search = ''; state.batch = null; $('search').value = '';
    const values = data.type === 'trace' ? data.frames.map(f => f.ms) : data.rows.map(r => r.frame_ms.p99);
    state.selected = values.reduce((best, value, i) => value > values[best] ? i : best, 0);
    state.samples = data.type === 'trace' ? data.frames.map((f, i) => ({i, x: f.start, end: f.end, y: f.ms})) : data.rows.map((r, i) => ({i, x: r.interval_start_s * 1000, end: r.interval_end_s * 1000, y: r.frame_ms.p99, other: r.frame_ms.p50}));
    state.chartPoints = thin(state.samples);
    state.slowest = state.samples.slice().sort((a, b) => b.y - a.y).slice(0, 3);
    state.frameStats = M.stats(data, 1000 / state.target);
    $('error').hidden = true; render();
  }
  function showError(error) { $('error').textContent = error.message || String(error); $('error').hidden = false; }
  function setGroups(groups) {
    state.groups = groups;
    const picker = $('capture-picker'); picker.replaceChildren();
    groups.forEach((d, i) => picker.append(el('option', '', `${i + 1} · ${d.filename} · ${String(d.summary?.commit ?? 'trace').slice(0, 10)} · ${number(d.start / 1000)}–${number(d.end / 1000)} s`)));
    [...picker.options].forEach((o, i) => o.value = String(i));
    $('capture-picker-wrap').hidden = groups.length < 2;
    setData(groups[0]);
  }
  function stat(label, value, unit, note) {
    const card = el('div', 'stat'); card.append(el('div', 'stat-label', label));
    const v = el('div', 'stat-value', value); if (unit) v.append(el('small', '', unit));
    card.append(v, el('div', 'stat-note', note)); return card;
  }
  function renderStats() {
    const d = state.data, budget = 1000 / state.target, cards = [];
    $('budget-label').textContent = number(budget, 2) + ' ms';
    if (d.type === 'trace') {
      const s = state.frameStats;
      $('stats-label').textContent = 'Entire capture · ' + number(s.count, 0) + ' complete present intervals';
      cards.push(stat('Average present rate', number(s.fps), 'FPS', 'Frame count / total duration'));
      cards.push(stat('Average frame time', number(s.mean, 2), 'ms', 'Across all complete intervals'));
      cards.push(stat('Median frame time', number(s.p50, 2), 'ms', 'P50 · nearest-rank method'));
      cards.push(stat('99th percentile frame time', number(s.p99, 2), 'ms', 'P99 · slow frames'));
      cards.push(stat('Frames over budget', s.count ? number(100 * s.over / s.count) : '—', '%', `${number(s.over, 0)} of ${number(s.count, 0)} frames`));
    } else {
      const r = d.rows[state.selected], seconds = r.interval_end_s - r.interval_start_s;
      $('stats-label').textContent = `Selected interval · ${number(r.interval_start_s)} to ${number(r.interval_end_s)} s`;
      cards.push(stat('Interval present rate', seconds ? number(r.presents / seconds) : '—', 'FPS', `${number(r.presents, 0)} present`));
      cards.push(stat('Interval median', number(r.frame_ms.p50, 2), 'ms', 'P50 recorded in the file'));
      cards.push(stat('Interval 99th percentile', number(r.frame_ms.p99, 2), 'ms', 'P99 recorded in the file'));
      cards.push(stat('Maximum frame time', number(r.frame_ms.max, 2), 'ms', 'Within this interval'));
      cards.push(stat('GPU time / present', number(r.gpu_busy_ms_per_present, 2), 'ms', 'Batch totals; may overlap'));
    }
    $('stats').replaceChildren(...cards);
  }
  function renderHeader() {
    const d = state.data;
    $('source-name').textContent = d.demo ? (names[d.mode] ?? 'Synthetic demo') : d.filename;
    $('source-badge').textContent = d.demo ? 'Synthetic data' : 'Imported capture';
    $('source-badge').className = 'badge ' + (d.demo ? 'demo' : 'imported');
    $('source-meta').textContent = d.type === 'trace' ? `${number((d.end - d.start) / 1000, 2)} s · ${number(d.tracks.length, 0)} timed tracks · ${number(d.tracks.reduce((n, t) => n + t.events.length, 0), 0)} events` : `${number(d.rows.length, 0)} periodic intervals · ${d.summary.title ?? d.summary.title_id ?? 'Game title not recorded'}`;
    $('warnings').replaceChildren();
    const messages = [...d.warnings];
    if (d.type === 'intervals' && d.incomplete) messages.unshift('At least one interval has incomplete data; values may understate the actual work.');
    $('warnings').hidden = !messages.length;
    if (messages.length) { const list = el('ul'); messages.forEach(m => list.append(el('li', '', m))); $('warnings').append(list); }
    $('footer-meta').textContent = d.demo ? 'Synthetic demo; not a measurement of your game or hardware.' : `commit: ${d.summary?.commit ?? 'not recorded'}${d.summary?.dirty ? ' · dirty' : ''} · local file analysis`;
    $('download-demo').hidden = !d.demo;
  }
  function samplesForChart() {
    return state.samples;
  }
  function thin(points, limit = 900) {
    if (points.length <= limit) return points;
    const step = Math.ceil(points.length / (limit / 2)), out = [];
    for (let i = 0; i < points.length; i += step) {
      const chunk = points.slice(i, i + step);
      const lo = chunk.reduce((a, b) => a.y < b.y ? a : b), hi = chunk.reduce((a, b) => a.y > b.y ? a : b);
      out.push(...(lo.i === hi.i ? [lo] : [lo, hi].sort((a, b) => a.i - b.i)));
    }
    return out;
  }
  function renderFrames() {
    const d = state.data, all = samplesForChart(), points = state.chartPoints, host = $('frame-chart');
    const interval = d.type === 'intervals';
    $('frame-title').textContent = interval ? 'Frame times across summary intervals' : 'Frame time';
    $('frame-subtitle').textContent = interval ? 'Select an interval to inspect its statistics. Percentiles are not averaged across intervals.' : (all.length > points.length ? 'The chart preserves each group’s minimum and maximum. Statistics and frame selection use every sample.' : 'Click the chart to inspect that frame on the timeline.');
    const legend = $('frame-legend'); legend.replaceChildren();
    for (const [cls, label] of [[interval ? 'compile' : 'work', interval ? 'P99' : 'Frame time'], ...(interval ? [['work', 'P50']] : []), ['budget-swatch', 'Display target']]) {
      const s = el('span'); s.append(el('i', cls === 'budget-swatch' ? cls : 'swatch ' + cls), document.createTextNode(label)); legend.append(s);
    }
    host.replaceChildren();
    if (!all.length) { host.append(el('div', 'empty', 'No complete present intervals are available. Inspect the event timeline below.')); }
    else {
      const W = Math.max(520, host.clientWidth - 26), H = 235, left = 49, right = W - 18, top = 22, bottom = 198;
      const minX = d.start, maxX = Math.max(d.end, minX + .001), budget = 1000 / state.target;
      const maxY = Math.max(budget * 1.15, ...points.map(p => p.y * 1.12), 1);
      const x = n => left + (n - minX) / (maxX - minX) * (right - left), y = n => bottom - n / maxY * (bottom - top);
      const s = svgNode('svg', {viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': interval ? 'Interval P99 and P50 chart in milliseconds' : 'Frame time in milliseconds against capture time in seconds'});
      add(s, 'title', {}, 'The selected frame is marked by the bright vertical line.');
      for (let i = 0; i <= 4; i++) {
        const value = maxY * i / 4, yy = y(value);
        add(s, 'line', {x1: left, y1: yy, x2: right, y2: yy, stroke: colors.line, 'stroke-width': 1});
        add(s, 'text', {x: left - 8, y: yy + 3, 'text-anchor': 'end', class: 'tick'}, number(value, 0));
      }
      for (let i = 0; i <= 4; i++) add(s, 'text', {x: x(minX + (maxX - minX) * i / 4), y: bottom + 20, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'tick'}, number((minX + (maxX - minX) * i / 4) / 1000, 2));
      add(s, 'text', {x: left, y: 12, class: 'tick'}, 'ms');
      add(s, 'text', {x: right, y: 233, 'text-anchor': 'end', class: 'tick'}, 'time (s)');
      add(s, 'line', {x1: left, y1: y(budget), x2: right, y2: y(budget), stroke: colors.wait, 'stroke-dasharray': '5 5', opacity: .6});
      if (interval) {
        const p = all[state.selected];
        add(s, 'rect', {x: x(p.x), y: top, width: Math.max(2, x(p.end) - x(p.x)), height: bottom - top, fill: colors.cyan, opacity: .07});
      }
      const drawPath = (key, color) => {
        const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ');
        add(s, 'path', {d: path, fill: 'none', stroke: color, 'stroke-width': 1.7, 'stroke-linejoin': 'round'});
      };
      if (interval) drawPath('other', colors.work);
      drawPath('y', interval ? colors.compile : colors.work);
      const selected = all[state.selected];
      add(s, 'line', {x1: x(selected.x), x2: x(selected.x), y1: top, y2: bottom, stroke: colors.cyan, opacity: .6});
      add(s, 'circle', {cx: x(selected.x), cy: y(selected.y), r: 4, fill: colors.cyan});
      function pointAt(event) {
        const rect = s.getBoundingClientRect(), px = (event.clientX - rect.left) / rect.width * W;
        const ts = minX + Math.max(0, Math.min(1, (px - left) / (right - left))) * (maxX - minX);
        let low = 0, high = all.length - 1;
        while (low < high) { const mid = Math.ceil((low + high) / 2); if (all[mid].x <= ts) low = mid; else high = mid - 1; }
        return all[low];
      }
      s.addEventListener('pointermove', e => { const p = pointAt(e); tip(`${interval ? 'Interval' : 'Frame'} ${interval ? p.i + 1 : d.frames[p.i].id}\n${number(p.y, 2)} ms${interval ? ' · P99' : ''}\n${number(p.x / 1000, 3)} s`, e); });
      s.addEventListener('pointerleave', hideTip);
      s.addEventListener('click', e => select(pointAt(e).i));
      host.append(s);
    }
    const slider = $('frame-slider'); slider.max = Math.max(0, all.length - 1); slider.value = state.selected; slider.disabled = !all.length;
    $('prev-frame').disabled = !all.length || state.selected === 0; $('next-frame').disabled = !all.length || state.selected === all.length - 1;
    $('selection-label').textContent = all.length ? (interval ? `interval ${state.selected + 1} / ${all.length}` : `frame ${d.frames[state.selected].id} · ${number(d.frames[state.selected].ms, 2)} ms`) : 'no frame boundaries';
    const slow = $('slow-buttons'); slow.replaceChildren();
    state.slowest.forEach(p => { const b = el('button', p.i === state.selected ? 'selected' : '', `${number(p.y)} ms`); b.title = interval ? `Interval ${p.i + 1}` : `Frame ${d.frames[p.i].id}`; b.onclick = () => select(p.i); slow.append(b); });
  }
  function bounds() {
    const d = state.data;
    if (!d.frames.length || !state.zoom) return [d.start, d.end];
    const half = Math.floor(state.zoom / 2), first = Math.max(0, state.selected - half), last = Math.min(d.frames.length - 1, state.selected + half);
    return [d.frames[first].start, d.frames[last].end];
  }
  function matches(t, e) { const q = state.search.toLowerCase(); return !q || t.name.toLowerCase().includes(q) || e.name.toLowerCase().includes(q); }
  function eventDetails(t, e, a) {
    state.batch = e.batch;
    const detail = $('event-detail'); detail.replaceChildren();
    const strong = el('strong', '', e.name); strong.dir = 'ltr';
    detail.append(strong, document.createTextNode(` · ${t.name} [${t.tid}] · full scope: ${number(e.end - e.start, 3)} ms · in range: ${number(Math.max(0, Math.min(e.end, a.end) - Math.max(e.start, a.begin)), 3)} ms`));
    if (e.batch !== null) { detail.append(document.createTextNode(` · batch ${String(e.batch)} · Events in this batch are highlighted. `)); const clear = el('button', 'text-button', 'Clear highlight'); clear.onclick = () => { state.batch = null; renderTimeline(a); detail.textContent = 'Select an event bar to inspect its details.'; }; detail.append(clear); }
    renderTimeline(a);
  }
  function renderTimeline(a) {
    const host = $('timeline'); host.replaceChildren();
    const d = state.data;
    $('zoom').disabled = d.type !== 'trace'; $('search').disabled = d.type !== 'trace';
    if (d.type !== 'trace') {
      const row = d.rows[state.selected];
      $('timeline-subtitle').textContent = `${number(row.interval_start_s, 3)} to ${number(row.interval_end_s, 3)} s · event details unavailable`;
      host.append(el('div', 'empty', 'Only periodic summaries were imported. Open an aps5-trace file to inspect concurrent events.')); $('event-detail').textContent = 'Periodic summaries do not provide individual events or call stacks.'; return;
    }
    $('timeline-subtitle').textContent = `${number(a.begin / 1000, 3)} to ${number(a.end / 1000, 3)} s · threads with matching names keep separate IDs`;
    const tracks = a.threads.map(t => ({t, events: t.events.filter(e => e.start < a.end && e.end > a.begin && matches(t, e))})).filter(row => row.events.length);
    const count = tracks.reduce((n, row) => n + row.events.length, 0);
    if (count > 3000) { host.append(el('div', 'empty', `${number(count, 0)} events in this range. Zoom to 1 or 5 frames, or search for an event. Statistics still include every event.`)); return; }
    if (!tracks.length) { host.append(el('div', 'empty', 'No events match this range and filter.')); return; }
    const W = Math.max(820, host.clientWidth - 20), left = 188, right = W - 16, span = Math.max(.001, a.span), x = n => left + (n - a.begin) / span * (right - left);
    const s = svgNode('svg', {viewBox: `0 0 ${W} 300`, role: 'img', 'aria-label': 'Timeline: each lane is a separate thread; bars show elapsed time.'});
    s.style.minWidth = W + 'px'; host.style.maxHeight = '570px'; host.style.overflow = 'auto';
    let yy = 36;
    for (let i = 0; i <= 4; i++) add(s, 'text', {x: x(a.begin + a.span * i / 4), y: 17, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'tick'}, number((a.begin + a.span * i / 4) / 1000, 3) + ' s');
    for (const {t, events} of tracks) {
      const minDepth = Math.min(...events.map(e => e.depth)), depth = Math.max(...events.map(e => e.depth)) - minDepth;
      const height = Math.max(46, 26 + (depth + 1) * 17);
      add(s, 'line', {x1: 8, y1: yy - 7, x2: right, y2: yy - 7, stroke: colors.line});
      const label = add(s, 'text', {x: 8, y: yy + 8, class: 'lane-name'}, t.name.length > 23 ? t.name.slice(0, 21) + '…' : t.name);
      add(label, 'title', {}, t.name);
      add(s, 'text', {x: 8, y: yy + 24, class: 'tick'}, `tid ${t.tid} · ${number(t.recorded, 2)} ms`);
      const frame = d.frames[state.selected];
      if (frame) add(s, 'rect', {x: x(Math.max(frame.start, a.begin)), y: yy - 3, width: Math.max(0, x(Math.min(frame.end, a.end)) - x(Math.max(frame.start, a.begin))), height: height - 8, fill: colors.cyan, opacity: .055, 'pointer-events': 'none'});
      for (const e of events) {
        const bx = x(Math.max(a.begin, e.start)), width = Math.max(.8, x(Math.min(a.end, e.end)) - bx), by = yy + (e.depth - minDepth) * 17;
        const opacity = state.batch !== null && e.batch !== state.batch ? .20 : e.depth === minDepth && !t.gpu ? .60 : .92;
        const rect = add(s, 'rect', {x: bx, y: by, width, height: 13, rx: 2, fill: colors[e.kind], opacity, class: 'event-bar', tabindex: 0, role: 'button', 'aria-label': `${e.name}, ${t.name}, ${number(e.end - e.start, 3)} ms`});
        const tooltip = `${e.name}\n${t.name} [${t.tid}]\n${number(e.end - e.start, 3)} ms${e.batch !== null ? '\nbatch ' + String(e.batch) : ''}`;
        rect.addEventListener('pointermove', ev => tip(tooltip, ev)); rect.addEventListener('pointerleave', hideTip);
        rect.addEventListener('click', () => { hideTip(); eventDetails(t, e, a); });
        rect.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); eventDetails(t, e, a); } });
        if (width > 65) add(s, 'text', {x: bx + 4, y: by + 10, class: 'event-label'}, e.name.slice(0, Math.max(0, Math.floor((width - 10) / 5.6))));
      }
      yy += height;
    }
    s.setAttribute('viewBox', `0 0 ${W} ${yy + 4}`); s.style.height = yy + 4 + 'px'; host.append(s);
  }
  function insight(title, body, evidence, kind) {
    const item = el('div', 'insight'), label = el('div', 'insight-label'); label.append(el('i', 'swatch ' + kind), document.createTextNode(title)); item.append(label, el('p', '', body));
    if (evidence) item.append(el('div', 'evidence', evidence)); return item;
  }
  function renderInsights(a) {
    const box = $('insights'); box.replaceChildren(); const d = state.data;
    if (d.type === 'intervals') {
      const r = d.rows[state.selected]; $('investigation-range').textContent = `Interval ${state.selected + 1} · ${number(r.interval_end_s - r.interval_start_s)} s`;
      box.append(insight('Frame time variation', 'A large gap between the median and P99 identifies a useful interval for a detailed trace.', `P50 ${number(r.frame_ms.p50)} · P99 ${number(r.frame_ms.p99)} ms`, 'compile'));
      box.append(insight('Investigating a bottleneck', 'This file does not contain execution order or wait locations. Expensive phases provide a starting point for investigation.', '', 'work')); return;
    }
    $('investigation-range').textContent = `${number(a.span, 2)} ms of the capture`;
    const compile = a.phases.filter(p => p.kind === 'compile')[0];
    const waiter = a.threads.filter(t => !t.gpu).sort((x, y) => y.waiting - x.waiting)[0];
    const worker = a.threads.filter(t => !t.gpu).sort((x, y) => y.working - x.working)[0];
    if (compile && compile.ms > a.span * .20) box.append(insight('Compilation overlaps this range', 'Substantial compilation time was recorded in this range. Capture the same scene again with a warm cache to investigate caching effects.', `${compile.name} · ${number(compile.ms)} ms`, 'compile'));
    if (waiter && waiter.waiting > a.span * .25) box.append(insight('Wait time to investigate', 'Inspect the wait events on the timeline. Waiting for a lock, the GPU or new work can have different causes.', `${waiter.name} · ${number(waiter.waiting)} ms wait`, 'wait'));
    if (a.gpuMs !== null && a.span && a.gpuMs / a.span > .80) box.append(insight('High GPU activity coverage', 'Recorded GPU activity covers much of this range. Correlation alone does not establish the cause of a slow frame.', `${number(a.gpuMs)} / ${number(a.span)} ms`, 'gpu'));
    else if (worker && worker.working > a.span * .50) box.append(insight('Long scopes on one thread', 'Inspect this thread for long-running work. Scope duration can also include time spent descheduled by the operating system.', `${worker.name} · ${number(worker.working)} ms`, 'work'));
    if (a.gpuMs === null) box.append(insight('GPU data unavailable', 'This capture cannot establish GPU idleness. Only the recorded execution paths can be inspected.', '', 'gpu'));
    if (!box.children.length) box.append(insight('Start with a slow frame', 'Select one of the slowest frames and inspect long scopes. This range does not provide a clear indication of a specific cause.', '', 'work'));
    if (d.incomplete) box.append(insight('Incomplete evidence', 'Events were dropped from this capture. Measurements include only the remaining data.', '', 'wait'));
  }
  function threadBar(name, value, work, wait, unknown, gpu) {
    const row = el('div', 'thread-row'), heading = el('div', 'thread-label'); heading.append(el('span', 'name', name), el('span', 'value', value));
    const track = el('div', 'track'); track.setAttribute('role', 'img'); track.setAttribute('aria-label', `${name}: ${value}`);
    for (const [amount, color] of [[work, gpu ? 'gpu' : 'work'], [wait, 'wait'], [unknown, 'unknown']]) { const bar = el('span', color); bar.style.width = Math.max(0, amount) + '%'; track.append(bar); }
    row.append(heading, track); return row;
  }
  function renderTables(a) {
    const d = state.data, bars = $('thread-bars'), rows = $('hot-rows'); bars.replaceChildren(); rows.replaceChildren();
    let phases;
    if (d.type === 'trace') {
      $('occupancy-title').textContent = 'Recorded time per thread'; $('occupancy-subtitle').textContent = 'Selected range; overlapping time is counted once.';
      $('hot-time-heading').textContent = 'Time in range'; $('hot-subtitle').textContent = 'Includes child scopes; rows do not add up to a frame cost. Search filters only this table and the timeline.';
      for (const t of a.threads) bars.append(threadBar(`${t.name} [${t.tid}]`, `${number(t.working)} work · ${number(t.waiting)} wait ms`, a.span ? t.working / a.span * 100 : 0, a.span ? t.waiting / a.span * 100 : 0, a.span ? t.unknown / a.span * 100 : 100, t.gpu));
      const query = state.search.toLowerCase();
      const matchingNames = query ? new Set(d.tracks.filter(t => t.name.toLowerCase().includes(query)).flatMap(t => t.events.map(e => e.name))) : null;
      phases = a.phases.filter(p => !query || p.name.toLowerCase().includes(query) || matchingNames.has(p.name));
    } else {
      const r = d.rows[state.selected], workers = Object.entries(r.worker_busy_pct ?? {}).sort((x, y) => y[1] - x[1]);
      const scale = workers.reduce((maximum, worker) => Math.max(maximum, worker[1]), 100);
      $('occupancy-title').textContent = 'Worker occupancy in recorded scopes'; $('occupancy-subtitle').textContent = `May include waits; this is not CPU utilization. Chart scale: 0–${number(scale, 0)}%.`;
      $('hot-time-heading').textContent = 'ms / frame'; $('hot-subtitle').textContent = 'Only phases listed in the summary are shown. An omitted phase may still have a cost.';
      for (const [name, value] of workers) bars.append(threadBar(name, number(value) + '%', value / scale * 100, 0, 100 - value / scale * 100, false));
      if (!workers.length) bars.append(el('div', 'empty', 'No worker statistics were recorded for this interval.'));
      phases = Object.entries(r.top_phases_ms_per_frame ?? {}).map(([name, ms]) => ({name, ms, kind: M.category(name, false), calls: null})).sort((x, y) => y.ms - x.ms);
    }
    document.querySelector('.bottom-legend').hidden = d.type !== 'trace';
    if (!phases.length) { const tr = el('tr'), td = el('td', 'muted', 'No events to display.'); td.colSpan = 3; tr.append(td); rows.append(tr); }
    for (const phase of phases.slice(0, 10)) { const tr = el('tr'), name = el('td'), scope = el('span', 'scope-name'); scope.append(el('i', 'swatch ' + phase.kind), document.createTextNode(phase.name)); name.append(scope); tr.append(name, el('td', '', number(phase.ms, 2) + ' ms'), el('td', '', phase.calls === null ? '—' : number(phase.calls, 0))); rows.append(tr); }
  }
  function render() {
    updateSession();
    if (!state.data) return;
    renderHeader(); renderStats(); renderFrames();
    const d = state.data;
    if (d.type === 'trace') { const [begin, end] = bounds(); state.analysis = M.analyze(d, begin, end); }
    else state.analysis = null;
    $('event-detail').textContent = 'Select an event bar to inspect its details.';
    renderTimeline(state.analysis); renderInsights(state.analysis); renderTables(state.analysis);
  }
  function updateSession() {
    const busy = Boolean(loading), loaded = Boolean(state.data);
    $('open-files').disabled = busy;
    $('open-files').textContent = busy ? 'Reading capture…' : 'Open capture';
    $('stop-analysis').disabled = !busy && !loaded;
    $('session-status').textContent = busy ? 'Loading saved capture' : loaded ? 'Capture loaded · on-demand analysis' : 'Analyzer idle';
    $('session-note').textContent = busy ? 'Stop & unload cancels parsing and releases the current capture.' : loaded ? 'No game monitoring. Calculations update when you use the controls.' : 'Saved files only. No game is being monitored.';
    $('analysis-view').hidden = !loaded;
    $('analysis-view').inert = busy;
    $('empty-state').hidden = loaded || busy;
    $('capture-picker').disabled = busy;
  }
  function finishLoading(job) {
    job.worker?.terminate();
    if (job.url) URL.revokeObjectURL(job.url);
    if (loading === job) loading = null;
    job.resolve();
    updateSession();
  }
  function stopLoading() {
    if (loading) finishLoading(loading);
  }
  function stopAnalysis() {
    stopLoading(); clearTimeout(resizeTimer); hideTip();
    state.data = state.analysis = state.batch = state.frameStats = null;
    state.groups = []; state.samples = []; state.chartPoints = []; state.slowest = [];
    state.selected = 0; state.search = '';
    for (const id of ['stats', 'frame-chart', 'timeline', 'thread-bars', 'hot-rows', 'insights', 'slow-buttons', 'capture-picker', 'warnings', 'event-detail', 'tooltip']) $(id).replaceChildren();
    $('source-name').textContent = 'No capture loaded'; $('source-meta').textContent = 'Open a saved capture or load a synthetic demo.';
    $('source-badge').textContent = 'Idle'; $('source-badge').className = 'badge neutral';
    $('footer-meta').textContent = 'Offline analysis · no capture loaded';
    $('search').value = ''; $('file-input').value = '';
    for (const id of ['error', 'warnings', 'capture-picker-wrap', 'download-demo']) $(id).hidden = true;
    $('error').textContent = '';
    updateSession();
  }
  function loadFiles(fileList) {
    const files = Array.from(fileList); if (!files.length) return Promise.resolve();
    stopLoading(); hideTip(); $('error').hidden = true;
    return new Promise(resolve => {
      const job = {resolve, worker: null, url: null}; loading = job; updateSession();
      try {
        const code = $('trace-model').textContent + '\n' + $('trace-loader').textContent;
        job.url = URL.createObjectURL(new Blob([code], {type: 'text/javascript'}));
        job.worker = new Worker(job.url);
        job.worker.onmessage = ({data}) => {
          if (loading !== job) return;
          finishLoading(job);
          try { if (data.error) throw new Error(data.error); setGroups(data.groups); }
          catch (error) { showError(error); }
        };
        job.worker.onerror = event => {
          event.preventDefault();
          if (loading !== job) return;
          finishLoading(job); showError(new Error(event.message || 'The capture could not be loaded.'));
        };
        job.worker.onmessageerror = () => {
          if (loading !== job) return;
          finishLoading(job); showError(new Error('The parsed capture could not be transferred. Use a shorter capture.'));
        };
        job.worker.postMessage(files);
      } catch (error) {
        finishLoading(job); showError(error);
      }
      $('file-input').value = '';
    });
  }
  function captureSetup() {
    const mode = $('capture-mode').value, active = mode !== 'off';
    $('capture-delay').disabled = mode !== 'timed';
    $('capture-events').disabled = $('capture-gpu').disabled = !active;
    const delay = $('capture-delay');
    if (mode === 'timed' && !delay.checkValidity()) {
      $('launch-command').textContent = 'Enter a whole-number delay from 0 through 86400 seconds.';
      $('copy-launch').disabled = true; return;
    }
    $('copy-launch').disabled = false;
    let command = "python 'C:\\path\\AnyPS5\\tools\\trace-lab\\capture.py' launch --mode " + mode;
    if (active) {
      command += ' --seconds 15 --events ' + $('capture-events').value;
      if (mode === 'timed') command += ' --delay ' + Number(delay.value);
      if ($('capture-gpu').checked) command += ' --gpu-details';
    }
    $('launch-command').textContent = command + " -- '.\\app.exe'";
    $('capture-explanation').textContent = mode === 'off' ? 'Off clears inherited trace and GPU profiling settings for the new game process. It leaves your shell environment unchanged.' : mode === 'manual' ? 'Launch armed. The launcher prints a trigger command; run it in another terminal when the scene is ready. AnyPS5 then records one 15-second window. Use a local output directory.' : 'AnyPS5 records one 15-second window after the chosen delay from its first present.';
    $('copy-status').textContent = '';
  }
  async function copyLaunch() {
    const text = $('launch-command').textContent;
    try {
      await navigator.clipboard.writeText(text);
      $('copy-status').textContent = 'Command copied.';
    } catch {
      const range = document.createRange(); range.selectNodeContents($('launch-command'));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      $('copy-status').textContent = 'Command selected. Press Ctrl+C to copy.';
    }
  }
  function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json;charset=utf-8'}), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  $('open-files').onclick = () => $('file-input').click();
  $('file-input').onchange = e => loadFiles(e.target.files);
  $('help-toggle').onclick = () => { $('capture-help').hidden = !$('capture-help').hidden; $('help-toggle').setAttribute('aria-expanded', String(!$('capture-help').hidden)); };
  $('load-demo').onclick = () => { stopLoading(); setGroups([M.demo($('demo-mode').value)]); };
  $('stop-analysis').onclick = stopAnalysis;
  $('capture-picker').onchange = e => setData(state.groups[Number(e.target.value)]);
  $('target').onchange = e => { state.target = Number(e.target.value); if (state.frameStats) state.frameStats.over = state.data.frames.reduce((total, frame) => total + (frame.ms > 1000 / state.target ? 1 : 0), 0); render(); };
  $('zoom').onchange = e => { state.zoom = Number(e.target.value); state.batch = null; render(); };
  $('search').oninput = e => { if (!state.data) return; state.search = e.target.value.trim(); renderTimeline(state.analysis); renderTables(state.analysis); };
  $('frame-slider').oninput = e => select(Number(e.target.value));
  $('prev-frame').onclick = () => select(state.selected - 1); $('next-frame').onclick = () => select(state.selected + 1);
  $('frame-chart').onkeydown = e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); select(state.selected + (e.key === 'ArrowRight' ? 1 : -1)); } };
  $('download-demo').onclick = () => download(`anyps5-synthetic-${state.data.mode}.json`, state.data.document);
  $('export-report').onclick = () => {
    const d = state.data; if (!d) return;
    const report = {format: 'trace-lab/1', source: d.filename, synthetic: d.demo, target_fps: state.target, warnings: d.warnings, incomplete: d.incomplete, identity: d.summary};
    if (d.type === 'trace') { const a = state.analysis; report.capture = M.stats(d, 1000 / state.target); report.range_ms = [a.begin, a.end]; report.threads = a.threads.map(t => ({name: t.name, tid: t.tid, work_scope_ms: t.working, wait_scope_ms: t.waiting, untraced_ms: t.unknown})); report.inclusive_phases = a.phases; }
    else report.interval = d.rows[state.selected];
    download('anyps5-inspection.json', report);
  };
  const drop = $('drop-zone');
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('drag'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, e => { e.preventDefault(); drop.classList.remove('drag'); });
  drop.addEventListener('drop', e => loadFiles(e.dataTransfer.files));
  window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); if (state.data && !loading) resizeTimer = setTimeout(render, 150); });
  for (const id of ['capture-mode', 'capture-delay', 'capture-events', 'capture-gpu']) $(id).addEventListener('input', captureSetup);
  $('copy-launch').onclick = copyLaunch;
  captureSetup(); stopAnalysis();
  window.TraceLabApp = {loadFiles, stopAnalysis, getData: () => state.data, getAnalysis: () => state.analysis, getStatus: () => loading ? 'loading' : state.data ? 'loaded' : 'idle'};
})();
