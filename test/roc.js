'use strict';
// Compare library-wide E-values for true matches (varied conditions) and for tunes not in the library.
const fs = require('fs');
const ABC = require('../lib/abc.js');
const D = require('../public/js/detector.js');
const { renderTune, randomTune } = require('./synth.js');
const demo = ABC.splitTunes(fs.readFileSync(__dirname + '/../tunes/demo-tunes.abc', 'utf8')).map((t) => ABC.parseTune(t.text));
const FILL = +(process.env.FILL || 300);
const entries = demo.map((p, i) => ({ id: 'd' + i, title: p.title, notes: p.signature.notes }));
for (let i = 0; i < FILL; i++) entries.push({ id: 'r' + i, title: 'rand' + i, notes: randomTune(i + 1, 90 + (i * 37) % 200) });
const matcher = new D.Matcher(entries);
console.log('lambda', matcher.lambda.toFixed(3), 'K', matcher.K.toExponential(2));
function fake(notes) {
  const tl = []; let t = 0;
  for (const c of notes) { tl.push({ type: 'note', inRange: true, t, dur: 0.125, d: +c, graces: [] }); t += 0.125; }
  return { tempo: { bpm: 80, unit: 0.25 }, timeline: tl };
}
const pos = [], neg = [];
const conds = [{ maxSeconds: 8, startNote: 5 }, { maxSeconds: 12, noise: 8 }, { maxSeconds: 10, tempoJitter: 0.3, startNote: 3 }, { maxSeconds: 6, startNote: 12 }];
demo.forEach((p, i) => conds.forEach((c, j) => {
  const { samples, sr } = renderTune(p, Object.assign({ seed: i * 5 + j + 1 }, c));
  const r = D.detect(samples, sr, matcher);
  pos.push({ ok: r.results[0] && r.results[0].id === 'd' + i, logE: r.logEvalue, p: r.results[0] ? r.results[0].prob : 0, n: r.notes.length });
}));
for (let k = 0; k < 60; k++) {
  const { samples, sr } = renderTune(fake(randomTune(7000 + k, 80)), { maxSeconds: 6 + (k % 4) * 3, seed: k + 100 });
  const r = D.detect(samples, sr, matcher);
  neg.push({ logE: r.logEvalue, p: r.results[0] ? r.results[0].prob : 0, n: r.notes.length });
}
console.log('positives correct', pos.filter((x) => x.ok).length + '/' + pos.length);
const q = (a, f) => a.map(f).sort((x, y) => x - y);
const pl = q(pos, (x) => x.logE), nl = q(neg, (x) => x.logE);
console.log('pos logEvalue  min/med/max', pl[0].toFixed(1), pl[pl.length >> 1].toFixed(1), pl[pl.length - 1].toFixed(1));
console.log('neg logEvalue  min/med/max', nl[0].toFixed(1), nl[nl.length >> 1].toFixed(1), nl[nl.length - 1].toFixed(1));
const bad = pos.filter((x) => !x.ok || x.logE > -3);
console.log('weak/wrong positives:', bad.map((x) => `ok=${x.ok} logE=${x.logE.toFixed(1)} n=${x.n}`).join(' | ') || 'none');
for (const th of [-2, -3, -4.6]) console.log(`threshold E<${Math.exp(th).toFixed(3)}: pos accepted ${pos.filter((x) => x.ok && x.logE < th).length}/${pos.length}, neg accepted ${neg.filter((x) => x.logE < th).length}/${neg.length}`);
