import { detectIndex } from './store.js';
// Detect view: microphone / audio-file input -> worker -> ranked tunes.
const NOTE_LETTERS = 'GABcdefga';
const LIVE_WINDOW_S = 24; // audio analysed while listening
const LIVE_EVERY_MS = 2500;
const MAX_FILE_S = 240;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let worker = null;
let workerReady = false;
let indexKey = null;
let libraryVersion = 0;
let readyWaiters = [];
let reqId = 0;
const pending = new Map();

export function onLibraryChanged() {
  libraryVersion++;
}

function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL('./detect-worker.js', import.meta.url));
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') { workerReady = true; readyWaiters.splice(0).forEach((f) => f(m)); }
    else if (m.type === 'result' || m.type === 'error') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.type === 'error' ? p.reject(new Error(m.error)) : p.resolve(m); }
    }
  };
  worker.onerror = (e) => console.error('detector worker', e);
}

async function ensureIndex() {
  ensureWorker();
  const key = String(libraryVersion);
  if (workerReady && indexKey === key) return;
  const tunes = await detectIndex();
  workerReady = false;
  indexKey = key;
  const ready = new Promise((r) => readyWaiters.push(r));
  worker.postMessage({ type: 'index', tunes, key });
  await ready;
}

function analyze(samples, sampleRate, opts) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'analyze', id, samples, sampleRate, ...opts }, [samples.buffer]);
  });
}

function concat(chunks, max) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const take = Math.min(n, max);
  const out = new Float32Array(take);
  let skip = n - take;
  let o = 0;
  for (const c of chunks) {
    if (skip >= c.length) { skip -= c.length; continue; }
    const part = skip ? c.subarray(skip) : c;
    skip = 0;
    out.set(part, o);
    o += part.length;
  }
  return out;
}

function verdictOf(r) {
  if (!r || !r.results.length) return { cls: 'none', text: 'Not enough notes yet' };
  const e = Math.exp(r.logEvalue); // expected number of chance matches this good anywhere in the library
  if (e < 0.01 && r.results[0].prob > 0.6) return { cls: 'good', text: 'Match found' };
  if (e < 0.3) return { cls: 'maybe', text: 'Probable match' };
  return { cls: 'none', text: 'No confident match' };
}

function renderResult(box, r, final) {
  const v = verdictOf(r);
  const heard = r && r.notes ? r.notes.slice(-48).map((n) => NOTE_LETTERS[n.n]).join(' ') : '';
  let html = '';
  if (r && r.results.length) {
    html += `<div class="verdict ${v.cls}">${v.text}${r.results[0].prob > 0.02 && v.cls !== 'none' ? ` &middot; ${(r.results[0].prob * 100).toFixed(0)}%` : ''}</div>`;
    const list = v.cls === 'none' ? r.results.slice(0, 3) : r.results.slice(0, 5).filter((x, i) => i === 0 || x.prob > 0.02);
    if (v.cls === 'none') html += '<div class="small muted">Closest tunes (low confidence):</div>';
    list.forEach((m, i) => {
      const pct = Math.max(1, Math.round(m.prob * 100));
      html += `<a class="match${i === 0 && v.cls !== 'none' ? ' best' : ''}" href="#/tune/${m.id}">
        <div class="name">${esc(m.title)}</div>
        <div class="small muted">${v.cls === 'none' ? 'similarity only' : pct + '% likely'} &middot; ${m.matchedNotes} notes lined up</div>
        <div class="pbar"><i style="width:${v.cls === 'none' ? Math.min(100, Math.max(4, m.prob * 100 * 4)) : pct}%"></i></div></a>`;
    });
  } else {
    html += `<div class="verdict none">${final ? 'No tune could be recognised: too few chanter notes were heard. Try again closer to the chanter, with the drones off if possible.' : v.text}</div>`;
  }
  const tuning = r && r.tuning ? ` &middot; chanter low A &asymp; ${r.tuning.lowA.toFixed(0)} Hz` : '';
  box.innerHTML = html + (heard ? `<div class="card" style="margin-top:14px"><div class="small muted">Notes heard${tuning}</div><div class="heard">${esc(heard)}</div></div>` : '');
}

