// Library access for the UI. Two backends behind one interface:
//  - server: the Node server's JSON API (library stored on the server)
//  - static: tunes baked into the site at build time (data/*.json) plus tunes imported on this device (IndexedDB)
const ABC = window.PipeABC;
export const isStatic = !!window.CHANTER_STATIC;

// ------------------------------------------------------------------ server backend

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* not json */ }
  if (!res.ok) throw new Error((data && data.error) || 'request failed (' + res.status + ')');
  return data;
}
const send = (method, path, body) => api(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const server = {
  library: () => api('./api/library'),
  get: (id) => api('./api/tunes/' + id),
  detectIndex: async () => (await api('./api/detect-index')).tunes,
  importFiles: (files) => send('POST', './api/import/files', { files }),
  importText: (text, name) => send('POST', './api/import/text', { text, name }),
  importUrl: (url) => send('POST', './api/import/url', { url }),
  update: (id, patch) => send('PATCH', './api/tunes/' + id, patch),
  remove: (id) => send('DELETE', './api/tunes/' + id),
  abcText: async (id) => (await api('./api/tunes/' + id)).abc,
};

// ------------------------------------------------------------------ static backend

const DB_NAME = 'pipe-tunes';
let dbPromise = null;
const mem = { tunes: new Map(), kv: new Map() }; // used if IndexedDB is unavailable (e.g. some private modes)

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('tunes', { keyPath: 'id' });
          req.result.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const idb = {
  async allTunes() {
    const db = await openDb();
    if (!db) return [...mem.tunes.values()];
    return (await tx('tunes', 'readonly', (s) => s.getAll())) || [];
  },
  async putTune(rec) {
    const db = await openDb();
    if (!db) return void mem.tunes.set(rec.id, rec);
    await tx('tunes', 'readwrite', (s) => s.put(rec));
  },
  async delTune(id) {
    const db = await openDb();
    if (!db) return void mem.tunes.delete(id);
    await tx('tunes', 'readwrite', (s) => s.delete(id));
  },
  async getKv(key, fallback) {
    const db = await openDb();
    if (!db) return mem.kv.has(key) ? mem.kv.get(key) : fallback;
    const v = await tx('kv', 'readonly', (s) => s.get(key));
    return v === undefined ? fallback : v;
  },
  async setKv(key, value) {
    const db = await openDb();
    if (!db) return void mem.kv.set(key, value);
    await tx('kv', 'readwrite', (s) => s.put(value, key));
  },
};

let st = null; // loaded static state
async function loadStatic() {
  if (st) return st;
  const [lib, index, local, hidden, overrides] = await Promise.all([
    api('./data/library.json'),
    api('./data/detect-index.json'),
    idb.allTunes(),
    idb.getKv('hidden', []),
    idb.getKv('overrides', {}),
  ]);
  st = {
    bundled: new Map(lib.tunes.map((t) => [t.id, t])),
    index: index.tunes,
    local: new Map(local.map((r) => [r.id, r])),
    hidden: new Set(hidden),
    overrides: overrides || {},
  };
  return st;
}

const titleCmp = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });

function staticList(s) {
  const out = [];
  for (const [id, t] of s.bundled) if (!s.hidden.has(id)) out.push(Object.assign({}, t, s.overrides[id] || {}));
  for (const r of s.local.values()) {
    const { sig, ...meta } = r.meta;
    out.push(Object.assign(meta, { local: true }));
  }
  return out.sort(titleCmp);
}

