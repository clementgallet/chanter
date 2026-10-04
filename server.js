'use strict';
/**
 * chanter server: static PWA + JSON API, HTTP and (self-signed or mkcert) HTTPS.
 * No runtime dependencies beyond Node itself.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const library = require('./lib/library');
const { fetchText } = require('./lib/remote');
const { seedFromProject } = require('./lib/seed');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HTTP_PORT = +process.env.PORT || 8080;
const HTTPS_PORT = +process.env.HTTPS_PORT || 8443;
const HOST = process.env.HOST || '0.0.0.0';
const CERT_DIR = path.join(library.DATA_DIR, 'certs');
const MAX_BODY = 30 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.abc': 'text/plain; charset=utf-8',
  '.pem': 'application/x-pem-file',
};

// ------------------------------------------------------------------ helpers

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

function mergeResults(into, r) {
  into.added.push(...r.added);
  into.duplicates.push(...r.duplicates);
  into.skipped.push(...r.skipped);
}

// ------------------------------------------------------------------ API

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/health') return sendJson(res, 200, { ok: true, tunes: library.count() });

  if (p === '/api/library' && m === 'GET') {
    return sendJson(res, 200, { tunes: library.list(), categories: library.categories() });
  }

  if (p === '/api/detect-index' && m === 'GET') {
    return sendJson(res, 200, { tunes: library.detectIndex() });
  }

  if (p === '/api/import/files' && m === 'POST') {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) return sendJson(res, 400, { error: 'no files given' });
    const out = { added: [], duplicates: [], skipped: [] };
    for (const f of files) {
      if (!f || typeof f.text !== 'string') continue;
      mergeResults(out, await library.importText(f.text, String(f.name || 'upload.abc')));
    }
    return sendJson(res, 200, out);
  }

  if (p === '/api/import/text' && m === 'POST') {
    const body = await readJson(req);
    if (typeof body.text !== 'string' || !body.text.trim()) return sendJson(res, 400, { error: 'no text given' });
    return sendJson(res, 200, await library.importText(body.text, String(body.name || 'pasted.abc')));
  }

  if (p === '/api/import/url' && m === 'POST') {
    const body = await readJson(req);
    let remote;
    try {
      remote = await fetchText(String(body.url || ''));
    } catch (e) {
      return sendJson(res, 400, { error: 'Could not fetch the URL: ' + e.message });
    }
    const r = await library.importText(remote.text, remote.name);
    if (!r.added.length && !r.duplicates.length) r.error = 'The file did not contain any ABC tunes.';
    return sendJson(res, 200, r);
  }

  const tm = /^\/api\/tunes\/([0-9a-f]{8,32})(\.abc)?$/.exec(p);
  if (tm) {
    const id = tm[1];
    if (m === 'GET') {
      const t = library.get(id);
      if (!t) return sendJson(res, 404, { error: 'not found' });
      if (tm[2]) {
        res.writeHead(200, { 'content-type': MIME['.abc'], 'content-disposition': `attachment; filename="${id}.abc"` });
        return res.end(t.abc);
      }
      return sendJson(res, 200, t);
    }
    if (m === 'PATCH') {
      const r = await library.update(id, await readJson(req));
      return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: 'not found' });
    }
    if (m === 'DELETE') {
      return (await library.remove(id)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not found' });
    }
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

// ------------------------------------------------------------------ static files

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end();
  }
  if (rel === '/ca.pem') return serveCaRoot(res);
  // shared code lives in /lib so the browser and the server run the exact same parser
  let file;
  if (rel === '/lib/abc.js') file = path.join(__dirname, 'lib', 'abc.js');
  else file = path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel);
  const root = rel === '/lib/abc.js' ? path.join(__dirname, 'lib') : PUBLIC_DIR;
  if (!path.resolve(file).startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback for client-side routes (no extension)
      if (!path.extname(rel)) return serveStatic(req, res, new URL('/', 'http://x'));
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      // the app is small; always revalidate so edits show up immediately (the service worker handles offline)
      'cache-control': ext === '.html' || path.basename(file) === 'sw.js' ? 'no-cache' : 'public, max-age=0, must-revalidate',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveCaRoot(res) {
  const f = path.join(CERT_DIR, 'rootCA.pem');
  if (!fs.existsSync(f)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('No local CA available. Run `npm run cert:mkcert` first.');
  }
  res.writeHead(200, { 'content-type': MIME['.pem'], 'content-disposition': 'attachment; filename="chanter-rootCA.pem"' });
  fs.createReadStream(f).pipe(res);
}

// ------------------------------------------------------------------ request dispatch

async function onRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('x-content-type-options', 'nosniff');
  // microphone access only for this origin
  res.setHeader('permissions-policy', 'microphone=(self)');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'server error' : e.message });
    else res.end();
  }
}

// ------------------------------------------------------------------ TLS

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function ensureCertificate() {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert };
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const names = ['localhost', os.hostname(), ...lanAddresses()];
  const san = names.map((n) => (/^[\d.]+$/.test(n) ? 'IP:' + n : 'DNS:' + n)).concat(['IP:127.0.0.1']).join(',');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '825',
        '-subj', '/CN=chanter', '-addext', 'subjectAltName=' + san],
      { stdio: 'ignore' }
    );
    return { key, cert };
  } catch (e) {
    console.warn('! Could not create an HTTPS certificate (is openssl installed?). Serving plain HTTP only.');
    return null;
  }
}

// ------------------------------------------------------------------ start

async function main() {
  await seedFromProject(library);

  const httpServer = http.createServer(onRequest);
  httpServer.listen(HTTP_PORT, HOST);

  const lan = lanAddresses();
  console.log('\n  chanter - highland bagpipe score & tune detector');
  console.log(`  ${library.count()} tunes in the library (${library.DATA_DIR})\n`);
  console.log('  On this computer:  http://localhost:' + HTTP_PORT);

  if (process.env.NO_HTTPS !== '1') {
    const files = ensureCertificate();
    if (files) {
      const httpsServer = https.createServer({ key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert) }, onRequest);
      httpsServer.listen(HTTPS_PORT, HOST);
      for (const ip of lan) console.log(`  On your phone:     https://${ip}:${HTTPS_PORT}   (needed for microphone + install)`);
      console.log('\n  The HTTPS certificate is self-signed: accept the browser warning once, or see README for a trusted setup.');
    }
  } else {
    for (const ip of lan) console.log(`  On your network:   http://${ip}:${HTTP_PORT}   (no microphone / install without HTTPS)`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