export async function mountDetect(view) {
  view.innerHTML = `
    <div class="view-wide">
      <div class="card">
        <div class="mic-wrap">
          <button class="mic-btn" id="mic" aria-label="Start listening"><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V22h2v-3.1A7 7 0 0 0 19 12z"/></svg></button>
          <div id="status" class="muted">Tap and play a few phrases</div>
          <div class="meter"><i id="level"></i></div>
        </div>
      </div>
      <div class="card stack">
        <h2>Or use a recording</h2>
        <label class="btn">Choose a WAV / audio file<input type="file" id="file" accept="audio/*,.wav" hidden></label>
        <div class="small muted">Works best with a few phrases of clear chanter playing, ideally 10 seconds or more.</div>
      </div>
      <div id="libstate" class="small muted"></div>
      <div id="result"></div>
    </div>`;
  const $ = (s) => view.querySelector(s);
  const status = $('#status');
  const level = $('#level');
  const result = $('#result');
  const micBtn = $('#mic');
  let alive = true;
  let session = null; // active microphone session

  const libstate = $('#libstate');
  libstate.innerHTML = '<span class="spinner"></span> Preparing the tune library...';
  const indexReady = ensureIndex().then(() => {
    if (alive) libstate.textContent = '';
  }).catch((e) => { if (alive) libstate.textContent = 'Could not load the library: ' + e.message; throw e; });

  async function stopMic(finalize) {
    const s = session;
    if (!s) return;
    session = null;
    clearInterval(s.timer);
    s.node.disconnect();
    s.src.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    s.ctx.close();
    micBtn.classList.remove('on');
    micBtn.setAttribute('aria-label', 'Start listening');
    level.style.width = '0';
    if (finalize && alive) {
      status.innerHTML = '<span class="spinner"></span> Analysing the whole recording...';
      const samples = concat(s.chunks, s.ctx.sampleRate * 120);
      try {
        await indexReady;
        const m = await analyze(samples, s.ctx.sampleRate, { final: true, maxNotes: 450 });
        if (!alive) return;
        status.textContent = `Analysed ${m.result.duration.toFixed(0)} s of audio`;
        renderResult(result, m.result, true);
      } catch (e) { status.textContent = 'Analysis failed: ' + e.message; }
    }
  }

  micBtn.addEventListener('click', async () => {
    if (session) { stopMic(true); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.innerHTML = 'Microphone access needs a secure page. Open this app through its <b>https://</b> address.';
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      status.textContent = e && e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Could not open the microphone: ' + (e && e.message);
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let peak = 0;
    node.onaudioprocess = (ev) => {
      const d = ev.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let p = 0;
      for (let i = 0; i < d.length; i += 4) { const a = Math.abs(d[i]); if (a > p) p = a; }
      peak = Math.max(p, peak * 0.9);
      level.style.width = Math.min(100, Math.sqrt(peak) * 110) + '%';
    };
    src.connect(node);
    node.connect(ctx.destination); // required by some browsers for the processor to run; its output is silent
    const t0 = Date.now();
    let busy = false;
    const s = (session = { ctx, src, node, stream, chunks, t0, timer: 0 });
    micBtn.classList.add('on');
    micBtn.setAttribute('aria-label', 'Stop listening');
    result.innerHTML = '';
    const tick = async () => {
      if (!session) return;
      const secs = (Date.now() - t0) / 1000;
      status.textContent = `Listening... ${secs.toFixed(0)} s - tap to stop and analyse`;
      if (busy || secs < 4) return;
      busy = true;
      try {
        await indexReady;
        const samples = concat(chunks, Math.floor(ctx.sampleRate * LIVE_WINDOW_S));
        const m = await analyze(samples, ctx.sampleRate, { final: false, maxNotes: 160 });
        if (session === s && alive) renderResult(result, m.result, false);
      } catch (e) { console.warn(e); }
      busy = false;
    };
    s.timer = setInterval(tick, LIVE_EVERY_MS);
  });

  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    await stopMic(false);
    status.innerHTML = '<span class="spinner"></span> Reading ' + esc(f.name) + '...';
    result.innerHTML = '';
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      ctx.close();
      const n = Math.min(buf.length, Math.floor(buf.sampleRate * MAX_FILE_S));
      const mono = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
      }
      status.innerHTML = '<span class="spinner"></span> Analysing ' + (n / buf.sampleRate).toFixed(0) + ' s of audio...';
      await indexReady;
      const m = await analyze(mono, buf.sampleRate, { final: true, maxNotes: 450 });
      if (!alive) return;
      status.textContent = `${f.name}: ${m.result.duration.toFixed(0)} s analysed in ${(m.ms / 1000).toFixed(1)} s`;
      renderResult(result, m.result, true);
    } catch (err) {
      status.textContent = 'Could not read that file: ' + (err && err.message ? err.message : 'unsupported audio format');
    }
  });

  return () => {
    alive = false;
    stopMic(false);
  };
}
