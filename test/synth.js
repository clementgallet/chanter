'use strict';
/**
 * Synthetic great-highland-bagpipe audio, for testing the detector without real recordings.
 * The timbre is deliberately NOT the detector's own template: harmonic amplitudes are randomised
 * per render, intervals deviate from the nominal scale, and drones / noise / reverb are optional.
 */
const ABC = require('../lib/abc.js');

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

const NOMINAL_CENTS = [-204, 0, 204, 386, 498, 702, 884, 996, 1200];

/**
 * @param {object} p parsed tune (ABC.parseTune)
 * @param {object} o options: sr, lowA, tempoScale, tempoJitter, seed, drones (level), noise (snr dB or null),
 *                   reverb (0..1), startNote, maxSeconds, graceMs, noteDevCents, bpm
 */
function renderTune(p, o) {
  o = Object.assign(
    { sr: 22050, lowA: 470, tempoScale: 1, tempoJitter: 0.1, seed: 1, drones: 1, noise: 30, reverb: 0.2,
      startNote: 0, maxSeconds: 20, graceMs: 22, noteDevCents: 14, bpm: null },
    o || {}
  );
  const r = rng(o.seed * 7919 + 13);
  const bpm = (o.bpm || p.tempo.bpm) * o.tempoScale;
  const secPerWhole = (60 / bpm) * (1 / p.tempo.unit);

  // per-render timbre
  const amps = [];
  for (let h = 1; h <= 14; h++) amps.push((1 / Math.pow(h, 0.55 + 0.4 * r())) * (0.6 + 0.8 * r()) * (h > 9 ? 0.3 : 1));
  const dev = NOMINAL_CENTS.map(() => gauss(r) * o.noteDevCents);
  const freq = (d) => o.lowA * Math.pow(2, (NOMINAL_CENTS[d] + dev[d]) / 1200);

  // note list in seconds
  const tl = p.timeline.filter((e) => e.type === 'note' && e.inRange);
  const segs = [];
  let tNow = 0;
  const first = Math.max(0, Math.min(o.startNote, tl.length - 1));
  const t0 = tl[first].t;
  let lastEnd = 0;
  for (let i = first; i < tl.length; i++) {
    const e = tl[i];
    let dur = e.dur * secPerWhole * (1 + o.tempoJitter * gauss(r) * 0.6);
    dur = Math.max(0.08, dur);
    const start = (e.t - t0) * secPerWhole * 1; // nominal; jitter drifts
    const st = Math.max(lastEnd, start + 0 * tNow);
    segs.push({ d: e.d, start: st, dur, graces: e.graces || [] });
    lastEnd = st + dur;
    if (lastEnd > o.maxSeconds) break;
  }
  const total = Math.min(lastEnd + 0.4, o.maxSeconds + 0.5);
  const n = Math.floor(total * o.sr);
  const y = new Float32Array(n);

  // phase-continuous chanter (the reed keeps vibrating through a note change)
  const phase = new Float64Array(amps.length);
  const gms = o.graceMs / 1000;
  const events = []; // [startSample, endSample, freq]
  for (const s of segs) {
    const a = Math.floor(s.start * o.sr);
    let cursor = a;
    // graces are played at the beginning of the note's time slot
    const gs = s.graces.slice(0, 5);
    for (const g of gs) {
      const len = Math.floor(gms * o.sr * (0.8 + 0.5 * r()));
      events.push([cursor, cursor + len, freq(g)]);
      cursor += len;
    }
    const endS = Math.floor((s.start + s.dur) * o.sr);
    events.push([cursor, Math.max(cursor + 10, endS), freq(s.d)]);
  }
  // rasterise per-sample frequency (+ vibrato-less) and amplitude envelope
  const fArr = new Float32Array(n);
  const gArr = new Float32Array(n).fill(0);
  for (const [a, b, f] of events) {
    for (let i = a; i < Math.min(b, n); i++) { fArr[i] = f; gArr[i] = 1; }
  }
  // smooth the on/off gain (bagpipes never stop, so only the gaps between events are quiet) and add pitch glide
  let fPrev = 0;
  for (let i = 0; i < n; i++) {
    let f = fArr[i] || fPrev || o.lowA;
    fPrev = f;
    fArr[i] = f;
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const f = fArr[i];
    for (let h = 0; h < amps.length; h++) {
      const w = (2 * Math.PI * f * (h + 1)) / o.sr;
      if (f * (h + 1) > o.sr * 0.48) break;
      phase[h] += w;
      sum += amps[h] * Math.sin(phase[h]);
    }
    y[i] = sum * 0.12;
  }
  // tiny articulation dips at note boundaries (a cut / tongue-free transition leaves a short dip)
  for (const s of segs) {
    const a = Math.floor(s.start * o.sr);
    for (let k = 0; k < 120; k++) if (a + k < n) y[a + k] *= 0.7 + 0.3 * (k / 120);
  }

  // drones: A one and two octaves below low A, with their own harmonic series and slow beating
  if (o.drones > 0) {
    const dph = [0, 0, 0];
    const dfs = [o.lowA / 2, o.lowA / 2 * 1.0013, o.lowA / 4];
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let d = 0; d < 3; d++) {
        const w = (2 * Math.PI * dfs[d]) / o.sr;
        dph[d] += w;
        for (let h = 1; h <= 20; h++) {
          if (dfs[d] * h > o.sr * 0.48) break;
          s += (1 / Math.pow(h, 0.8)) * Math.sin(dph[d] * h) * 0.5;
        }
      }
      y[i] += s * 0.07 * o.drones;
    }
  }

  // reverb: a small bank of feedback combs
  let out = y;
  if (o.reverb > 0) {
    out = Float32Array.from(y);
    const delays = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => Math.floor(d * o.sr));
    for (const dly of delays) {
      const g = 0.55 + 0.25 * o.reverb;
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const fb = i >= dly ? buf[i - dly] * g : 0;
        buf[i] = y[i] + fb;
        out[i] += buf[i] * 0.25 * o.reverb;
      }
    }
  }

  // noise
  if (o.noise != null) {
    let pw = 0;
    for (let i = 0; i < n; i++) pw += out[i] * out[i];
    pw /= n;
    const nl = Math.sqrt(pw / Math.pow(10, o.noise / 10));
    let b = 0;
    for (let i = 0; i < n; i++) {
      const w = gauss(r);
      b = 0.97 * b + 0.25 * w; // pinkish
      out[i] += nl * (0.5 * w + 0.9 * b);
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.8;
  return { samples: out, sr: o.sr, dev };
}

/** Random pipe-like tune: phrases that start on stepwise motion, with repeated motifs, as a library filler. */
function randomTune(seed, nNotes) {
  const r = rng(seed * 104729 + 7);
  const motif = [];
  let d = Math.floor(r() * 9);
  const mk = () => {
    const m = [];
    for (let i = 0; i < 4 + Math.floor(r() * 4); i++) {
      const step = [-3, -2, -1, -1, 0, 1, 1, 2, 3][Math.floor(r() * 9)];
      d = Math.max(0, Math.min(8, d + step));
      m.push(d);
    }
    return m;
  };
  const motifs = [mk(), mk(), mk()];
  const notes = [];
  while (notes.length < nNotes) {
    const m = motifs[Math.floor(r() * motifs.length)].slice();
    if (r() < 0.3) m[m.length - 1] = Math.max(0, Math.min(8, m[m.length - 1] + (r() < 0.5 ? -1 : 1)));
    for (const x of m) if (!notes.length || notes[notes.length - 1] !== x) notes.push(x);
    if (r() < 0.25) motifs[Math.floor(r() * 3)] = mk();
  }
  return notes.slice(0, nNotes).join('');
}

module.exports = { renderTune, randomTune, rng };
