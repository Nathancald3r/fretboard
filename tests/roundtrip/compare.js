// Scores an imported track against the original, bar by bar. Both sides are alphaTab scores.
// Checks (each 0..1):
//   bars       the bar count
//   timeSig    bars whose time signature matches
//   tempo      the opening tempo (within 1 bpm)
//   frets      the right string/fret numbers in the right order in each bar, timing aside (F1)
//   onsets     the right string/fret at the right moment in the bar (F1)
//   durations  notes that start right and also last the right length
// Only the first voice of the first staff counts: that is all the importer writes.

const Q = 960; // alphaTab ticks per quarter note
const NAMES = { [4 * Q]: '1', [2 * Q]: '2', [Q]: '4', [Q / 2]: '8', [Q / 4]: '16', [Q / 8]: '32', [6 * Q]: '1.', [3 * Q]: '2.', [1.5 * Q]: '4.', [0.75 * Q]: '8.', [0.375 * Q]: '16.' };
const durName = (t) => NAMES[t] || (Q * 2 / 3 === t ? '4t' : Q / 3 === t ? '8t' : Q / 6 === t ? '16t' : `${t}t`);

/** A bar's beats: [{ start, dur, notes: ['fret.string', ...] }] (rests included, notes empty). */
function beatsOf(bar) {
  const v = bar?.voices[0];
  if (!v) return [];
  return v.beats.map((b) => ({
    start: b.playbackStart,
    dur: b.playbackDuration,
    notes: b.isRest ? [] : b.notes.map((n) => `${n.isDead ? 'x' : n.fret}.${n.string}`).sort(),
  }));
}

// longest common subsequence length of two lists, compared with eq
function lcs(a, b, eq) {
  const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = eq(a[i - 1], b[j - 1]) ? m[i - 1][j - 1] + 1 : Math.max(m[i - 1][j], m[i][j - 1]);
  return m[a.length][b.length];
}

const f1 = (hit, want, got) => (want + got === 0 ? 1 : (2 * hit) / (want + got));
const show = (beats) => beats.map((b) => (b.notes.length ? (b.notes.length > 1 ? `(${b.notes.join(' ')})` : b.notes[0]) : 'r') + ':' + durName(b.dur)).join(' ') || '(empty)';

export function compareTracks(want, wi, got, gi, { listBars = 5 } = {}) {
  const wBars = want.tracks[wi].staves[0].bars, gBars = got.tracks[gi].staves[0].bars;
  const n = Math.max(wBars.length, gBars.length);
  let tsHit = 0;
  let fretHit = 0, onsetHit = 0, durHit = 0, wantNotes = 0, gotNotes = 0, wantBeats = 0;
  const diffs = [];
  for (let i = 0; i < n; i++) {
    const wm = want.masterBars[i], gm = got.masterBars[i];
    const why = [];
    if (wm && gm && wm.timeSignatureNumerator === gm.timeSignatureNumerator && wm.timeSignatureDenominator === gm.timeSignatureDenominator) tsHit++;
    else why.push(`time ${wm ? `${wm.timeSignatureNumerator}/${wm.timeSignatureDenominator}` : '-'} -> ${gm ? `${gm.timeSignatureNumerator}/${gm.timeSignatureDenominator}` : '-'}`);
    const wb = beatsOf(wBars[i]).filter((b) => b.notes.length), gb = beatsOf(gBars[i]).filter((b) => b.notes.length);
    const wn = wb.flatMap((b) => b.notes.map((x) => ({ x, b }))), gn = gb.flatMap((b) => b.notes.map((x) => ({ x, b })));
    wantNotes += wn.length; gotNotes += gn.length; wantBeats += wb.length;
    // frets: the notes in order, timing aside
    const fh = lcs(wn, gn, (a, c) => a.x === c.x);
    fretHit += fh;
    // onsets: the same note at the same tick
    const left = gn.map((g) => `${g.b.start}|${g.x}`);
    let oh = 0;
    for (const w of wn) { const k = left.indexOf(`${w.b.start}|${w.x}`); if (k >= 0) { oh++; left[k] = null; } }
    onsetHit += oh;
    // durations: a beat that starts where the original's does, with the same notes, and lasts as long
    let dh = 0;
    for (const w of wb) { const g = gb.find((x) => x.start === w.start); if (g && g.dur === w.dur && g.notes.join() === w.notes.join()) dh++; }
    durHit += dh;
    if (!wBars[i]) why.push('extra bar');
    else if (!gBars[i]) why.push('bar missing');
    else if (fh !== wn.length || fh !== gn.length) why.push('notes');
    else if (oh !== wn.length || dh !== wb.length) why.push('rhythm');
    if (why.length && diffs.length < listBars) diffs.push({ bar: i + 1, why: why.join(', '), want: wBars[i] ? show(beatsOf(wBars[i])) : '-', got: gBars[i] ? show(beatsOf(gBars[i])) : '-' });
  }
  const checks = {
    bars: wBars.length ? Math.max(0, 1 - Math.abs(gBars.length - wBars.length) / wBars.length) : 1,
    timeSig: n ? tsHit / n : 1,
    tempo: Math.abs(want.tempo - got.tempo) <= 1 ? 1 : 0,
    frets: f1(fretHit, wantNotes, gotNotes),
    onsets: f1(onsetHit, wantNotes, gotNotes),
    durations: wantBeats ? durHit / wantBeats : 1,
  };
  return {
    checks,
    facts: { bars: [wBars.length, gBars.length], tempo: [want.tempo, got.tempo], notes: [wantNotes, gotNotes] },
    diffs,
  };
}
