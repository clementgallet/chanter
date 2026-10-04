import { Player } from './player.js';
import * as Store from './store.js';
import { mountDetect, onLibraryChanged } from './detect-ui.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const titleEl = $('#title');
const backBtn = $('#back');
const ABC = window.PipeABC;

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = 0;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ------------------------------------------------------------------ state

let library = null; // { tunes, categories }
const ui = { q: '', cat: 'All', scroll: 0 };
let cleanup = null; // called when leaving a view

async function loadLibrary(force) {
  if (library && !force) return library;
  library = await Store.loadLibrary();
  return library;
}

function setHeader(title, back) {
  titleEl.textContent = title;
  backBtn.hidden = !back;
  document.title = title === 'Chanter' ? title : title + ' - Chanter';
}
backBtn.addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));

function setTab(name) {
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.tab === name);
}

// ------------------------------------------------------------------ router

async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  try {
    if ((m = /^\/tune\/([0-9a-f]+)$/.exec(hash))) { setTab('library'); await tuneView(m[1]); }
    else if (hash === '/detect') { setTab('detect'); setHeader('Detect a tune', false); cleanup = await mountDetect(view); }
    else if (hash === '/import') { setTab('import'); setHeader('Import tunes', false); importView(); }
    else { setTab('library'); setHeader('Chanter', false); await libraryView(); }
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}<br><br><a class="btn" href="#/">Back to tunes</a></div>`;
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ library

function matches(t, q) {
  if (!q) return true;
  const hay = [t.title, ...(t.altTitles || []), t.composer || '', t.category || ''].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

async function libraryView() {
  view.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  const lib = await loadLibrary(true);
  view.innerHTML = `
    <div class="view-wide">
      <input id="q" class="input" type="search" placeholder="Search tunes by name" autocomplete="off" enterkeyhint="search" value="${esc(ui.q)}">
      <div class="chips" id="chips"></div>
      <div id="list"></div>
    </div>`;
  const chips = $('#chips');
  const list = $('#list');
  const cats = ['All', ...lib.categories.map((c) => c.name)];
  if (!cats.includes(ui.cat)) ui.cat = 'All';
  const count = (c) => (c === 'All' ? lib.tunes.length : (lib.categories.find((x) => x.name === c) || {}).count || 0);
  chips.innerHTML = cats.map((c) => `<button class="chip${c === ui.cat ? ' active' : ''}" data-c="${esc(c)}">${esc(c)}<small>${count(c)}</small></button>`).join('');
  const row = (t) => `<li><a href="#/tune/${t.id}"><div class="grow"><div class="t">${esc(t.title)}</div><div class="s">${esc([t.rhythm || t.category, t.meter, t.composer].filter(Boolean).join(' · '))}</div></div>${t.local ? '<span class="badge" title="imported on this device">mine</span>' : ''}${t.warnings && t.warnings.length ? '<span class="badge" title="parsing notes">!</span>' : ''}</a></li>`;
  function draw() {
    const items = lib.tunes.filter((t) => (ui.cat === 'All' || t.category === ui.cat) && matches(t, ui.q));
    if (!lib.tunes.length) { list.innerHTML = '<div class="empty">No tunes yet.<br><br><a class="btn primary" href="#/import">Import ABC files</a></div>'; return; }
    if (!items.length) { list.innerHTML = '<div class="empty">No tunes match.</div>'; return; }
    if (ui.cat === 'All' && !ui.q) {
      const groups = {};
      for (const t of items) (groups[t.category] = groups[t.category] || []).push(t);
      list.innerHTML = Object.keys(groups).sort().map((g) => `<div class="group-title">${esc(g)}</div><ul class="tune-list">${groups[g].map(row).join('')}</ul>`).join('');
    } else {
      list.innerHTML = `<ul class="tune-list">${items.map(row).join('')}</ul>`;
    }
  }
  draw();
  $('#q').addEventListener('input', (e) => { ui.q = e.target.value.trim(); draw(); });
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    ui.cat = b.dataset.c;
    for (const c of chips.children) c.classList.toggle('active', c === b);
    draw();
  });
  view.scrollTop = ui.scroll;
  const onScroll = () => { ui.scroll = view.scrollTop; };
  view.addEventListener('scroll', onScroll, { passive: true });
  cleanup = () => view.removeEventListener('scroll', onScroll);
}

// ------------------------------------------------------------------ tune view

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function tuneView(id) {
  view.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  const { meta, abc } = await Store.getTune(id);
  setHeader(meta.title, true);
  const parsed = ABC.parseTune(abc);
  view.innerHTML = `
    <div class="view-wide">
      <div class="player">
        <div class="controls">
          <button class="play-btn" id="play" aria-label="Play">&#9654;</button>
          <div class="progress" id="prog"><div class="bar"></div><div class="knob"></div></div>
          <div class="time" id="time">0:00 / 0:00</div>
        </div>
        <div class="opts">
          <label>Speed <input type="range" id="rate" min="40" max="150" step="5" value="100"><span id="ratev">100%</span></label>
          <label><input type="checkbox" id="drones"> Drones</label>
          <label><input type="checkbox" id="follow" checked> Follow</label>
        </div>
      </div>
      <div class="meta">
        <span class="badge">${esc(meta.category)}</span>
        ${meta.meter ? `<span class="badge">${esc(meta.meter)}</span>` : ''}
        ${meta.composer ? `<span class="badge">${esc(meta.composer)}</span>` : ''}
        <span class="badge">${meta.noteCount} notes</span>
      </div>
      ${meta.warnings && meta.warnings.length ? `<p class="warn">Parsing notes: ${esc(meta.warnings.slice(0, 3).join('; '))}</p>` : ''}
      <div id="score"></div>
      <div class="row" style="margin-top:16px">
        <button class="btn small" id="dl">Download ABC</button>
        <button class="btn small" id="recat">Change category</button>
        <button class="btn small danger" id="del">Delete</button>
      </div>
    </div>`;

  // ---- score
  const scoreEl = $('#score');
  const visual = ABCJS.renderAbc(scoreEl, abc, {
    responsive: 'resize',
    add_classes: true,
    staffwidth: Math.min(900, Math.max(280, view.clientWidth - 40)),
    paddingtop: 6, paddingbottom: 6, paddingleft: 6, paddingright: 6,
    clickListener: (abcelem) => {
      const idx = entryFor(abcelem);
      if (idx >= 0) player.seekToEntry(idx);
    },
  })[0];

  // map each playable entry to its rendered element (abcjs groups grace notes with their main note,
  // so match by source range containment rather than exact start offset)
  const rendered = [];
  const sel = (visual && visual.engraver && visual.engraver.selectables) || [];
  for (const s of sel) {
    const el = s.svgEl;
    const ae = s.absEl && s.absEl.abcelem;
    if (!el || !ae || ae.startChar == null) continue;
    if (!/abcjs-(note|rest)/.test(el.getAttribute('class') || '')) continue;
    rendered.push({ a: ae.startChar, b: ae.endChar, el });
  }
  const elFor = new Map();
  for (const e of parsed.timeline) {
    if (elFor.has(e.start)) continue;
    let best = null;
    for (const r of rendered) {
      if (r.a <= e.start && e.start < r.b && (!best || r.b - r.a < best.b - best.a)) best = r;
    }
    if (best) elFor.set(e.start, best.el);
  }
  const entryFor = (abcelem) => {
    let k = player.entries.findIndex((e) => e.start >= abcelem.startChar && e.start < abcelem.endChar);
    return k;
  };

  // ---- player
  let lit = null;
  const bar = $('.progress .bar');
  const knob = $('.progress .knob');
  const playBtn = $('#play');
  const player = new Player(parsed, {
    onEvent(idx, e) {
      if (lit) lit.classList.remove('playing');
      lit = null;
      if (idx < 0 || !e) return;
      const el = elFor.get(e.start);
      if (!el) return;
      el.classList.add('playing');
      lit = el;
      if ($('#follow').checked) {
        const r = el.getBoundingClientRect();
        const vr = view.getBoundingClientRect();
        const top = vr.top + 130;
        if (r.top < top || r.bottom > vr.bottom - 90) view.scrollBy({ top: r.top - top - 20, behavior: 'smooth' });
      }
    },
    onTime(t, total) {
      const f = total ? t / total : 0;
      bar.style.width = f * 100 + '%';
      knob.style.left = f * 100 + '%';
      $('#time').textContent = `${fmtTime(t / player.rate)} / ${fmtTime(total / player.rate)}`;
    },
    onState(s) { playBtn.innerHTML = s === 'playing' ? '&#10074;&#10074;' : '&#9654;'; },
  });
  player.h.onTime(0, player.total);
  playBtn.addEventListener('click', () => (player.state === 'playing' ? player.pause() : player.play()));
  $('#rate').addEventListener('input', (e) => { $('#ratev').textContent = e.target.value + '%'; });
  $('#rate').addEventListener('change', (e) => { player.setRate(+e.target.value / 100); player.h.onTime(player.pos, player.total); });
  $('#drones').addEventListener('change', (e) => player.setDrones(e.target.checked));
  const prog = $('#prog');
  const seekFromEvent = (ev) => { const r = prog.getBoundingClientRect(); player.seekFraction((ev.clientX - r.left) / r.width); };
  let dragging = false;
  prog.addEventListener('pointerdown', (ev) => { dragging = true; prog.setPointerCapture(ev.pointerId); seekFromEvent(ev); });
  prog.addEventListener('pointermove', (ev) => { if (dragging) seekFromEvent(ev); });
  prog.addEventListener('pointerup', () => { dragging = false; });

  $('#del').addEventListener('click', async () => {
    const msg = Store.isStatic && !meta.local ? `Hide "${meta.title}" on this device? (It stays in the shared library and can be imported again.)` : `Delete "${meta.title}" from the library?`;
    if (!confirm(msg)) return;
    await Store.removeTune(id);
    library = null;
    onLibraryChanged();
    toast('Tune deleted');
    location.hash = '#/';
  });
  $('#dl').addEventListener('click', () => Store.downloadAbc(id, meta.title).catch((e) => toast(e.message)));
  $('#recat').addEventListener('click', async () => {
    const c = prompt('Category for this tune:', meta.category);
    if (!c || !c.trim()) return;
    await Store.updateTune(id, { category: c.trim() });
    library = null;
    toast('Category updated');
    tuneView(id);
  });
  view.scrollTop = 0;
  cleanup = () => player.dispose();
}

// ------------------------------------------------------------------ import

function importView() {
  view.innerHTML = `
    <div class="view-wide">
      <div class="card stack">
        <h2>From files</h2>
        ${Store.isStatic ? '<div class="small muted">Tunes you import are saved in this browser on this device only. Tunes added to the project\'s <b>tunes</b> folder are shared with everyone.</div>' : ''}
        <div class="drop" id="drop">Drop .abc files here, or<br><br>
          <label class="btn primary">Choose files<input type="file" id="files" accept=".abc,.txt,text/plain,text/vnd.abc" multiple hidden></label>
        </div>
      </div>
      <div class="card stack">
        <h2>From a web address</h2>
        <input id="url" class="input" type="url" inputmode="url" placeholder="https://example.com/tunes.abc" autocapitalize="off" autocorrect="off">
        <button class="btn primary" id="fetch">Fetch and import</button>
        <div class="small muted">GitHub file links work too. ${Store.isStatic ? 'Your browser downloads the file, so the site must allow it.' : 'The server downloads the file, so it needs to reach the address.'}</div>
      </div>
      <div class="card stack">
        <h2>Paste ABC text</h2>
        <textarea id="paste" class="input" placeholder="X:1&#10;T:My tune&#10;M:2/4&#10;L:1/8&#10;K:HP&#10;..." spellcheck="false"></textarea>
        <button class="btn primary" id="pasteGo">Import pasted text</button>
      </div>
      <div id="out"></div>
    </div>`;
  const out = $('#out');
  const show = (r, err) => {
    if (err) { out.innerHTML = `<div class="card"><span class="verdict none">${esc(err)}</span></div>`; return; }
    const li = [];
    for (const t of r.added) li.push(`<li class="ok">+ ${esc(t.title)} <span class="muted">(${esc(t.category)})</span></li>`);
    for (const t of r.duplicates) li.push(`<li class="muted">= ${esc(t.title)} already in the library</li>`);
    for (const t of r.skipped) li.push(`<li class="verdict none">! ${esc(t.title)}: ${esc(t.reason)}</li>`);
    out.innerHTML = `<div class="card"><h2>${r.added.length} added${r.duplicates.length ? ', ' + r.duplicates.length + ' already there' : ''}${r.skipped.length ? ', ' + r.skipped.length + ' skipped' : ''}</h2><ul class="result-list">${li.join('')}</ul>${r.added.length ? '<a class="btn primary" href="#/">Browse tunes</a>' : ''}</div>`;
    if (r.added.length) { library = null; onLibraryChanged(); }
  };
  const busy = (b, on, label) => { b.disabled = on; if (label) b.textContent = label; };
  async function sendFiles(fileList) {
    const files = [];
    for (const f of fileList) files.push({ name: f.name, text: await f.text() });
    if (!files.length) return;
    out.innerHTML = '<div class="card"><span class="spinner"></span> Importing...</div>';
    try { show(await Store.importFiles(files)); } catch (e) { show(null, e.message); }
  }
  $('#files').addEventListener('change', (e) => { sendFiles(e.target.files); e.target.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); sendFiles(e.dataTransfer.files); });
  $('#fetch').addEventListener('click', async (e) => {
    const url = $('#url').value.trim();
    if (!url) return toast('Enter a web address first');
    busy(e.target, true, 'Fetching...');
    try { const r = await Store.importUrl(url); r.error && !r.added.length && !r.duplicates.length ? show(null, r.error) : show(r); } catch (err) { show(null, err.message); }
    busy(e.target, false, 'Fetch and import');
  });
  $('#pasteGo').addEventListener('click', async (e) => {
    const text = $('#paste').value;
    if (!text.trim()) return toast('Paste some ABC first');
    busy(e.target, true);
    try { show(await Store.importText(text, 'pasted.abc')); } catch (err) { show(null, err.message); }
    busy(e.target, false);
  });
}

// ------------------------------------------------------------------ boot

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker:', e));
}
route();
