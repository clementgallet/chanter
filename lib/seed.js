'use strict';
const fs = require('fs');
const path = require('path');

const TUNES_SRC = path.join(__dirname, '..', 'tunes');

function* abcFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* abcFiles(p);
    else if (/\.abc$/i.test(e.name)) yield p;
  }
}

/**
 * Import every .abc file under tunes/ (the tunes shipped with the project). Tunes that were imported
 * from there before are remembered, so deleting one in the app keeps it deleted.
 */
async function seedFromProject(library) {
  if (process.env.NO_SEED === '1' || !fs.existsSync(TUNES_SRC)) return 0;
  const seenFile = path.join(library.DATA_DIR, 'seeded.json');
  let seen = new Set();
  try { seen = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8'))); } catch (e) { /* first run */ }
  const before = seen.size;
  let added = 0;
  for (const f of [...abcFiles(TUNES_SRC)].sort()) {
    const r = await library.importText(fs.readFileSync(f, 'utf8'), path.relative(TUNES_SRC, f), { original: false, skipIds: seen });
    for (const t of [...r.added, ...r.duplicates]) seen.add(t.id);
    added += r.added.length;
  }
  if (seen.size !== before) fs.writeFileSync(seenFile, JSON.stringify([...seen]));
  return added;
}

module.exports = { seedFromProject, TUNES_SRC };
