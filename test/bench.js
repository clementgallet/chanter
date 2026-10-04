'use strict';
// Synthetic benchmark: detection accuracy of the 12 demo tunes inside a library padded with random tunes.
const fs = require('fs');
const ABC = require('../lib/abc.js');
const D = require('../public/js/detector.js');
const { renderTune, randomTune } = require('./synth.js');

const demo = ABC.splitTunes(fs.readFileSync(__dirname + '/../tunes/demo-tunes.abc', 'utf8')).map((t) => ABC.parseTune(t.text));
const FILL = +(process.env.FILL || 300);
const entries = demo.map((p, i) => ({ id: 'd' + i, title: p.title, notes: p.signature.notes }));
for (let i = 0; i < FILL; i++) entries.push({ id: 'r' + i, title: 'rand' + i, notes: randomTune(i + 1, 90 + (i * 37) % 200) });
const matcher = new D.Matcher(entries);

const SCEN = {
  clean: { noise: 40, drones: 0, reverb: 0 },
  base: {},
  'tune-430': { lowA: 430 },
  'tune-500': { lowA: 500 },
  'drone-loud': { drones: 3 },
  'noisy-10dB': { noise: 10 },
  'noisy-5dB': { noise: 5 },
  reverb: { reverb: 1 },
  'tempo-jitter': { tempoJitter: 0.35 },
  'fast': { tempoScale: 1.5 },
  'slow': { tempoScale: 0.7 },
  'short-7s': { maxSeconds: 7, startNote: 9 },
  'short-5s': { maxSeconds: 5, startNote: 14 },
  'gracey': { graceMs: 40 },
  'sloppy-tuning': { noteDevCents: 22 },
};
const only = (process.argv[2] || '').split(',').filter(Boolean);
const names = only.length ? only : Object.keys(SCEN);
let grand = 0, grandN = 0;
for (const name of names) {
  const sc = SCEN[name];
  let top1 = 0, top3 = 0, n = 0, confSum = 0, tms = 0;
  const miss = [];
  demo.forEach((p, i) => {
    const o = Object.assign({ maxSeconds: 12, seed: i + 11 }, sc);
    const { samples, sr } = renderTune(p, o);
    const t0 = Date.now();
    const r = D.detect(samples, sr, matcher);
    tms += Date.now() - t0;
    n++;
    const ids = r.results.map((x) => x.id);
    if (ids[0] === 'd' + i) { top1++; confSum += r.results[0].prob; }
    else miss.push(`${i}->${ids[0]}(${(r.results[0] ? r.results[0].prob : 0).toFixed(2)}) n=${r.notes.length}`);
    if (ids.slice(0, 3).includes('d' + i)) top3++;
  });
  grand += top1; grandN += n;
  console.log(name.padEnd(14), `top1 ${top1}/${n}  top3 ${top3}/${n}  meanP(correct) ${(confSum / Math.max(1, top1)).toFixed(2)}  ${Math.round(tms / n)}ms/clip`, miss.length ? ' MISS ' + miss.join(' ') : '');
}
console.log('overall', grand + '/' + grandN);
if (grand < grandN * 0.95) { console.error('FAIL: top-1 accuracy below 95%'); process.exit(1); }
