// Synced lyrics: the syllables stored on a track's beats (Guitar Pro lyrics, alphaTex
// \lyrics), laid out in playback order as lines, karaoke style. Pure (no DOM): tested in
// tests/lyrics.test.mjs.

const hasLyrics = (beat) => beat.lyrics?.some((l) => l && l.trim());

function trackHasLyrics(track) {
  return track.staves.some((st) => st.bars.some((b) => b.voices.some((v) => v.beats.some(hasLyrics))));
}

/** The track whose lyrics to show: a vocal track with lyrics first, else any; -1 if none. */
export function lyricsTrack(score) {
  const withLyrics = score.tracks.map((t, i) => [t, i]).filter(([t]) => trackHasLyrics(t));
  const vocal = withLyrics.find(([t]) => /vocal|voice|sing|lead vox|lyrics/i.test(t.name || ''));
  return (vocal || withLyrics[0])?.[1] ?? -1;
}

const BREAK_GAP = 1440; // a rest of a dotted quarter (or more) ends a line
const LONG_LINE = 40; // characters
const MAX_LINE = 56;
const SHORT_LINE = 12;

/**
 * Lines in playback order.
 * bars: [{ start (tick), masterIndex }] for every played bar (repeats included).
 * A repeated bar uses its next lyrics line (verse 2, 3 …) when the file has one.
 * Returns [{ start, end, words: [{ tick, end, text, joined }] }]; joined = glued to the next
 * syllable (a hyphenated word).
 */
export function buildLyrics(score, trackIndex, bars) {
  const track = score.tracks[trackIndex];
  if (!track) return [];
  const seen = new Map();
  const syllables = [];
  for (const bar of bars) {
    const k = seen.get(bar.masterIndex) || 0;
    seen.set(bar.masterIndex, k + 1);
    const mb = score.masterBars[bar.masterIndex];
    let first = true;
    for (const staff of track.staves) {
      for (const voice of staff.bars[bar.masterIndex]?.voices || []) {
        for (const beat of voice.beats) {
          if (!hasLyrics(beat)) continue;
          const text = (beat.lyrics[k] && beat.lyrics[k].trim()) ? beat.lyrics[k] : beat.lyrics.find((l) => l && l.trim());
          syllables.push({
            tick: bar.start + beat.playbackStart,
            end: bar.start + beat.playbackStart + beat.playbackDuration,
            raw: text.trim(),
            section: first && !!mb?.section,
          });
          first = false;
        }
      }
    }
  }
  syllables.sort((a, b) => a.tick - b.tick);

  const lines = [];
  let line = null;
  let prev = null;
  for (const s of syllables) {
    const joined = s.raw.endsWith('-');
    const word = { tick: s.tick, end: s.end, text: joined ? s.raw.slice(0, -1) : s.raw, joined };
    // A word goes on in lower case; a capital after a hyphen means the sheet jumped (a repeat
    // ending, a cut) and the word before was left unfinished: keep its hyphen, don't glue them.
    if (prev?.joined && /^[A-Z]/.test(word.text) && word.text !== 'I') {
      prev.joined = false;
      prev.text += '-';
    }
    const length = line ? line.words.reduce((n, w) => n + w.text.length + 1, 0) : 0;
    // Sung lines start with a capital, so a long line waits for one (up to a hard limit);
    // a line of a word or two ("hey,") runs on into the next instead of standing alone.
    const capital = /^[A-Z]/.test(word.text);
    const short = length < SHORT_LINE && !capital;
    const breakHere = !line
      || s.section
      || (s.tick - prev.end >= BREAK_GAP && !prev.joined && !short)
      || (length > LONG_LINE && !prev.joined && (capital || length > MAX_LINE))
      || (length > LONG_LINE / 2 && /[.!?;]$/.test(prev.text));
    if (breakHere) {
      line = { start: s.tick, end: s.end, words: [] };
      lines.push(line);
    }
    line.words.push(word);
    line.end = s.end;
    prev = word;
  }
  return lines;
}

/**
 * The line to show at a tick: the one playing, or the next one coming up. Once a line's last word
 * has started, the next line takes its place `lead` ticks before it's sung (time to read it).
 */
export function lineAt(lines, tick, lead = 0) {
  let i = lines.findIndex((l) => tick < l.end);
  if (i === -1) i = lines.length - 1;
  const next = lines[i + 1];
  if (next && tick >= lines[i].words[lines[i].words.length - 1].tick && tick >= next.start - lead) i++;
  return i;
}
