'use strict';
// Matcher robustness to transcription errors, independent of audio: corrupt true note strings and look up.
const fs = require('fs');
const ABC = require('../lib/abc.js');
const D = require('../public/js/detector.js');
const { randomTune, rng } = require('./synth.js');
const demo = ABC.splitTunes(fs.readFileSync(__dirname + '/../tunes/demo-tunes.abc', 'utf8')).map((t) => ABC.parseTune(t.text));
const entries = demo.map((p, i) => ({ id: 'd' + i, title: p.title, notes: p.signature.notes }));
for (let i = 0; i < 500; i++) entries.push({ id: 'r' + i, title: 'r' + i, notes: randomTune(i + 1, 90 + (i * 37) % 200) });
const m = new D.Matcher(entries);
const r = rng(99);
function corrupt(s, rate) {
  const out = [];
  for (const ch of s) {
    const x = r();
    if (x < rate / 3) continue;                              // deletion
    if (x < (2 * rate) / 3) { out.push(Math.floor(r() * 9)); continue; } // substitution
    out.push(+ch);
    if (x > 1 - rate / 3) out.push(Math.floor(r() * 9));      // insertion
  }
  return out;
}
for (const len of [15, 25, 40]) for (const rate of [0, 0.1, 0.2, 0.3, 0.4]) {
  let ok = 0, n = 0;
  for (let i = 0; i < demo.length; i++) for (let k = 0; k < 4; k++) {
    const sig = entries[i].notes;
    const a = Math.floor(r() * Math.max(1, sig.length - len));
    const q = corrupt(sig.slice(a, a + len), rate).map((x) => ({ n: x, dur: 0.3 }));
    const res = m.match(q);
    n++; if (res.results[0] && res.results[0].id === 'd' + i) ok++;
  }
  console.log(`len ${len} error ${rate}: ${ok}/${n}`);
}
