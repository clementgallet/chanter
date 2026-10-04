'use strict';
const fs = require('fs');
const ABC = require('../lib/abc.js');
const D = require('../public/js/detector.js');
const { renderTune } = require('./synth.js');
const tunes = ABC.splitTunes(fs.readFileSync(__dirname + '/../tunes/demo-tunes.abc', 'utf8')).map((t) => ABC.parseTune(t.text));
const idx = +(process.argv[2] || 0);
const p = tunes[idx];
const t0 = Date.now();
const { samples, sr } = renderTune(p, { seed: 3, lowA: +(process.argv[3] || 470), maxSeconds: 15 });
const t1 = Date.now();
const tr = D.transcribe(samples, sr);
const t2 = Date.now();
console.log(p.title, 'synth', t1 - t0, 'ms; transcribe', t2 - t1, 'ms; dur', tr.duration.toFixed(1));
for (const h of tr.hypotheses) {
  console.log('P=', h.P.toFixed(1), 'score', h.tuningScore.toFixed(1), 'notes', h.notes.length);
  console.log(h.notes.map((n) => n.n).join(''));
}
console.log('exp', p.signature.notes.slice(0, 120));
