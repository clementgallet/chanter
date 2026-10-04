'use strict';
// Builds the static site (dist/) for hosting on GitHub Pages or any static file host:
// the app from public/, plus every .abc file under tunes/ baked into dist/data/.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-build-'));
process.env.DATA_DIR = tmp; // build the index in a scratch library so the real data/ is untouched
delete process.env.NO_SEED;

const library = require('../lib/library.js');
const { seedFromProject } = require('../lib/seed.js');

(async () => {
  const added = await seedFromProject(library);

  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'public'), out, { recursive: true });
  fs.mkdirSync(path.join(out, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(root, 'lib', 'abc.js'), path.join(out, 'lib', 'abc.js'));
  fs.writeFileSync(path.join(out, 'config.js'), 'window.CHANTER_STATIC = true;\n');
  fs.writeFileSync(path.join(out, '.nojekyll'), '');

  const data = path.join(out, 'data');
  fs.mkdirSync(path.join(data, 'tunes'), { recursive: true });
  const tunes = library.list();
  fs.writeFileSync(path.join(data, 'library.json'), JSON.stringify({ tunes, categories: library.categories() }));
  fs.writeFileSync(path.join(data, 'detect-index.json'), JSON.stringify({ tunes: library.detectIndex() }));
  for (const t of tunes) fs.copyFileSync(path.join(tmp, 'tunes', t.id + '.abc'), path.join(data, 'tunes', t.id + '.abc'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Built dist/ with ${added} tunes from tunes/ (${library.categories().map((c) => `${c.name}: ${c.count}`).join(', ')})`);
  if (!added) console.warn('! No tunes found: put .abc files in the tunes/ folder.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
