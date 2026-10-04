/*
 * Great Highland Bagpipe ABC model.
 *
 * Parses ABC tunes into:
 *   - metadata (title, rhythm, meter, key, composer, tempo, category)
 *   - written events (with source char offsets, for score highlighting)
 *   - a play-order timeline (repeats / endings expanded)
 *   - a "melody signature": the chanter-note sequence used by tune detection
 *
 * The chanter has nine notes, written G A B c d e f g a. Notes are mapped by
 * letter/octave only (index 0..8), so key signatures / accidentals notations
 * (K:HP, K:Hp, K:D ...) all give the same result.
 *
 * Works in Node (CommonJS), browsers and workers (global PipeABC).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipeABC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NOTE_NAMES = ['G', 'A', 'B', 'C', 'D', 'E', 'F', 'g', 'a']; // chanter degrees, low G .. high A
  const LETTER_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
  const LOW_G_DIATONIC = 4 * 7 + 4; // G above middle C, as written in ABC "G"

  function normalizeText(text) {
    return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  }

  // ---------------------------------------------------------------- splitting

  /** Split an ABC file into tunes. Returns [{text, startLine}] */
  function splitTunes(fileText) {
    const text = normalizeText(fileText);
    const lines = text.split('\n');
    const tunes = [];
    let fileHeader = [];
    let cur = null;
    let seenX = false;

    const flush = () => {
      if (cur && cur.lines.some((l) => /^[KXT]:/.test(l))) {
        tunes.push({ text: cur.lines.join('\n').replace(/\s+$/, '') + '\n', startLine: cur.startLine });
      }
      cur = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^X:/.test(line)) {
        flush();
        seenX = true;
        cur = { lines: [line], startLine: i };
      } else if (cur) {
        if (line.trim() === '') {
          // a blank line terminates a tune
          flush();
        } else if (/^%%?\s*abc-version/.test(line)) {
          // ignore
        } else {
          cur.lines.push(line);
        }
      } else if (!seenX) {
        if (line.trim() !== '') fileHeader.push(line);
      }
    }
    flush();

    // Files with no X: fields: treat the whole thing as one tune
    if (!tunes.length) {
      const body = lines.filter((l) => !/^%%?\s*abc-version/.test(l)).join('\n').trim();
      if (/^K:/m.test(body)) tunes.push({ text: 'X:1\n' + body + '\n', startLine: 0 });
    }

    // Inherit file-header fields (e.g. a global L:/M:/R:) if the tune has none
    const globals = fileHeader.filter((l) => /^[A-Za-z]:/.test(l) && !/^[XTK]:/.test(l));
    if (globals.length) {
      for (const t of tunes) {
        const have = new Set((t.text.match(/^[A-Za-z](?=:)/gm) || []));
        const add = globals.filter((g) => !have.has(g[0]));
        if (add.length) {
          const idx = t.text.indexOf('\n') + 1;
          t.text = t.text.slice(0, idx) + add.join('\n') + '\n' + t.text.slice(idx);
        }
      }
    }
    return tunes;
  }

  // ---------------------------------------------------------------- header helpers

  function parseFraction(s) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s);
    if (m) return { num: +m[1], den: +m[2], value: +m[1] / +m[2] };
    return null;
  }

  function parseMeter(s) {
    s = (s || '').trim();
    if (!s || /^none$/i.test(s)) return { text: s || '', value: 1, num: 4, den: 4 };
    if (s === 'C') return { text: '4/4', value: 1, num: 4, den: 4 };
    if (s === 'C|') return { text: '2/2', value: 1, num: 2, den: 2 };
    const m = /^\(?([\d+\s()]+)\)?\s*\/\s*(\d+)$/.exec(s);
    if (m) {
      const nums = m[1].replace(/[()\s]/g, '').split('+').map(Number).filter(Boolean);
      const num = nums.reduce((a, b) => a + b, 0) || 4;
      const den = +m[2];
      return { text: num + '/' + den, value: num / den, num, den };
    }
    return { text: s, value: 1, num: 4, den: 4 };
  }

  function parseTempo(s) {
    // Q:1/4=80   Q:"Allegro" 1/4=120   Q:80   Q:3/8=50
    if (!s) return null;
    const stripped = s.replace(/"[^"]*"/g, '').trim();
    let m = /((?:\d+\/\d+\s*)+)=\s*(\d+)/.exec(stripped);
    if (m) {
      const parts = m[1].trim().split(/\s+/).map(parseFraction).filter(Boolean);
      const unit = parts.reduce((a, f) => a + f.value, 0);
      if (unit > 0 && +m[2] > 0) return { unit, bpm: +m[2] };
    }
    m = /^(\d+)$/.exec(stripped);
    if (m && +m[1] > 0) return { unit: 0.25, bpm: +m[1] };
    return null;
  }

  function parseHeaders(text) {
    const headers = { T: [] };
    const lines = text.split('\n');
    let bodyStart = lines.length;
    let offset = 0;
    let bodyOffset = text.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = /^([A-Za-z]):\s*(.*)$/.exec(line);
      if (m) {
        const k = m[1];
        const v = m[2].replace(/\s+%.*$/, '').trim();
        if (k === 'T') headers.T.push(v);
        else if (headers[k] === undefined) headers[k] = v;
        else if (k === 'C' || k === 'N' || k === 'H') headers[k] += '; ' + v;
        if (k === 'K') {
          bodyStart = i + 1;
          bodyOffset = offset + line.length + 1;
          break;
        }
      }
      offset += line.length + 1;
    }
    return { headers, bodyStart, bodyOffset };
  }

  // ---------------------------------------------------------------- category

  function titleCase(s) {
    return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  }

  function categoryOf(headers, meter) {
    const r = (headers.R || '').trim();
    const m = meter ? meter.text : '';
    const l = r.toLowerCase();
    if (l) {
      if (/strathspey/.test(l)) return 'Strathspey';
      if (/reel/.test(l)) return 'Reel';
      if (/hornpipe/.test(l)) return 'Hornpipe';
      if (/jig/.test(l)) return 'Jig';
      if (/retreat/.test(l)) return 'Retreat';
      if (/piobaireachd|pibroch|ceol\s*mor|ground/.test(l)) return 'Piobaireachd';
      if (/slow\s*march/.test(l)) return 'Slow March';
      if (/march/.test(l)) {
        const mm = /(\d\s*\/\s*\d)/.exec(l);
        if (mm) return mm[1].replace(/\s/g, '') + ' March';
        return m && /^(2\/4|3\/4|4\/4|6\/8|9\/8|12\/8)$/.test(m) ? m + ' March' : 'March';
      }
      if (/slow|air|lament|hymn|song/.test(l)) return 'Slow Air';
      if (/waltz/.test(l)) return 'Waltz';
      return titleCase(r);
    }
    // no R: field - infer from the meter
    switch (m) {
      case '2/4': return '2/4 March';
      case '6/8': return 'Jig';
      case '9/8': case '12/8': return 'Jig';
      case '3/4': return 'Waltz';
      case '2/2': return 'Reel';
      default: return 'Other';
    }
  }

  function defaultTempo(category, meter) {
    const c = category;
    const mt = meter ? meter.text : '4/4';
    if (/Strathspey/.test(c)) return { unit: 0.25, bpm: 126 };
    if (/Reel/.test(c)) return mt === '2/2' ? { unit: 0.5, bpm: 70 } : { unit: 0.25, bpm: 140 };
    if (/Hornpipe/.test(c)) return { unit: 0.25, bpm: 100 };
    if (/Jig/.test(c)) return mt === '6/8' ? { unit: 0.375, bpm: 100 } : { unit: 0.375, bpm: 100 };
    if (/Slow|Retreat|Piobaireachd/.test(c)) return { unit: 0.25, bpm: 56 };
    if (/March/.test(c)) return mt === '6/8' ? { unit: 0.375, bpm: 76 } : { unit: 0.25, bpm: 76 };
    return { unit: 0.25, bpm: 84 };
  }

  // ---------------------------------------------------------------- body parsing

  function noteIndex(letter, octaveShift) {
    const upper = letter.toUpperCase();
    const base = letter === upper ? 4 : 5;
    return base * 7 + LETTER_IDX[upper] + octaveShift - LOW_G_DIATONIC; // 0 = low G
  }

  /**
   * Parse one tune. Never throws on bad input; problems end up in warnings.
   */
  function parseTune(rawText) {
    const text = normalizeText(rawText);
    const { headers, bodyStart, bodyOffset } = parseHeaders(text);
    const warnings = [];

    let meter = parseMeter(headers.M || '4/4');
    let L = headers.L ? parseFraction(headers.L) : null;
    let unit = L ? L.value : meter.value < 0.75 ? 1 / 16 : 1 / 8;
    const category = categoryOf(headers, meter);
    let tempo = parseTempo(headers.Q) || null;
    const explicitTempo = !!tempo;
    if (!tempo) tempo = defaultTempo(category, meter);

    const events = []; // written order
    const items = []; // {type:'event',i} | {type:'bar', ...}
    let measure = 0;
    let eventsInMeasure = 0;

    let pendingGrace = [];
    let pendingBroken = null; // factor for next note
    let pendingTie = false;
    let tuplet = null; // {p,q,left}
    let firstVoice = null;
    let skipVoice = false;
    let outOfRange = 0;

    const lines = text.slice(bodyOffset).split('\n');
    let lineOffset = bodyOffset;

    const closeMeasure = () => {
      if (eventsInMeasure > 0) {
        measure++;
        eventsInMeasure = 0;
      }
    };

    const compoundMeter = () => meter.den === 8 && meter.num % 3 === 0;

    const pushEvent = (ev) => {
      ev.measure = measure;
      ev.i = events.length;
      events.push(ev);
      items.push({ type: 'event', i: ev.i });
      eventsInMeasure++;
    };

    const applyDuration = (mult) => {
      let d = unit * mult;
      if (tuplet && tuplet.left > 0) {
        d *= tuplet.q / tuplet.p;
        tuplet.left--;
        if (tuplet.left === 0) tuplet = null;
      }
      return d;
    };

    const readLength = (s, pos) => {
      let num = 1;
      let den = 1;
      let p = pos;
      let m = /^\d+/.exec(s.slice(p));
      if (m) {
        num = +m[0];
        p += m[0].length;
      }
      if (s[p] === '/') {
        let slashes = 0;
        while (s[p] === '/') {
          slashes++;
          p++;
        }
        m = slashes === 1 ? /^\d+/.exec(s.slice(p)) : null;
        if (m) {
          den = +m[0];
          p += m[0].length;
        } else den = Math.pow(2, slashes);
      }
      return { mult: num / (den || 1), end: p };
    };

    // Parse a single note head starting at pos (accidentals, letter, octave marks). Returns null if not a note.
    const readNoteHead = (s, pos) => {
      let p = pos;
      while (s[p] === '^' || s[p] === '_' || s[p] === '=') p++;
      const letter = s[p];
      if (!letter || !/[A-Ga-g]/.test(letter)) return null;
      p++;
      let shift = 0;
      while (s[p] === "'" || s[p] === ',') {
        shift += s[p] === "'" ? 1 : -1;
        p++;
      }
      return { d: noteIndex(letter, shift), end: p };
    };

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      const base = lineOffset;
      lineOffset += raw.length + 1;
      let s = raw;
      if (/^\s*%/.test(s)) continue;

      const fm = /^([A-Za-z]):(?![|:\]])\s*(.*)$/.exec(s);
      if (fm) {
        const k = fm[1];
        const v = fm[2].replace(/\s+%.*$/, '').trim();
        if (k === 'V') {
          const id = v.split(/\s+/)[0];
          if (firstVoice === null) firstVoice = id;
          skipVoice = id !== firstVoice;
        } else if (k === 'M') {
          meter = parseMeter(v);
        } else if (k === 'L') {
          const f = parseFraction(v);
          if (f) unit = f.value;
        } else if (k === 'Q') {
          const t = parseTempo(v);
          if (t && !explicitTempo) {
            /* tempo changes mid-tune are ignored; the header one wins */
          }
        }
        continue;
      }
      if (skipVoice) continue;
      if (/^\s*$/.test(s)) continue;

      let pos = 0;
      const n = s.length;
      while (pos < n) {
        const c = s[pos];

        if (c === '%') break;
        if (c === ' ' || c === '\t' || c === '\\' || c === '`' || c === '&') {
          pos++;
          continue;
        }
        if (c === '"') {
          const e = s.indexOf('"', pos + 1);
          pos = e < 0 ? n : e + 1;
          continue;
        }
        if (c === '!') {
          const e = s.indexOf('!', pos + 1);
          pos = e < 0 ? pos + 1 : e + 1;
          continue;
        }
        if (c === '+') {
          const e = s.indexOf('+', pos + 1);
          pos = e < 0 ? pos + 1 : e + 1;
          continue;
        }
        if (c === '{') {
          const e = s.indexOf('}', pos);
          const inner = s.slice(pos + 1, e < 0 ? n : e);
          let p = 0;
          while (p < inner.length) {
            const h = readNoteHead(inner, p);
            if (h) {
              pendingGrace.push(h.d);
              p = h.end;
            } else p++;
          }
          pos = e < 0 ? n : e + 1;
          continue;
        }
        if (c === '(') {
          const m = /^\((\d)(?::(\d*))?(?::(\d*))?/.exec(s.slice(pos));
          if (m) {
            const p = +m[1];
            let q = m[2] ? +m[2] : { 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 }[p] || (compoundMeter() ? 3 : 2);
            const r = m[3] ? +m[3] : p;
            tuplet = { p, q, left: r };
            pos += m[0].length;
          } else pos++;
          continue;
        }
        if (c === ')') {
          pos++;
          continue;
        }
        if (c === '[') {
          // inline field?
          const f = /^\[([A-Za-z]):([^\]]*)\]/.exec(s.slice(pos));
          if (f) {
            if (f[1] === 'M') meter = parseMeter(f[2].trim());
            else if (f[1] === 'L') {
              const fr = parseFraction(f[2]);
              if (fr) unit = fr.value;
            }
            pos += f[0].length;
            continue;
          }
          // volta start  [1  [2  [1,3
          const v = /^\[(\d+(?:[,-]\d+)*)/.exec(s.slice(pos));
          if (v) {
            items.push({ type: 'ending', nums: expandNums(v[1]) });
            pos += v[0].length;
            continue;
          }
          if (s[pos + 1] === '|' || s[pos + 1] === ']') {
            // thick-thin bar "[|"  handled by the bar branch below
          } else {
            // chord: take the highest chanter note
            const e = s.indexOf(']', pos);
            const inner = s.slice(pos + 1, e < 0 ? n : e);
            let best = null;
            let p = 0;
            let firstStart = -1;
            while (p < inner.length) {
              const h = readNoteHead(inner, p);
              if (h) {
                if (firstStart < 0) firstStart = p;
                if (best === null || h.d > best) best = h.d;
                p = h.end;
                const l = readLength(inner, p);
                p = l.end;
              } else p++;
            }
            let end = e < 0 ? n : e + 1;
            const outer = readLength(s, end);
            end = outer.end;
            if (best !== null) addNote(best, outer.mult, base + pos, base + end);
            pos = end;
            continue;
          }
        }
        if (c === '|' || c === ':' || c === ']' || c === '[') {
          let p = pos;
          while (p < n) {
            const ch = s[p];
            if (ch === '|' || ch === ':' || ch === ']') p++;
            else if (ch === '[' && (s[p + 1] === '|' || s[p + 1] === ']')) p++;
            else break;
          }
          const tok = s.slice(pos, p);
          if (tok === '') {
            pos++;
            continue;
          }
          const hasBar = /[|\]]/.test(tok);
          if (!hasBar && tok.indexOf('::') < 0) {
            // a lone ":" is not meaningful
            pos = p;
            continue;
          }
          const bar = { type: 'bar', tok, endRepeat: tok[0] === ':', startRepeat: tok.length > 1 && tok[tok.length - 1] === ':' };
          if (tok.indexOf('::') >= 0) bar.endRepeat = bar.startRepeat = true;
          // ending number directly after the bar:  |1  :|2
          const em = /^(\d+(?:[,-]\d+)*)/.exec(s.slice(p));
          if (em) {
            bar.ending = expandNums(em[1]);
            p += em[0].length;
          }
          items.push(bar);
          if (eventsInMeasure > 0) closeMeasure();
          pos = p;
          if (bar.ending) {
            items.push({ type: 'ending', nums: bar.ending });
          }
          continue;
        }
        if (c === '>' || c === '<') {
          let k = 0;
          while (s[pos] === c) {
            k++;
            pos++;
          }
          const f = 1 - Math.pow(0.5, k); // portion shifted
          const prev = events[events.length - 1];
          if (prev && prev.type === 'note' && prev.measure === measure) {
            if (c === '>') {
              prev.dur *= 1 + f;
              pendingBroken = 1 - f;
            } else {
              prev.dur *= 1 - f;
              pendingBroken = 1 + f;
            }
          }
          continue;
        }
        if (c === '-') {
          pendingTie = true;
          const prev = events[events.length - 1];
          if (prev) prev.tie = true;
          pos++;
          continue;
        }
        if (c === 'z' || c === 'x' || c === 'Z') {
          const l = readLength(s, pos + 1);
          let d = applyDuration(l.mult);
          if (c === 'Z') d = l.mult * meter.value;
          if (pendingBroken !== null) {
            d *= pendingBroken;
            pendingBroken = null;
          }
          pushEvent({ type: 'rest', dur: d, start: base + pos, end: base + l.end });
          pos = l.end;
          continue;
        }
        if (c === 'y') {
          pos++;
          continue;
        }
        const head = readNoteHead(s, pos);
        if (head) {
          const l = readLength(s, head.end);
          addNote(head.d, l.mult, base + pos, base + l.end);
          pos = l.end;
          continue;
        }
        // decorations (H L M O P S T u v ~ .) and anything unknown
        pos++;
      }
    }

    function addNote(d, mult, start, end) {
      let dur = applyDuration(mult);
      if (pendingBroken !== null) {
        dur *= pendingBroken;
        pendingBroken = null;
      }
      const inRange = d >= 0 && d <= 8;
      if (!inRange) outOfRange++;
      pushEvent({
        type: 'note',
        d: inRange ? d : Math.max(0, Math.min(8, d)),
        inRange,
        dur,
        graces: pendingGrace.filter((g) => g >= 0 && g <= 8),
        tie: false,
        start,
        end,
      });
      pendingGrace = [];
      pendingTie = false;
    }

    if (outOfRange) warnings.push(outOfRange + ' note(s) outside the chanter range (G..a)');
    if (!events.some((e) => e.type === 'note')) warnings.push('no notes found');

    const play = expandPlayOrder(items);
    const timeline = buildTimeline(events, play);
    const sig = buildSignature(timeline);

    const titles = headers.T.filter(Boolean);
    return {
      text,
      headers,
      title: titles[0] || 'Untitled',
      altTitles: titles.slice(1),
      composer: headers.C || '',
      rhythm: headers.R || '',
      category,
      meter: meter.text,
      key: headers.K || '',
      unitLength: unit,
      tempo,
      explicitTempo,
      events,
      timeline,
      signature: sig,
      measures: measure + (eventsInMeasure > 0 ? 1 : 0),
      noteCount: events.filter((e) => e.type === 'note').length,
      warnings,
    };
  }

  function expandNums(s) {
    const out = [];
    for (const part of s.split(',')) {
      const r = /^(\d+)-(\d+)$/.exec(part);
      if (r) for (let k = +r[1]; k <= +r[2]; k++) out.push(k);
      else out.push(+part);
    }
    return out;
  }

  /**
   * Expand repeats and volta endings into the order the tune is played.
   * Returns [{i: eventIndex, pass}].
   */
  function expandPlayOrder(items) {
    const out = [];
    const n = items.length;
    let i = 0;
    let loopStart = 0;
    let pass = 1;
    const repeated = new Set();
    let guard = 0;
    const maxSteps = n * 8 + 100;

    while (i < n && guard++ < maxSteps) {
      const it = items[i];
      if (it.type === 'event') {
        out.push({ i: it.i, pass });
        i++;
      } else if (it.type === 'ending') {
        if (it.nums.includes(pass)) {
          i++;
          continue;
        }
        // skip this volta: go to the next volta marker, else to the next repeat start / the end
        let j = i + 1;
        while (j < n && items[j].type !== 'ending') j++;
        if (j >= n) {
          j = i + 1;
          while (j < n && !(items[j].type === 'bar' && items[j].startRepeat)) j++;
        }
        i = j;
      } else if (it.type === 'bar') {
        if (it.endRepeat && !repeated.has(i)) {
          repeated.add(i);
          pass++;
          i = loopStart;
        } else if (it.endRepeat) {
          pass = 1;
          loopStart = i + 1;
          i++;
        } else if (it.startRepeat) {
          loopStart = i + 1;
          pass = 1;
          i++;
        } else i++;
      } else i++;
    }
    return out;
  }

  function buildTimeline(events, play) {
    const timeline = [];
    let t = 0;
    let k = 0;
    while (k < play.length) {
      const ev = events[play[k].i];
      const entry = {
        i: ev.i,
        type: ev.type,
        t,
        dur: ev.dur,
        d: ev.d,
        graces: ev.graces || [],
        start: ev.start,
        end: ev.end,
        measure: ev.measure,
        pass: play[k].pass,
        inRange: ev.inRange,
        tiedFrom: false,
      };
      t += ev.dur;
      // merge ties: same pitch, previous marked tie
      if (ev.type === 'note' && ev.tie) {
        let j = k + 1;
        while (j < play.length) {
          const nx = events[play[j].i];
          if (nx.type === 'note' && nx.d === ev.d) {
            entry.dur += nx.dur;
            entry.mergedEnd = nx.end;
            t += nx.dur;
            j++;
            if (!nx.tie) break;
          } else break;
        }
        k = j;
      } else k++;
      timeline.push(entry);
    }
    return timeline;
  }

  /**
   * The melody signature used for detection: chanter degrees of the played main notes (grace notes
   * dropped, rests dropped, equal consecutive notes merged since on the pipes a repeated note is
   * separated only by a cut that is too short to hear as a note).
   * durs are in quarter notes.
   */
  function buildSignature(timeline) {
    const notes = [];
    const durs = [];
    const where = [];
    for (const e of timeline) {
      if (e.type !== 'note' || !e.inRange) continue;
      const last = notes.length - 1;
      if (last >= 0 && notes[last] === e.d) {
        durs[last] += e.dur * 4;
      } else {
        notes.push(e.d);
        durs.push(e.dur * 4);
        where.push(e.i);
      }
    }
    return { notes: notes.join(''), durs: durs.map((d) => Math.round(d * 8) / 8), events: where };
  }

  /** Small stable hash for ids (FNV-1a, 53-bit-ish via two 32-bit halves). */
  function hashText(s) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  /**
   * Turn ABC text (one or many tunes) into storable records, without any I/O or duplicate checking.
   * Shared by the server and the in-browser (static hosting) library so both produce identical ids.
   * Returns { tunes: [{ id, stored, entry }], skipped: [{ title, reason }] }.
   */
  function prepareImport(text, sourceName) {
    const out = { tunes: [], skipped: [] };
    const tunes = splitTunes(normalizeText(text));
    if (!tunes.length) {
      out.skipped.push({ title: sourceName, reason: 'no ABC tunes found' });
      return out;
    }
    for (const t of tunes) {
      let parsed;
      try {
        parsed = parseTune(t.text);
      } catch (e) {
        out.skipped.push({ title: '(unparsable tune)', reason: String((e && e.message) || e) });
        continue;
      }
      if (!parsed.noteCount) {
        out.skipped.push({ title: parsed.title, reason: 'no notes' });
        continue;
      }
      // drop the file-specific X: number so identical tunes dedupe
      const canon = t.text.replace(/^X:.*\n/, '').replace(/[ \t]+$/gm, '');
      const id = hashText(canon);
      out.tunes.push({
        id,
        stored: 'X:1\n' + canon,
        entry: {
          id,
          title: parsed.title,
          altTitles: parsed.altTitles,
          composer: parsed.composer,
          category: parsed.category,
          rhythm: parsed.rhythm,
          meter: parsed.meter,
          key: parsed.key,
          source: sourceName,
          added: Date.now(),
          noteCount: parsed.noteCount,
          measures: parsed.measures,
          warnings: parsed.warnings,
          sig: { notes: parsed.signature.notes, durs: parsed.signature.durs },
        },
      });
    }
    return out;
  }

  return { NOTE_NAMES, splitTunes, parseTune, categoryOf, defaultTempo, normalizeText, hashText, prepareImport };
});
