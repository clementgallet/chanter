'use strict';
// Serves dist/ the way GitHub Pages would (under a /<repo>/ sub-path) to test the static build locally.
const http = require('http');
const fs = require('fs');
const path = require('path');
const BASE = '/' + (process.env.BASE || 'chanter') + '/';
const PORT = +process.env.PORT || 8090;
const dist = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.abc': 'text/plain' };
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(BASE)) { res.writeHead(404); return res.end('not found (static site lives under ' + BASE + ')'); }
  let f = path.join(dist, p.slice(BASE.length) || 'index.html');
  if (f.endsWith(path.sep)) f += 'index.html';
  if (!path.resolve(f).startsWith(dist)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(b);
  });
}).listen(PORT, () => console.log(`Static build at http://localhost:${PORT}${BASE}`));
