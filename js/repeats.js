// How many times a repeat plays, changed by the player (song.repeats, keyed by the repeat's
// last bar in the file: { count, track, others }).
//  - All tracks (no track): the repeat sign's count changes, so the tab shows "x3" as usual.
//  - One track only: the tracks no longer play the same bars, which one repeat sign can't show.
//    Then the passes are written out bar by bar, each headed "Pass 2/4", so every track's tab
//    reads straight through:
//      fewer passes than the file → that track rests on the passes it drops;
//      more, others 'rest'         → the song gets the extra passes, the other tracks rest in them;
//      more, others 'play'         → the song is unchanged: that track plays its repeat again over
//                                    the bars that follow (the other tracks go on with the song).

const MAX = 16;

// Repeats in the score as read: [{ s, e, count, alt }] (first and last bar, passes, alternate endings).
export function repeatGroups(score) {
  const out = [];
  const seen = new Set();
  for (const mb of score.masterBars) {
    const g = mb.repeatGroup;
    if (!g || seen.has(g) || !g.isOpened || !g.isClosed) continue;
    seen.add(g);
    const s = g.opening.index;
    const e = g.closings[g.closings.length - 1].index;
    const alt = g.closings.length > 1 || score.masterBars.slice(s, e + 2).some((b) => b.alternateEndings);
    out.push({ s, e, count: Math.max(2, score.masterBars[e].repeatCount || 2), alt });
  }
  return out;
}

const clone = (m) => structuredClone(m);

// Bar, voice, beat and note ids stay unique in the copies.
function idMaker(o) {
  const top = { bar: 0, voice: 0, beat: 0, note: 0 };
  for (const tr of o.get('tracks')) for (const st of tr.get('staves')) for (const bar of st.get('bars')) {
    top.bar = Math.max(top.bar, bar.get('id') || 0);
    for (const v of bar.get('voices')) {
      top.voice = Math.max(top.voice, v.get('id') || 0);
      for (const b of v.get('beats')) {
        top.beat = Math.max(top.beat, b.get('id') || 0);
        for (const n of b.get('notes') || []) top.note = Math.max(top.note, n.get('id') || 0);
      }
    }
  }
  return (bar) => {
    bar.set('id', ++top.bar);
    for (const v of bar.get('voices')) {
      v.set('id', ++top.voice);
      for (const b of v.get('beats')) {
        b.set('id', ++top.beat);
        for (const n of b.get('notes') || []) n.set('id', ++top.note);
      }
    }
    return bar;
  };
}

const beatsOf = (bar) => bar.get('voices').flatMap((v) => v.get('beats'));

// The bar keeps its rhythm but plays nothing: every beat becomes a rest.
function silence(bar) {
  for (const b of beatsOf(bar)) {
    b.set('notes', []);
    b.set('lyrics', null);
    b.set('chordid', null);
    b.set('text', null);
  }
}

// Verse k's words on pass k (the file keeps every verse on the one bar).
function verse(bar, k) {
  for (const b of beatsOf(bar)) {
    const l = b.get('lyrics');
    if (l?.length > 1) b.set('lyrics', [l[Math.min(k, l.length) - 1]]);
  }
}

function label(bar, text) {
  const b = bar.get('voices')[0]?.get('beats')[0];
  if (b) b.set('text', b.get('text') ? `${text} · ${b.get('text')}` : text);
}

// A tie into a bar whose bar before now rests has nothing to tie from.
function untie(bar) {
  for (const n of bar?.get('voices')[0]?.get('beats')[0]?.get('notes') || []) n.set('istiedestination', false);
}

const staffBars = (o) => o.get('tracks').flatMap((tr, t) => tr.get('staves').map((st) => ({ t, bars: st.get('bars') })));

