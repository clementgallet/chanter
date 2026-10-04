'use strict';
// Creates a locally-trusted HTTPS certificate with mkcert (https://github.com/FiloSottile/mkcert)
// and stores it where server.js looks for it (data/certs). Restart the server afterwards.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(__dirname, '..', 'data', 'certs');
const run = (args) => execFileSync('mkcert', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

try {
  run(['-version']);
} catch (e) {
  console.error('mkcert is not installed. See https://github.com/FiloSottile/mkcert#installation');
  process.exit(1);
}

const names = new Set(['localhost', '127.0.0.1', '::1', os.hostname()]);
for (const list of Object.values(os.networkInterfaces())) {
  for (const i of list || []) if (i.family === 'IPv4' && !i.internal) names.add(i.address);
}
fs.mkdirSync(dir, { recursive: true });
run(['-install']);
run(['-key-file', path.join(dir, 'key.pem'), '-cert-file', path.join(dir, 'cert.pem'), ...names]);
const caRoot = run(['-CAROOT']).trim();
fs.copyFileSync(path.join(caRoot, 'rootCA.pem'), path.join(dir, 'rootCA.pem'));
console.log('Certificate written for: ' + [...names].join(', '));
console.log('Install the root CA on your phone by opening  http://<this-computer>:8080/ca.pem  (see README).');
console.log('Restart the server to use the new certificate.');
