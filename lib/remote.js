'use strict';
/** Fetch a remote ABC file with size / time limits and without reaching into private networks. */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

/** GitHub "blob" pages are HTML; point at the raw file instead. */
function rewriteUrl(u) {
  if (u.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
    if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
  }
  return u;
}

function fetchOnce(u, allowPrivate) {
  return new Promise((resolve, reject) => {
    // Node does not call `lookup` for IP literals, so check those here
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && !allowPrivate && isPrivateAddress(literal)) {
      return reject(new Error('refusing to fetch from a private/loopback address'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: { 'user-agent': 'chanter/1.0', accept: 'text/plain, text/*;q=0.9, */*;q=0.5' },
        // validate the address we are actually going to connect to (prevents DNS rebinding tricks)
        lookup: (host, opts, cb) => {
          dns.lookup(host, { all: true }, (err, addrs) => {
            if (err) return cb(err);
            const ok = addrs.filter((a) => allowPrivate || !isPrivateAddress(a.address));
            if (!ok.length) return cb(new Error('refusing to fetch from a private/loopback address'));
            if (opts && opts.all) return cb(null, ok);
            cb(null, ok[0].address, ok[0].family);
          });
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: new URL(res.headers.location, u) });
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('remote server answered HTTP ' + res.statusCode));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error('file is larger than ' + MAX_BYTES / 1024 / 1024 + ' MB'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchText(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch (e) {
    throw new Error('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are supported');
  const allowPrivate = process.env.ALLOW_PRIVATE_URLS === '1';
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    u = rewriteUrl(u);
    const r = await fetchOnce(u, allowPrivate);
    if (r.redirect) {
      if (r.redirect.protocol !== 'http:' && r.redirect.protocol !== 'https:') throw new Error('bad redirect');
      u = r.redirect;
      continue;
    }
    const name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname) || 'remote.abc';
    return { text: r.body, name };
  }
  throw new Error('too many redirects');
}

module.exports = { fetchText, isPrivateAddress };