// The repeat s..e written out as P passes; track t plays plays(t) of them and rests in the rest.
function writeOut(o, g, P, plays, fresh, orig) {
  const mbs = o.get('masterbars');
  const L = g.e - g.s + 1;
  const extra = [];
  for (let k = 2; k <= P; k++) {
    for (let i = g.s; i <= g.e; i++) {
      const m = clone(mbs[i]);
      m.set('isrepeatstart', false);
      m.set('repeatcount', 0);
      m.set('alternateendings', 0);
      m.delete('section');
      extra.push(m);
    }
  }
  mbs[g.s].set('isrepeatstart', false);
  mbs[g.e].set('repeatcount', 0);
  mbs.splice(g.e + 1, 0, ...extra);
  orig.splice(g.e + 1, 0, ...Array.from({ length: (P - 1) * L }, (_, j) => orig[g.s + (j % L)]));
  for (const { t, bars } of staffBars(o)) {
    const passes = [bars.slice(g.s, g.e + 1)];
    for (let k = 2; k <= P; k++) passes.push(passes[0].map((b) => fresh(clone(b))));
    passes.forEach((pass, i) => {
      const k = i + 1;
      pass.forEach((b) => verse(b, k));
      if (k > plays(t)) { pass.forEach(silence); untie(passes[i + 1]?.[0]); }
      label(pass[0], `Pass ${k}/${P}`);
    });
    if (plays(t) < P) untie(bars[g.e + 1]);
    bars.splice(g.e + 1, 0, ...passes.slice(1).flat());
  }
}

// Track T plays its repeat `more` extra times over the bars after it; the masters stay as they are.
// Stops at the next repeat, ending or change of time signature. Returns how many passes fit.
function playOver(o, g, T, C, more, fresh) {
  const mbs = o.get('masterbars');
  const L = g.e - g.s + 1;
  let n = 0;
  for (; n < more * L; n++) {
    const at = g.e + 1 + n;
    const src = mbs[g.s + (n % L)];
    const m = mbs[at];
    if (!m || m.get('isrepeatstart') || m.get('repeatcount') > 0 || m.get('alternateendings')
      || m.get('timesignaturenumerator') !== src.get('timesignaturenumerator')
      || m.get('timesignaturedenominator') !== src.get('timesignaturedenominator')) break;
  }
  const fit = Math.floor(n / L);
  if (!fit) return 0;
  for (const { t, bars } of staffBars(o)) {
    if (t !== T) continue;
    for (let j = 0; j < fit * L; j++) {
      const b = fresh(clone(bars[g.s + (j % L)]));
      verse(b, C + 1 + Math.floor(j / L));
      if (j % L === 0) label(b, `Pass ${C + 1 + j / L}/${C + fit}`);
      bars[g.e + 1 + j] = b;
    }
    label(bars[g.s], `Plays ${C + fit}×`);
  }
  return fit;
}

/**
 * Applies song.repeats to a read score. AT is alphaTab; settings the api's.
 * Returns { score, groups, orig, short } — groups as the file has them, orig[i] = the file's bar for
 * bar i now, short = [{ e, fit }] for 'play' edits that didn't fit whole.
 */
export function applyRepeats(score, edits, AT, settings) {
  const groups = repeatGroups(score);
  const orig = score.masterBars.map((_, i) => i);
  const short = [];
  const todo = groups.filter((g) => edits?.[g.e] && !g.alt).sort((a, b) => b.e - a.e);
  const one = (ed) => ed.track != null && ed.track >= 0 && ed.track < score.tracks.length;
  for (const g of todo) {
    const ed = edits[g.e];
    if (one(ed)) continue;
    const N = Math.min(MAX, Math.max(1, ed.count | 0));
    score.masterBars[g.e].repeatCount = N > 1 ? N : 0; // once: no repeat at all
    if (N === 1) score.masterBars[g.s].isRepeatStart = false;
  }
  score.rebuildRepeatGroups?.();
  const split = todo.filter((g) => one(edits[g.e]) && (edits[g.e].count | 0) !== g.count);
  if (!split.length) return { score, groups, orig, short };
  const o = AT.model.JsonConverter.scoreToJsObject(score);
  const fresh = idMaker(o);
  for (const g of split) {
    const { track: T, others } = edits[g.e];
    const C = g.count;
    const N = Math.min(MAX, Math.max(1, edits[g.e].count | 0));
    if (N > C && others === 'play') {
      const fit = playOver(o, g, T, C, N - C, fresh);
      if (fit < N - C) short.push({ e: g.e, fit: C + fit });
    } else {
      writeOut(o, g, Math.max(C, N), (t) => (t === T ? N : C), fresh, orig);
    }
  }
  return { score: AT.model.JsonConverter.jsObjectToScore(o, settings), groups, orig, short };
}
