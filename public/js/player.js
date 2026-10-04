// Pipe-chanter-like synth + playback scheduling for a parsed tune (PipeABC.parseTune output).
const CENTS = [-204, 0, 204, 386, 498, 702, 884, 996, 1200]; // low G .. high A, relative to low A
const GRACE_SEC = 0.032;
const CUT_SEC = 0.028;

export class Player {
  constructor(parsed, handlers) {
    this.p = parsed;
    this.h = handlers || {};
    this.entries = parsed.timeline.filter((e) => e.type === 'note' || e.type === 'rest');
    this.secPerWhole = (60 / parsed.tempo.bpm) / parsed.tempo.unit;
    this.rate = 1; // playback speed multiplier
    this.lowA = 470;
    this.drones = false;
    this.ctx = null;
    this.state = 'stopped';
    this.cur = -1;
    this.pos = 0; // seconds (nominal tempo) where playback will resume
    this.total = this.entries.length ? (this.entries[this.entries.length - 1].t + this.entries[this.entries.length - 1].dur) * this.secPerWhole : 0;
    this.startTimes = this.entries.map((e) => e.t * this.secPerWhole);
    this._raf = 0;
  }

  freq(d) {
    return this.lowA * Math.pow(2, CENTS[Math.max(0, Math.min(8, d))] / 1200);
  }

  _ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const ctx = this.ctx;
    const re = new Float32Array(13);
    const im = new Float32Array(13);
    const prof = [0, 1, 0.85, 0.75, 0.5, 0.42, 0.3, 0.26, 0.18, 0.12, 0.09, 0.06, 0.04];
    for (let k = 1; k < 13; k++) { im[k] = prof[k]; re[k] = 0.15 * prof[k] * Math.sin(k * 1.7); }
    this.wave = ctx.createPeriodicWave(re, im);
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    this.master.connect(lp);
    lp.connect(ctx.destination);
  }

  _startVoices(t0) {
    const ctx = this.ctx;
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(this.wave);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.osc.connect(this.gain);
    this.gain.connect(this.master);
    this.osc.start(t0);
    this.droneNodes = [];
    if (this.drones) {
      for (const div of [2, 2, 4]) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(this.wave);
        o.frequency.value = (this.lowA / div) * (div === 2 && this.droneNodes.length ? 1.0012 : 1);
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setTargetAtTime(0.16, t0, 0.15);
        o.connect(g);
        g.connect(this.master);
        o.start(t0);
        this.droneNodes.push({ o, g });
      }
    }
  }

  _stopVoices() {
    if (!this.ctx || !this.osc) return;
    const t = this.ctx.currentTime;
    try {
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setTargetAtTime(0, t, 0.02);
      this.osc.stop(t + 0.15);
      for (const { o, g } of this.droneNodes) {
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(0, t, 0.05);
        o.stop(t + 0.3);
      }
    } catch (e) { /* already stopped */ }
    this.osc = null;
  }

  indexAt(sec) {
    const s = this.startTimes;
    let lo = 0, hi = s.length - 1, r = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= sec) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return r;
  }

  async play(fromIdx) {
    if (!this.entries.length) return;
    this._ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stop(true);
    if (fromIdx != null) this.pos = this.startTimes[Math.max(0, Math.min(this.entries.length - 1, fromIdx))];
    if (this.pos >= this.total - 0.05) this.pos = 0;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.08;
    this._t0 = t0;
    this._pos0 = this.pos;
    this._startVoices(t0);
    const f = this.osc.frequency;
    const g = this.gain.gain;
    const r = this.rate;
    const first = this.indexAt(this.pos);
    let prevD = -1;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(0.9, t0 + 0.04);
    for (let i = first; i < this.entries.length; i++) {
      const e = this.entries[i];
      const t = t0 + (this.startTimes[i] - this.pos) / r;
      const dur = (e.dur * this.secPerWhole) / r;
      if (t < t0 - 1e-6) continue;
      if (e.type === 'rest') {
        g.setTargetAtTime(0, t, 0.01);
        prevD = -1;
        continue;
      }
      g.setTargetAtTime(0.9, t, 0.01);
      let at = t;
      const graces = (e.graces || []).slice(0, 5);
      const gl = Math.min(GRACE_SEC, (dur * 0.5) / Math.max(1, graces.length));
      if (graces.length) {
        for (const gd of graces) { f.setValueAtTime(this.freq(gd), at); at += gl; }
      } else if (prevD === e.d && dur > CUT_SEC * 3) {
        // the pipes have no silence: a repeated note is separated by a quick cut (high G, or low G above it)
        f.setValueAtTime(this.freq(e.d >= 7 ? 0 : 7), at);
        at += CUT_SEC;
      }
      f.setValueAtTime(this.freq(e.d), at);
      prevD = e.d;
    }
    const end = t0 + (this.total - this.pos) / r;
    g.setTargetAtTime(0, end, 0.03);
    this.state = 'playing';
    this.cur = -1;
    this.h.onState && this.h.onState('playing');
    this._tick();
  }

  _tick() {
    cancelAnimationFrame(this._raf);
    const step = () => {
      if (this.state !== 'playing') return;
      const el = this._pos0 + (this.ctx.currentTime - this._t0) * this.rate;
      if (el >= this.total) {
        this.pos = 0;
        this.state = 'stopped';
        this._stopVoices();
        this.h.onTime && this.h.onTime(this.total, this.total);
        this.h.onEvent && this.h.onEvent(-1, null);
        this.h.onState && this.h.onState('stopped');
        return;
      }
      if (el >= 0) {
        const idx = this.indexAt(el);
        if (idx !== this.cur) {
          this.cur = idx;
          this.h.onEvent && this.h.onEvent(idx, this.entries[idx]);
        }
        this.h.onTime && this.h.onTime(el, this.total);
      }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.pos = Math.max(0, this._pos0 + (this.ctx.currentTime - this._t0) * this.rate);
    this.stop(true);
    this.state = 'paused';
    this.h.onState && this.h.onState('paused');
  }

  /** stop playing; `keep` leaves the position where it is */
  stop(keep) {
    cancelAnimationFrame(this._raf);
    this._stopVoices();
    if (!keep) {
      this.pos = 0;
      this.cur = -1;
      this.h.onEvent && this.h.onEvent(-1, null);
    }
    this.state = 'stopped';
  }

  seekFraction(x) {
    const sec = Math.max(0, Math.min(1, x)) * this.total;
    this.seekSeconds(sec);
  }

  seekSeconds(sec) {
    const was = this.state === 'playing';
    this.pos = sec;
    const idx = this.indexAt(sec);
    this.cur = idx;
    this.h.onEvent && this.h.onEvent(idx, this.entries[idx]);
    this.h.onTime && this.h.onTime(sec, this.total);
    if (was) this.play();
  }

  seekToEntry(idx) {
    const was = this.state === 'playing';
    this.pos = this.startTimes[idx];
    this.cur = idx;
    this.h.onEvent && this.h.onEvent(idx, this.entries[idx]);
    this.h.onTime && this.h.onTime(this.pos, this.total);
    if (was || true) this.play();
  }

  setRate(r) {
    const was = this.state === 'playing';
    if (was) this.pause();
    this.rate = r;
    if (was) this.play();
  }

  setDrones(on) {
    const was = this.state === 'playing';
    this.drones = on;
    if (was) { this.pause(); this.play(); }
  }

  dispose() {
    this.stop();
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }
}
