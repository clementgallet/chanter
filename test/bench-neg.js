'use strict';
// False-positive test: play tunes that are NOT in the library; the answer should be "no match" (high pNull).
const fs = require('fs');
const ABC = require('../lib/abc.js');
const D = require('../public/js/detector.js');
const { renderTune, randomTune } = require('./synth.js');
const demo = ABC.splitTunes(fs.readFileSync(__dirname + '/../tunes/demo-tunes.abc', 'utf8')).map((t) => ABC.parseTune(t.text));
const FILL = +(process.env.FILL || 300);
const entries = demo.map((p, i) => ({ id: 'd' + i, title: p.title, notes: p.signature.notes }));
for (let i = 0; i < FILL; i++) entries.push({ id: 'r' + i, title: 'rand' + i, notes: randomTune(i + 1, 90 + (i * 37) % 200) });
const matcher = new D.Matcher(entries);
function fake(notes) {
  const tl = []; let t = 0;
  for (const c of notes) { tl.push({ type: 'note', inRange: true, t, dur: 0.125, d: +c, graces: Math.random() < 0 ? [] : [] }); t += 0.125; }
  return { tempo: { bpm: 80, unit: 0.25 }, timeline: tl };
}
let fp = 0, n = 0, maxP = 0;
for (let k = 0; k < 24; k++) {
  const notes = randomTune(5000 + k, 80);
  const { samples, sr } = renderTune(fake(notes), { maxSeconds: 14, seed: k + 3 });
  const r = D.detect(samples, sr, matcher);
  n++;
  const top = r.results[0];
  const p = top ? top.prob : 0;
  if (p > 0.5) fp++;
  maxP = Math.max(maxP, p);
  if (k < 6) console.log('neg', k, 'notes', r.notes.length, 'top', top && top.title, p.toFixed(3), 'pNull', r.pNull.toFixed(3));
}
console.log(`false positives (P>0.5): ${fp}/${n}, max P ${maxP.toFixed(3)}`);
if (fp > 0) { console.error('FAIL: false positives'); process.exit(1); }
