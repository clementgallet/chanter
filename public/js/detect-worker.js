/* Runs tune detection off the UI thread. */
importScripts('detector.js');

let matcher = null;
let indexKey = '';

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'index') {
      const t0 = Date.now();
      matcher = new PipeDetector.Matcher(m.tunes);
      indexKey = m.key || '';
      self.postMessage({ type: 'ready', tunes: matcher.entries.length, ms: Date.now() - t0, key: indexKey });
    } else if (m.type === 'analyze') {
      if (!matcher) return self.postMessage({ type: 'error', id: m.id, error: 'library not loaded yet' });
      const t0 = Date.now();
      const r = PipeDetector.detect(m.samples, m.sampleRate, matcher, { maxNotes: m.maxNotes || 450, pNull: 0.5 });
      // per-frame states are large; the UI only needs the notes
      self.postMessage({ type: 'result', id: m.id, final: !!m.final, ms: Date.now() - t0, result: r });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, error: String((err && err.message) || err) });
  }
};
