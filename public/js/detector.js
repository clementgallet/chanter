/*
 * Great Highland Bagpipe tune detector.
 *
 *   transcribe(samples, sampleRate)  -> chanter-note sequence heard in the audio
 *   Matcher(db).match(notes)         -> tunes ranked by posterior probability
 *
 * Why this is more robust than generic pitch tracking:
 *  - The chanter has exactly 9 notes, so instead of estimating a free pitch we ask, per frame,
 *    "which of the 9 harmonic combs explains the spectrum?" (non-negative least squares). That
 *    also resolves G/g and A/a octave confusion, because a low note explains the odd harmonics
 *    that the high note lacks.
 *  - Drones are stationary: a per-frequency low quantile over time is subtracted before analysis.
 *  - Chanter tuning is unknown (A is anywhere in ~425-505 Hz and individual notes deviate): the
 *    reference pitch is searched on a grid and every note centre is then re-estimated from the data.
 *  - Matching ignores ornaments (grace notes are not in the signature, repeated notes are collapsed),
 *    tolerates insertions / deletions / substitutions through a probabilistic local alignment, and
 *    converts alignment scores to posteriors with an explicit "not in the library" hypothesis.
 *
 * Pure JS, no DOM: runs in a Web Worker, the page, or Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipeDetector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ constants

  const SR = 16000;
  const WIN = 1024;
  const NFFT = 2048;
  const HOP = 256;
  const BIN_HZ = SR / NFFT;
  const F_LO = 300;
  const F_HI = 5200;
  const K_LO = Math.floor(F_LO / BIN_HZ);
  const K_HI = Math.ceil(F_HI / BIN_HZ);
  const K = K_HI - K_LO + 1;
  const NOTES = 9;

  // Typical chanter scale in cents above low A (just-ish intonation; real chanters vary and are re-fitted).
  const TEMPLATE_CENTS = [-204, 0, 204, 386, 498, 702, 884, 996, 1200];
  const PROFILE = [1, 1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15];

  // ------------------------------------------------------------------ FFT

  const fftTables = {};
  function getFft(n) {
    if (fftTables[n]) return fftTables[n];
    const levels = Math.log2(n) | 0;
    const rev = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    return (fftTables[n] = { n, rev, cos, sin });
  }

  function fft(re, im, t) {
    const { n, rev, cos, sin } = t;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let x = re[i]; re[i] = re[j]; re[j] = x;
        x = im[i]; im[i] = im[j]; im[j] = x;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * cos[k] - im[l] * sin[k];
          const ti = re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }

  // ------------------------------------------------------------------ resampling

  /** Band-limited resampling by windowed-sinc interpolation (good enough for analysis, ~16 taps/side). */
  function resample(x, srcRate, dstRate) {
    if (srcRate === dstRate) return x instanceof Float32Array ? x : Float32Array.from(x);
    const ratio = srcRate / dstRate;
    const outLen = Math.floor(x.length / ratio);
    const out = new Float32Array(outLen);
    const cutoff = Math.min(1, dstRate / srcRate) * 0.92;
    const half = 16;
    // cache one kernel per fractional phase (quantised to 1/64)
    const PH = 64;
    const kernels = new Array(PH);
    for (let p = 0; p < PH; p++) {
      const frac = p / PH;
      const k = new Float32Array(2 * half);
      let sum = 0;
      for (let i = -half + 1; i <= half; i++) {
        const d = i - frac;
        const arg = Math.PI * d * cutoff;
        const s = Math.abs(d) < 1e-9 ? cutoff : Math.sin(arg) / (Math.PI * d);
        const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / (half + 1));
        k[i + half - 1] = s * w;
        sum += s * w;
      }
      for (let i = 0; i < k.length; i++) k[i] /= sum;
      kernels[p] = k;
    }
    for (let o = 0; o < outLen; o++) {
      const pos = o * ratio;
      const base = Math.floor(pos);
      const k = kernels[Math.min(PH - 1, Math.round((pos - base) * PH) % PH)];
      let acc = 0;
      for (let i = -half + 1; i <= half; i++) {
        const idx = base + i;
        if (idx >= 0 && idx < x.length) acc += x[idx] * k[i + half - 1];
      }
      out[o] = acc;
    }
    return out;
  }

  function toMono(channels) {
    if (channels.length === 1) return channels[0];
    const n = channels[0].length;
    const out = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
    return out;
  }

  // ------------------------------------------------------------------ spectrogram

  const hann = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);

  /** Compressed magnitude spectrogram of band K_LO..K_HI. Returns {m: Float32Array(T*K), T}. */
  function spectrogram(x) {
    const T = Math.max(0, Math.floor((x.length - WIN) / HOP) + 1);
    const m = new Float32Array(T * K);
    const tab = getFft(NFFT);
    const re = new Float64Array(NFFT);
    const im = new Float64Array(NFFT);
    for (let t = 0; t < T; t += 2) {
      const a = t * HOP;
      const b = (t + 1) * HOP;
      const hasB = t + 1 < T;
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < WIN; i++) {
        re[i] = x[a + i] * hann[i];
        if (hasB) im[i] = x[b + i] * hann[i];
      }
      fft(re, im, tab);
      for (let k = K_LO; k <= K_HI; k++) {
        const kn = NFFT - k;
        const ar = (re[k] + re[kn]) * 0.5;
        const ai = (im[k] - im[kn]) * 0.5;
        m[t * K + (k - K_LO)] = Math.sqrt(Math.sqrt(ar * ar + ai * ai));
        if (hasB) {
          const br = (im[k] + im[kn]) * 0.5;
          const bi = -(re[k] - re[kn]) * 0.5;
          m[(t + 1) * K + (k - K_LO)] = Math.sqrt(Math.sqrt(br * br + bi * bi));
        }
      }
    }
    return { m, T };
  }

  /** Remove stationary content (drones, hum, room tone): subtract a low per-bin quantile over time. */
  function subtractBackground(spec, q) {
    const { m, T } = spec;
    const out = new Float32Array(m.length);
    if (T < 30) {
      out.set(m);
      return { m: out, T };
    }
    const col = new Float32Array(T);
    const qi = Math.floor(q * (T - 1));
    for (let k = 0; k < K; k++) {
      for (let t = 0; t < T; t++) col[t] = m[t * K + k];
      col.sort();
      const bg = col[qi];
      for (let t = 0; t < T; t++) {
        const v = m[t * K + k] - bg;
        out[t * K + k] = v > 0 ? v : 0;
      }
    }
    return { m: out, T };
  }

  // ------------------------------------------------------------------ dictionary of the 9 chanter notes

  function hannKernel(d) {
    d = Math.abs(d);
    if (d >= 3) return 0;
    if (d < 1e-9) return 1;
    if (Math.abs(d - 1) < 1e-6) return 0.5;
    const s = Math.sin(Math.PI * d) / (Math.PI * d);
    return Math.abs(s / (1 - d * d));
  }

  /** Sparse unit-norm atoms: one harmonic comb per chanter note, for reference pitch P (low A, Hz). */
  function buildDictionary(P, cents, profile, tol) {
    tol = tol == null ? 0 : tol;
    const offs = tol > 0 ? [-tol, -tol / 2, 0, tol / 2, tol] : [0];
    const atoms = [];
    const R = 2.4;
    const scale = WIN / NFFT;
    const freqs = [];
    for (let n = 0; n < NOTES; n++) {
      const f0 = P * Math.pow(2, cents[n] / 1200);
      freqs.push(f0);
      const dense = new Float32Array(K);
      for (let h = 1; h <= profile.length; h++) {
        const f = h * f0;
        if (f > F_HI + 150) break;
        const g = f / BIN_HZ - K_LO;
        const amp = Math.sqrt(profile[h - 1]);
        const k0 = Math.max(0, Math.ceil(g - R / scale));
        const k1 = Math.min(K - 1, Math.floor(g + R / scale));
        for (let k = Math.max(0, k0 - 2); k <= Math.min(K - 1, k1 + 2); k++) {
          let v = 0;
          for (const o of offs) {
            const gg = (f * Math.pow(2, o / 1200)) / BIN_HZ - K_LO;
            const kv = hannKernel((k - gg) * scale);
            if (kv > v) v = kv;
          }
          dense[k] += amp * Math.sqrt(v);
        }
      }
      let norm = 0;
      for (let k = 0; k < K; k++) norm += dense[k] * dense[k];
      norm = Math.sqrt(norm) || 1;
      const idx = [];
      const val = [];
      for (let k = 0; k < K; k++) {
        if (dense[k] > 1e-4) {
          idx.push(k);
          val.push(dense[k] / norm);
        }
      }
      atoms.push({ idx: Int32Array.from(idx), val: Float32Array.from(val) });
    }
    // Gram matrix
    const G = new Float64Array(NOTES * NOTES);
    const tmp = new Float32Array(K);
    for (let i = 0; i < NOTES; i++) {
      tmp.fill(0);
      const a = atoms[i];
      for (let p = 0; p < a.idx.length; p++) tmp[a.idx[p]] = a.val[p];
      for (let j = 0; j < NOTES; j++) {
        const b = atoms[j];
        let s = 0;
        for (let p = 0; p < b.idx.length; p++) s += tmp[b.idx[p]] * b.val[p];
        G[i * NOTES + j] = s;
      }
    }
    return { atoms, G, freqs, P, cents: cents.slice() };
  }

  /** Non-negative least squares for one frame via coordinate descent on the 9x9 normal equations. */
  function nnls(G, b, c, iters) {
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < NOTES; i++) {
        let r = b[i];
        const row = i * NOTES;
        for (let j = 0; j < NOTES; j++) if (j !== i) r -= G[row + j] * c[j];
        const v = r / G[row + i];
        c[i] = v > 0 ? v : 0;
      }
    }
  }

  function frameProjection(dict, m, off, b) {
    for (let n = 0; n < NOTES; n++) {
      const a = dict.atoms[n];
      let s = 0;
      for (let p = 0; p < a.idx.length; p++) s += m[off + a.idx[p]] * a.val[p];
      b[n] = s;
    }
  }

  /** Fit all frames. Returns {coef: Float32Array(T*9), energy: Float32Array(T)}. */
  function fitFrames(spec, dict, iters) {
    const { m, T } = spec;
    const coef = new Float32Array(T * NOTES);
    const energy = new Float32Array(T);
    const b = new Float64Array(NOTES);
    const c = new Float64Array(NOTES);
    for (let t = 0; t < T; t++) {
      const off = t * K;
      let e = 0;
      for (let k = 0; k < K; k++) e += m[off + k] * m[off + k];
      energy[t] = Math.sqrt(e);
      if (e < 1e-9) continue;
      frameProjection(dict, m, off, b);
      c.fill(0);
      nnls(dict.G, b, c, iters);
      for (let n = 0; n < NOTES; n++) coef[t * NOTES + n] = c[n];
    }
    return { coef, energy };
  }

  // ------------------------------------------------------------------ tuning search

  /**
   * Find the chanter's reference pitch (low A, Hz). Scores a grid of candidates by how much frame
   * energy the 9 combs explain. Returns candidates best-first (distinct local maxima).
   */
  function searchTuning(spec, energyOrder, opts) {
    const lo = opts.pMin;
    const hi = opts.pMax;
    const stepCents = 3;
    const nCand = Math.floor((1200 * Math.log2(hi / lo)) / stepCents) + 1;
    const { m, T } = spec;
    // use the loudest frames (after background removal) - those are the ones with a note in them
    const take = Math.min(T, 160);
    const frames = energyOrder.slice(0, take);
    const b = new Float64Array(NOTES);
    const c = new Float64Array(NOTES);
    const scores = new Float64Array(nCand);
    const cents0 = TEMPLATE_CENTS;
    for (let ci = 0; ci < nCand; ci++) {
      const P = lo * Math.pow(2, (ci * stepCents) / 1200);
      const dict = buildDictionary(P, cents0, PROFILE, opts.tolCoarse);
      let total = 0;
      for (const t of frames) {
        frameProjection(dict, m, t * K, b);
        c.fill(0);
        nnls(dict.G, b, c, 12);
        let ex = 0;
        for (let n = 0; n < NOTES; n++) ex += c[n] * b[n];
        total += ex;
      }
      scores[ci] = total;
    }
    // smooth a little, then pick local maxima
    const sm = new Float64Array(nCand);
    for (let i = 0; i < nCand; i++) {
      let s = 0, w = 0;
      for (let d = -2; d <= 2; d++) {
        const j = i + d;
        if (j < 0 || j >= nCand) continue;
        const wt = 3 - Math.abs(d);
        s += scores[j] * wt;
        w += wt;
      }
      sm[i] = s / w;
    }
    const peaks = [];
    for (let i = 0; i < nCand; i++) {
      const l = i > 0 ? sm[i - 1] : -Infinity;
      const r = i < nCand - 1 ? sm[i + 1] : -Infinity;
      if (sm[i] >= l && sm[i] > r) peaks.push({ P: lo * Math.pow(2, (i * stepCents) / 1200), score: sm[i] });
    }
    peaks.sort((a, b) => b.score - a.score);
    const out = [];
    for (const p of peaks) {
      if (out.every((q) => Math.abs(1200 * Math.log2(p.P / q.P)) > 60)) out.push(p);
      if (out.length >= opts.tuningCandidates) break;
    }
    return out.filter((p) => p.score >= out[0].score * 0.8);
  }

  // ------------------------------------------------------------------ decoding

  function quantile(arr, q) {
    const a = Float32Array.from(arr).sort();
    return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))];
  }

  /**
   * Viterbi over 9 notes + silence. Emission = how much of the frame is explained by each note.
   * Returns per-frame state (0..8 note, 9 silence) and rho (explained fraction).
   */
  function decode(fit, T, opts) {
    const { coef, energy } = fit;
    const S = NOTES + 1;
    const scale = quantile(energy, 0.85) || 1;
    const emis = new Float32Array(T * S);
    const rho = new Float32Array(T * NOTES);
    for (let t = 0; t < T; t++) {
      const e = energy[t];
      const voiced = e > opts.gate * scale;
      if (!voiced) {
        emis[t * S + NOTES] = 1;
        continue;
      }
      // components are in L2 units of the atom: rho_n = c_n / |x|, in [0, ~1]
      let tot = 0;
      for (let n = 0; n < NOTES; n++) tot += coef[t * NOTES + n];
      for (let n = 0; n < NOTES; n++) {
        const r = Math.min(1.2, coef[t * NOTES + n] / e);
        rho[t * NOTES + n] = r;
        emis[t * S + n] = r;
      }
      emis[t * S + NOTES] = opts.silenceLevel;
      void tot;
    }
    // Viterbi
    const lam = opts.switchPenalty;
    const back = new Uint8Array(T * S);
    let prev = new Float64Array(S);
    let cur = new Float64Array(S);
    for (let s = 0; s < S; s++) prev[s] = emis[s];
    for (let t = 1; t < T; t++) {
      // best previous (for switching)
      let bi = 0;
      let bv = prev[0];
      for (let s = 1; s < S; s++) if (prev[s] > bv) { bv = prev[s]; bi = s; }
      for (let s = 0; s < S; s++) {
        const stay = prev[s];
        const sw = bv - lam;
        if (stay >= sw) { cur[s] = stay + emis[t * S + s]; back[t * S + s] = s; }
        else { cur[s] = sw + emis[t * S + s]; back[t * S + s] = bi; }
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    let s = 0;
    for (let i = 1; i < S; i++) if (prev[i] > prev[s]) s = i;
    const states = new Uint8Array(T);
    for (let t = T - 1; t >= 0; t--) {
      states[t] = s;
      s = back[t * S + s];
    }
    return { states, rho, scale };
  }

  /** Turn per-frame states into note segments, cleaning flicker. */
  function segments(states, rho, T, opts) {
    const segs = [];
    let t = 0;
    while (t < T) {
      let u = t;
      while (u + 1 < T && states[u + 1] === states[t]) u++;
      if (states[t] < NOTES) {
        let conf = 0;
        for (let k = t; k <= u; k++) conf += rho[k * NOTES + states[t]];
        segs.push({ n: states[t], f0: t, f1: u, conf: conf / (u - t + 1) });
      } else segs.push({ n: -1, f0: t, f1: u, conf: 0 });
      t = u + 1;
    }
    // drop very short note segments (grace notes / transients), then merge equal neighbours
    const minFrames = opts.minNoteFrames;
    let out = segs.filter((s) => s.n < 0 || s.f1 - s.f0 + 1 >= minFrames);
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      if (last && last.n >= 0 && s.n === last.n) {
        const lenA = last.f1 - last.f0 + 1;
        const lenB = s.f1 - s.f0 + 1;
        last.conf = (last.conf * lenA + s.conf * lenB) / (lenA + lenB);
        last.f1 = s.f1;
      } else if (last && last.n < 0 && s.n < 0) last.f1 = s.f1;
      else merged.push({ ...s });
    }
    // equal notes separated only by a short silence/gap are one note (cut gracenotes)
    const gapFrames = Math.round(opts.mergeGap / (HOP / SR));
    const res = [];
    for (let i = 0; i < merged.length; i++) {
      const s = merged[i];
      if (s.n < 0) {
        const prevS = res[res.length - 1];
        const next = merged[i + 1];
        if (prevS && next && prevS.n === next.n && s.f1 - s.f0 + 1 <= gapFrames) {
          const lenA = prevS.f1 - prevS.f0 + 1;
          const lenB = next.f1 - next.f0 + 1;
          prevS.conf = (prevS.conf * lenA + next.conf * lenB) / (lenA + lenB);
          prevS.f1 = next.f1;
          i++;
          continue;
        }
        continue; // pure silence: not a note
      }
      const last = res[res.length - 1];
      if (last && last.n === s.n) {
        last.f1 = s.f1;
      } else res.push({ ...s });
    }
    return res;
  }

  // ------------------------------------------------------------------ per-note tuning refinement

  /** Estimate each note's actual centre (cents above low A) from harmonic peak positions in the audio. */
  function refineCenters(spec, segs, dict, cents) {
    const { m } = spec;
    const devs = [];
    for (let n = 0; n < NOTES; n++) devs.push([]);
    for (const s of segs) {
      if (s.n < 0) continue;
      const f0 = dict.freqs[s.n];
      const a = s.f0 + 1;
      const b = s.f1 - 1;
      for (let t = a; t <= b; t++) {
        const off = t * K;
        for (let h = 2; h <= 5; h++) {
          const f = h * f0;
          if (f > F_HI - 100) break;
          const g = f / BIN_HZ - K_LO;
          const span = Math.ceil(((f * (Math.pow(2, 55 / 1200) - 1)) / BIN_HZ));
          let best = -1;
          let bv = 0;
          for (let k = Math.max(1, Math.round(g) - span); k <= Math.min(K - 2, Math.round(g) + span); k++) {
            const v = m[off + k];
            if (v > bv) { bv = v; best = k; }
          }
          if (best < 1 || best >= K - 1) continue;
          const l = m[off + best - 1];
          const r = m[off + best + 1];
          if (!(bv >= l && bv >= r) || bv <= 0) continue;
          const den = l - 2 * bv + r;
          const frac = den !== 0 ? (0.5 * (l - r)) / den : 0;
          const peak = best + Math.max(-0.5, Math.min(0.5, frac));
          const dev = 1200 * Math.log2(((peak + K_LO) * BIN_HZ) / f);
          devs[s.n].push({ dev: dev / 1, w: bv });
        }
      }
    }
    const next = cents.slice();
    let changed = false;
    for (let n = 0; n < NOTES; n++) {
      const d = devs[n];
      if (d.length < 12) continue;
      d.sort((x, y) => x.dev - y.dev);
      let tot = 0;
      for (const e of d) tot += e.w;
      let acc = 0;
      let med = 0;
      for (const e of d) {
        acc += e.w;
        if (acc >= tot / 2) { med = e.dev; break; }
      }
      const upd = next[n] + Math.max(-45, Math.min(45, med));
      const lim = TEMPLATE_CENTS[n];
      next[n] = Math.max(lim - 60, Math.min(lim + 60, upd)); // never drift more than 60 cents from the nominal scale
      if (Math.abs(next[n] - cents[n]) > 1) changed = true;
    }
    return { cents: next, changed };
  }

  // ------------------------------------------------------------------ transcribe

  const DEFAULTS = {
    pMin: 425,
    pMax: 505,
    tuningCandidates: 2,
    backgroundQuantile: 0.25,
    nnlsIters: 40,
    gate: 0.18,
    silenceLevel: 0.22,
    switchPenalty: 0.9,
    minNoteFrames: 3,
    mergeGap: 0.12,
    refinePasses: 2,
    tolCoarse: 22,
    tolFine: 8,
  };

  /**
   * Transcribe audio into a chanter note sequence.
   * `samples` mono Float32Array at sampleRate. Returns one transcription per tuning hypothesis (best first).
   */
  function transcribe(samples, sampleRate, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const x = resample(samples, sampleRate, SR);
    const raw = spectrogram(x);
    const T = raw.T;
    if (T < 20) return { hypotheses: [], duration: x.length / SR, frames: T };
    const spec = subtractBackground(raw, opts.backgroundQuantile);

    // loudest frames drive the tuning search
    const eng = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      let e = 0;
      for (let k = 0; k < K; k++) e += spec.m[t * K + k] * spec.m[t * K + k];
      eng[t] = e;
    }
    const order = Array.from({ length: T }, (_, i) => i).sort((a, b) => eng[b] - eng[a]);
    const cand = searchTuning(spec, order, opts);

    const hypotheses = [];
    for (const c of cand) {
      let cents = TEMPLATE_CENTS.slice();
      let dict = buildDictionary(c.P, cents, PROFILE, opts.tolCoarse);
      let fit = fitFrames(spec, dict, opts.nnlsIters);
      let dec = decode(fit, T, opts);
      let segs = segments(dec.states, dec.rho, T, opts);
      for (let pass = 0; pass < opts.refinePasses; pass++) {
        const ref = refineCenters(spec, segs, dict, cents);
        if (!ref.changed) break;
        cents = ref.cents;
        dict = buildDictionary(c.P, cents, PROFILE, opts.tolFine);
        fit = fitFrames(spec, dict, opts.nnlsIters);
        dec = decode(fit, T, opts);
        segs = segments(dec.states, dec.rho, T, opts);
      }
      const hop = HOP / SR;
      const notes = segs.map((s) => ({
        n: s.n,
        t: (s.f0 * HOP) / SR + WIN / 2 / SR - hop / 2,
        dur: (s.f1 - s.f0 + 1) * hop,
        conf: s.conf,
      }));
      let voiced = 0;
      for (let t = 0; t < T; t++) if (dec.states[t] < NOTES) voiced++;
      hypotheses.push({
        P: c.P,
        tuningScore: c.score,
        cents,
        notes,
        voicedRatio: voiced / T,
        // per-frame state for visualisation / debugging
        states: dec.states,
      });
    }
    return { hypotheses, duration: x.length / SR, frames: T };
  }

  // ------------------------------------------------------------------ matching

  const NOISE_MODELS = {
    // probability that an observed note is the right one / spurious insertion per note / deletion per note
    clean: { pc: 0.85, ins: 0.06, del: 0.06 },
    noisy: { pc: 0.62, ins: 0.16, del: 0.16 },
  };

  function confusionLogOdds(bg, model) {
    // C[a][b] = P(observe b | true a): correct, adjacent degree, octave partner, other
    const S = new Float32Array(NOTES * NOTES);
    for (let a = 0; a < NOTES; a++) {
      const w = new Float64Array(NOTES);
      let adj = 0;
      for (let b = 0; b < NOTES; b++) {
        if (b === a) continue;
        let v = 0.25; // generic confusion weight
        if (Math.abs(a - b) === 1) v = 3;
        else if (Math.abs(a - b) === 7 && (a === 0 || a === 7 || b === 0 || b === 7)) v = 1.2; // G / g
        else if (Math.abs(a - b) === 7) v = 1.2; // A / a
        w[b] = v;
        adj += v;
      }
      for (let b = 0; b < NOTES; b++) {
        const p = b === a ? model.pc : ((1 - model.pc) * w[b]) / adj;
        S[a * NOTES + b] = Math.log(p / bg[b]);
      }
    }
    return S;
  }

  function logSumExp(a) {
    let m = -Infinity;
    for (const v of a) if (v > m) m = v;
    if (m === -Infinity) return -Infinity;
    let s = 0;
    for (const v of a) s += Math.exp(v - m);
    return m + Math.log(s);
  }

  /** Local alignment of observed notes against a reference. Returns best score and where it lies. */
  function localAlign(q, w, n, ref, m, S, ins, del) {
    let prevH = new Float32Array(m + 1);
    let curH = new Float32Array(m + 1);
    let prevS = new Int32Array(m + 1);
    let curS = new Int32Array(m + 1);
    let prevQ = new Int32Array(m + 1);
    let curQ = new Int32Array(m + 1);
    let best = 0;
    let bi = 0, bj = 0, bs = 0, bq = 0;
    for (let i = 1; i <= n; i++) {
      const qi = q[i - 1];
      const wi = w[i - 1];
      const row = qi;
      const insW = wi * ins;
      curH[0] = 0;
      curS[0] = 0;
      curQ[0] = i;
      for (let j = 1; j <= m; j++) {
        // diagonal: aligned pair (ref[j-1] true, qi observed)
        let h = prevH[j - 1] + wi * S[ref[j - 1] * NOTES + row];
        let st = prevS[j - 1];
        let sq = prevQ[j - 1];
        // insertion in the observation (extra note)
        const hi = prevH[j] + insW;
        if (hi > h) { h = hi; st = prevS[j]; sq = prevQ[j]; }
        // deletion (reference note not heard)
        const hd = curH[j - 1] + del;
        if (hd > h) { h = hd; st = curS[j - 1]; sq = curQ[j - 1]; }
        if (h <= 0) { h = 0; st = j; sq = i; }
        curH[j] = h;
        curS[j] = st;
        curQ[j] = sq;
        if (h > best) { best = h; bi = i; bj = j; bs = st; bq = sq; }
      }
      let t = prevH; prevH = curH; curH = t;
      let u = prevS; prevS = curS; curS = u;
      let v = prevQ; prevQ = curQ; curQ = v;
    }
    return { score: best, qStart: bq, qEnd: bi, rStart: bs, rEnd: bj };
  }

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Matcher {
    /** entries: [{id, title, notes: "0123...", durs: [...]}] */
    constructor(entries) {
      this.entries = entries
        .filter((e) => e.notes && e.notes.length >= 6)
        .map((e) => {
          const len = e.notes.length;
          const arr = new Uint8Array(len * 2);
          for (let i = 0; i < len; i++) {
            const v = e.notes.charCodeAt(i) - 48;
            arr[i] = v;
            arr[len + i] = v;
          }
          return { id: e.id, title: e.title, len, ref: arr, notes: e.notes };
        });
      const counts = new Float64Array(NOTES).fill(1);
      for (const e of this.entries) for (let i = 0; i < e.len; i++) counts[e.ref[i]]++;
      let tot = 0;
      for (const c of counts) tot += c;
      this.bg = Array.from(counts, (c) => c / tot);
      this.models = Object.keys(NOISE_MODELS).map((k) => {
        const mod = NOISE_MODELS[k];
        return { S: confusionLogOdds(this.bg, mod), ins: Math.log(mod.ins), del: Math.log(mod.del) };
      });
      this.ones = new Float32Array(1024).fill(1);
      this.calibrate();
    }

    /** Best alignment score of a query over the noise models. */
    scorePair(q, n, e) {
      let best = null;
      for (const mod of this.models) {
        const a = localAlign(q, this.ones, n, e.ref, e.ref.length, mod.S, mod.ins, mod.del);
        if (!best || a.score > best.score) best = a;
      }
      return best;
    }

    /**
     * Fit the extreme-value law of alignment scores of *unrelated* music against this library:
     *   P(score >= s) ~ K * n * len * exp(-lambda * s)
     * Null queries come from an order-2 Markov chain trained on the library, with repeated phrases
     * (tunes repeat themselves, which inflates chance scores), so the null is deliberately pessimistic.
     */
    calibrate() {
      const rand = mulberry(12345);
      const E = this.entries;
      if (E.length < 2) { this.lambda = 1; this.K = 0.05; return; }
      // order-2 Markov chain over the library
      const trans = new Float64Array(NOTES * NOTES * NOTES).fill(0.05);
      for (const e of E) for (let i = 2; i < e.len; i++) trans[(e.ref[i - 2] * NOTES + e.ref[i - 1]) * NOTES + e.ref[i]]++;
      const markov = (len) => {
        const out = [Math.floor(rand() * NOTES), Math.floor(rand() * NOTES)];
        while (out.length < len) {
          const base = (out[out.length - 2] * NOTES + out[out.length - 1]) * NOTES;
          let tot = 0;
          for (let k = 0; k < NOTES; k++) tot += trans[base + k];
          let r = rand() * tot;
          let k = 0;
          for (; k < NOTES - 1; k++) { r -= trans[base + k]; if (r <= 0) break; }
          out.push(k);
        }
        return out;
      };
      const nullQuery = (len) => {
        const q = markov(Math.max(6, Math.round(len * (rand() < 0.5 ? 1 : 0.5))));
        while (q.length < len) {
          const a = Math.floor(rand() * Math.max(1, q.length - 6));
          const seg = q.slice(a, a + 4 + Math.floor(rand() * 10));
          if (rand() < 0.3 && seg.length) seg[Math.floor(rand() * seg.length)] = Math.floor(rand() * NOTES);
          for (const v of seg) q.push(v);
        }
        return Uint8Array.from(q.slice(0, len));
      };
      const sample = [];
      const stride = Math.max(1, Math.floor(E.length / 24));
      for (let i = 0; i < E.length && sample.length < 24; i += stride) sample.push(E[i]);
      const pairs = [];
      for (const len of [16, 32, 64, 128]) {
        for (let r = 0; r < 14; r++) {
          const q = nullQuery(len);
          for (const e of sample) pairs.push({ s: this.scorePair(q, len, e).score, nl: len * e.len });
        }
      }
      // exponential tail above the 90th percentile of pair scores, normalised by n*len
      const sorted = pairs.map((p) => p.s).sort((a, b) => a - b);
      const u = sorted[Math.floor(sorted.length * 0.9)];
      // MLE of lambda from excesses
      let ex = 0, cnt = 0;
      for (const p of pairs) if (p.s > u) { ex += p.s - u; cnt++; }
      const lambda = cnt ? cnt / Math.max(1e-6, ex) : 1;
      let sumNl = 0;
      for (const p of pairs) sumNl += p.nl;
      // P(S>=u) = K * nl * exp(-lambda*u) averaged over pairs
      const K = (cnt / pairs.length) / ((sumNl / pairs.length) * Math.exp(-lambda * u));
      this.lambda = lambda;
      this.K = K;
    }

    /**
     * observed: [{n, dur, conf}]. Returns tunes ranked by posterior probability.
     * `pNull` is the prior probability that the played tune is not in the library at all.
     * Each tune's likelihood ratio is 1 / E, where E is the expected number of chance alignments
     * at least this good (Karlin-Altschul, calibrated on this library).
     */
    match(observed, options) {
      const opt = Object.assign({ pNull: 0.5, top: 10, maxNotes: 450 }, options || {});
      let obs = observed;
      if (obs.length > opt.maxNotes) obs = obs.slice(obs.length - opt.maxNotes);
      const n = obs.length;
      if (n < 5 || !this.entries.length) return { results: [], pNull: 1, queryNotes: n };
      const q = new Uint8Array(n);
      for (let i = 0; i < n; i++) q[i] = obs[i].n;
      if (this.ones.length < n) this.ones = new Float32Array(n).fill(1);
      const T = this.entries.length;
      const rows = [];
      for (const e of this.entries) {
        const aln = this.scorePair(q, n, e);
        const logE = Math.log(this.K * n * e.len) - this.lambda * aln.score;
        rows.push({ id: e.id, title: e.title, logE, score: aln.score, aln, len: e.len });
      }
      const prior = (1 - opt.pNull) / T;
      const terms = rows.map((r) => Math.log(prior) - r.logE);
      const logNull = Math.log(opt.pNull);
      const z = logSumExp(terms.concat([logNull]));
      for (let i = 0; i < rows.length; i++) rows[i].prob = Math.exp(terms[i] - z);
      rows.sort((a, b) => a.logE - b.logE);
      const top = rows.slice(0, opt.top).map((r) => ({
        id: r.id,
        title: r.title,
        prob: r.prob,
        score: r.score,
        logE: r.logE,
        // where in the tune (index into its collapsed note list) the recording lines up
        refStart: r.aln.rStart % r.len,
        refEnd: ((r.aln.rEnd - 1) % r.len) + 1,
        matchedNotes: r.aln.qEnd - r.aln.qStart + 1,
      }));
      return { results: top, pNull: Math.exp(logNull - z), queryNotes: n, logEvalue: top.length ? top[0].logE + Math.log(T) : 0 };
    }
  }

  /**
   * Full pipeline: audio -> notes -> ranked tunes. Tries each tuning hypothesis and keeps the one
   * whose best match is most convincing.
   */
  function detect(samples, sampleRate, matcher, options) {
    const tr = transcribe(samples, sampleRate, options);
    let best = null;
    for (const h of tr.hypotheses) {
      const res = matcher.match(h.notes, options);
      const strength = res.results.length ? -res.results[0].logE : -Infinity;
      if (!best || strength > best.strength) best = { hyp: h, res, strength };
    }
    if (!best) return { results: [], pNull: 1, notes: [], tuning: null, duration: tr.duration };
    return {
      results: best.res.results,
      pNull: best.res.pNull,
      logEvalue: best.res.logEvalue,
      queryNotes: best.res.queryNotes,
      notes: best.hyp.notes,
      tuning: { lowA: best.hyp.P, cents: best.hyp.cents },
      voicedRatio: best.hyp.voicedRatio,
      duration: tr.duration,
    };
  }

  return {
    SR, HOP, NOTES, TEMPLATE_CENTS, DEFAULTS,
    resample, toMono, transcribe, Matcher, detect, localAlign,
    _internals: { spectrogram, subtractBackground, buildDictionary, fitFrames, decode, segments, searchTuning },
  };
});
