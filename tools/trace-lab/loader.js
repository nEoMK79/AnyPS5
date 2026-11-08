(function () {
  'use strict';
  const M = self.TraceLabModel;
  async function readFile(file) {
    const cap = 64 * 1024 * 1024;
    if (file.size > cap) throw new Error('The file exceeds 64 MiB. Import a shorter capture.');
    let stream = file.stream();
    if (/\.gz$/i.test(file.name)) {
      if (!self.DecompressionStream) throw new Error('This browser cannot decompress gzip. Use an uncompressed JSON file or a newer browser.');
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    const reader = stream.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
    let bytes = 0, text = '';
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > cap) throw new Error('The decompressed file exceeds 64 MiB. Import a shorter capture.');
        text += decoder.decode(value, {stream: true});
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  self.onmessage = async ({data: files}) => {
    try {
      if (files.length > 8) throw new Error('Select at most 8 related files at a time.');
      const traces = [], summaries = [];
      for (const file of files) {
        const text = await readFile(file);
        if (/\.jsonl(?:\.gz)?$/i.test(file.name)) summaries.push({name: file.name, rows: M.jsonl(text)});
        else {
          let doc;
          try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); }
          catch { throw new Error(`${file.name}: The JSON file is incomplete or invalid.`); }
          if (!Array.isArray(doc) && !doc?.traceEvents) throw new Error(`${file.name}: A raw trace is required. trace_digest and bench outputs are not supported in this version.`);
          traces.push({name: file.name, doc});
        }
      }
      const records = summaries.flatMap(s => s.rows);
      const groups = traces.length ? traces.map(t => M.trace(t.doc, t.name, records)) : summaries.flatMap(s => M.intervals(s.rows, s.name));
      if (!groups.length) throw new Error('No supported capture was found.');
      self.postMessage({groups});
    } catch (error) {
      self.postMessage({error: error.message || String(error)});
    }
  };
})();