function categoriesOf(tunes) {
  const counts = {};
  for (const t of tunes) counts[t.category] = (counts[t.category] || 0) + 1;
  return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

// GitHub "blob" pages are HTML; point at the raw file instead.
function rawUrl(u) {
  try {
    const x = new URL(u);
    if (x.hostname === 'github.com') {
      const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(x.pathname);
      if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    }
  } catch (e) { /* handled by fetch */ }
  return u;
}

async function staticImport(text, name) {
  const s = await loadStatic();
  const prepared = ABC.prepareImport(text, name);
  const result = { added: [], duplicates: [], skipped: prepared.skipped };
  let hiddenChanged = false;
  for (const t of prepared.tunes) {
    if (s.local.has(t.id) || (s.bundled.has(t.id) && !s.hidden.has(t.id))) {
      result.duplicates.push({ id: t.id, title: t.entry.title });
      continue;
    }
    if (s.bundled.has(t.id)) { // previously removed from this device: bring it back
      s.hidden.delete(t.id);
      hiddenChanged = true;
      result.added.push({ id: t.id, title: t.entry.title, category: t.entry.category });
      continue;
    }
    const rec = { id: t.id, meta: t.entry, abc: t.stored };
    await idb.putTune(rec);
    s.local.set(t.id, rec);
    result.added.push({ id: t.id, title: t.entry.title, category: t.entry.category });
  }
  if (hiddenChanged) await idb.setKv('hidden', [...s.hidden]);
  if (result.added.length && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return result;
}

const staticBackend = {
  async library() {
    const tunes = staticList(await loadStatic());
    return { tunes, categories: categoriesOf(tunes) };
  },
  async get(id) {
    const s = await loadStatic();
    const r = s.local.get(id);
    if (r) { const { sig, ...meta } = r.meta; return { meta: Object.assign(meta, { local: true }), abc: r.abc }; }
    const t = s.bundled.get(id);
    if (!t || s.hidden.has(id)) throw new Error('tune not found');
    const res = await fetch('./data/tunes/' + id + '.abc');
    if (!res.ok) throw new Error('could not load the tune (offline?)');
    return { meta: Object.assign({}, t, s.overrides[id] || {}), abc: await res.text() };
  },
  async detectIndex() {
    const s = await loadStatic();
    const out = s.index.filter((t) => !s.hidden.has(t.id));
    for (const r of s.local.values()) out.push({ id: r.id, title: r.meta.title, notes: r.meta.sig.notes, durs: r.meta.sig.durs });
    return out;
  },
  async importFiles(files) {
    const out = { added: [], duplicates: [], skipped: [] };
    for (const f of files) {
      const r = await staticImport(f.text, f.name);
      out.added.push(...r.added); out.duplicates.push(...r.duplicates); out.skipped.push(...r.skipped);
    }
    return out;
  },
  importText: (text, name) => staticImport(text, name),
  async importUrl(url) {
    let text;
    try {
      const res = await fetch(rawUrl(url));
      if (!res.ok) throw new Error('the server answered ' + res.status);
      text = await res.text();
    } catch (e) {
      throw new Error('Could not download that address from the browser (' + (e && e.message ? e.message : 'blocked') + '). The site may not allow it; GitHub links work. Otherwise download the file and import it from your device.');
    }
    const name = decodeURIComponent((new URL(rawUrl(url)).pathname.split('/').pop() || 'remote.abc'));
    const r = await staticImport(text, name);
    if (!r.added.length && !r.duplicates.length) r.error = 'The file did not contain any ABC tunes.';
    return r;
  },
  async update(id, patch) {
    const s = await loadStatic();
    const clean = {};
    if (typeof patch.category === 'string' && patch.category.trim()) clean.category = patch.category.trim().slice(0, 60);
    if (typeof patch.title === 'string' && patch.title.trim()) clean.title = patch.title.trim().slice(0, 200);
    const r = s.local.get(id);
    if (r) { Object.assign(r.meta, clean); await idb.putTune(r); return r.meta; }
    if (!s.bundled.has(id)) throw new Error('tune not found');
    s.overrides[id] = Object.assign(s.overrides[id] || {}, clean);
    await idb.setKv('overrides', s.overrides);
    return Object.assign({}, s.bundled.get(id), s.overrides[id]);
  },
  async remove(id) {
    const s = await loadStatic();
    if (s.local.has(id)) { s.local.delete(id); await idb.delTune(id); return { ok: true }; }
    if (!s.bundled.has(id)) throw new Error('tune not found');
    s.hidden.add(id);
    await idb.setKv('hidden', [...s.hidden]);
    return { ok: true };
  },
  async abcText(id) { return (await this.get(id)).abc; },
};

// ------------------------------------------------------------------ public interface

const backend = isStatic ? staticBackend : server;
export const loadLibrary = () => backend.library();
export const getTune = (id) => backend.get(id);
export const detectIndex = () => backend.detectIndex();
export const importFiles = (files) => backend.importFiles(files);
export const importText = (text, name) => backend.importText(text, name);
export const importUrl = (url) => backend.importUrl(url);
export const updateTune = (id, patch) => backend.update(id, patch);
export const removeTune = (id) => backend.remove(id);

export async function downloadAbc(id, title) {
  const abc = await backend.abcText(id);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([abc], { type: 'text/plain' }));
  a.download = (title || id).replace(/[^\w.\- ]+/g, '_') + '.abc';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
