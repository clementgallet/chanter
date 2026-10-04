'use strict';
/**
 * Tune library on disk:
 *   data/library.json          index (metadata + detection signature per tune)
 *   data/tunes/<id>.abc        one file per tune (id = hash of the normalised tune text)
 *   data/imports/<ts>-<name>   the original imported file, kept as-is
 */
const fs = require('fs');
const path = require('path');
const ABC = require('./abc.js');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const TUNES_DIR = path.join(DATA_DIR, 'tunes');
const IMPORTS_DIR = path.join(DATA_DIR, 'imports');
const INDEX_FILE = path.join(DATA_DIR, 'library.json');

fs.mkdirSync(TUNES_DIR, { recursive: true });
fs.mkdirSync(IMPORTS_DIR, { recursive: true });

let index = { version: 1, tunes: {} };
try {
  index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  if (!index.tunes) index.tunes = {};
} catch (e) {
  /* first run */
}

// bump when the parser / signature format changes: signatures are rebuilt from the stored .abc files at startup
const SIG_VERSION = 1;

let writeChain = Promise.resolve();
function saveIndex() {
  // serialise writes; write to a temp file then rename so a crash never leaves a half-written index
  writeChain = writeChain.then(async () => {
    const tmp = INDEX_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(index));
    await fs.promises.rename(tmp, INDEX_FILE);
  });
  return writeChain;
}

function reindexIfNeeded() {
  if (index.sigVersion === SIG_VERSION) return;
  for (const id of Object.keys(index.tunes)) {
    try {
      const abc = fs.readFileSync(path.join(TUNES_DIR, id + '.abc'), 'utf8');
      const p = ABC.parseTune(abc);
      const e = index.tunes[id];
      e.noteCount = p.noteCount;
      e.measures = p.measures;
      e.warnings = p.warnings;
      e.meter = p.meter;
      e.key = p.key;
      e.sig = { notes: p.signature.notes, durs: p.signature.durs };
    } catch (err) {
      /* leave the entry as it was */
    }
  }
  index.sigVersion = SIG_VERSION;
  saveIndex();
}

function safeName(name) {
  return String(name || 'import.abc').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'import.abc';
}

reindexIfNeeded.call(null);

function metaOf(t) {
  // everything but the (potentially large) signature
  const { sig, ...rest } = t;
  return rest;
}

/**
 * Import ABC text (one or many tunes). Returns a summary of what happened.
 * opts.original=false skips keeping a copy of the file; opts.skipIds silently ignores those tune ids.
 */
async function importText(text, sourceName, opts) {
  opts = opts || {};
  const norm = ABC.normalizeText(text);
  const prepared = ABC.prepareImport(norm, sourceName);
  const result = { added: [], duplicates: [], skipped: prepared.skipped, file: null };
  if (opts.original !== false) {
    // keep the original file
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${stamp}-${safeName(sourceName)}`;
    await fs.promises.writeFile(path.join(IMPORTS_DIR, fileName), norm);
    result.file = fileName;
  }
  for (const t of prepared.tunes) {
    if (opts.skipIds && opts.skipIds.has(t.id)) continue;
    if (index.tunes[t.id]) {
      result.duplicates.push({ id: t.id, title: t.entry.title });
      continue;
    }
    await fs.promises.writeFile(path.join(TUNES_DIR, t.id + '.abc'), t.stored);
    index.tunes[t.id] = t.entry;
    result.added.push({ id: t.id, title: t.entry.title, category: t.entry.category });
  }
  await saveIndex();
  return result;
}

function list() {
  return Object.values(index.tunes)
    .map(metaOf)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
}

function categories() {
  const counts = {};
  for (const t of Object.values(index.tunes)) counts[t.category] = (counts[t.category] || 0) + 1;
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function get(id) {
  const e = index.tunes[id];
  if (!e) return null;
  let abc = '';
  try {
    abc = fs.readFileSync(path.join(TUNES_DIR, id + '.abc'), 'utf8');
  } catch (err) {
    return null;
  }
  return { meta: metaOf(e), abc };
}

function detectIndex() {
  return Object.values(index.tunes).map((t) => ({ id: t.id, title: t.title, notes: t.sig.notes, durs: t.sig.durs }));
}

async function update(id, patch) {
  const e = index.tunes[id];
  if (!e) return null;
  if (typeof patch.category === 'string' && patch.category.trim()) e.category = patch.category.trim().slice(0, 60);
  if (typeof patch.title === 'string' && patch.title.trim()) e.title = patch.title.trim().slice(0, 200);
  await saveIndex();
  return metaOf(e);
}

async function remove(id) {
  if (!index.tunes[id]) return false;
  delete index.tunes[id];
  try {
    await fs.promises.unlink(path.join(TUNES_DIR, id + '.abc'));
  } catch (e) {
    /* already gone */
  }
  await saveIndex();
  return true;
}

function count() {
  return Object.keys(index.tunes).length;
}

module.exports = { importText, list, categories, get, detectIndex, update, remove, count, DATA_DIR };
