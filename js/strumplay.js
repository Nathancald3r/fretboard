// Hear a chord sheet's strumming pattern: one chord strummed on the steel-string guitar from
// the player's soundfont, over and over with no gap (alphaTab's own loop). "Slow practice"
// starts at 60% and speeds up 5% every two times through, up to the song's tempo.
import { chordVoicings, splitChord, CHORD_TYPES } from './chordshapes.js';
import { pitchClass } from './theory.js';
import { getValue } from './db.js';

const AT = window.alphaTab;
const VENDOR = new URL('../vendor/alphatab/', import.meta.url).href;
const DEFAULT_SF = new URL('../vendor/soundfont/MuseScore_General.sf3', import.meta.url).href;
const STEEL = 25; // General MIDI steel-string acoustic
const SLOW = 0.6;

let api = null;
let ready = null; // resolves once the player is made
let state = null; // { onSpeed, ramp, loops, last }

// The chord's easiest shape, low E first; a slash bass or an unknown type falls back to its triad.
export function chordFrets(name, capo = 0) {
  const [chord] = String(name || 'G').split('/');
  let c = splitChord(chord);
  if (!c) {
    const root = pitchClass(chord);
    if (root == null) return null;
    const minor = /^[A-G][#b]?(m(?!aj)|min|-)/.test(chord);
    c = { root, type: minor ? 'm' : '' };
  }
  if (!(c.type in CHORD_TYPES)) c.type = '';
  const v = chordVoicings(c.root, c.type)[0];
  return v ? v.frets.map((f) => (f < 0 ? f : f + capo)) : null;
}

/**
 * The pattern as alphaTex, twice through so the loop point is far from the start.
 * strokes: UG's codes (1 down, 101 up, 3 / 103 accented, 2 / 102 muted, 0 none).
 * per: 8 or 16 (strokes per whole note), triplet: three to a beat.
 */
export function strumTex({ strokes, per = 8, triplet = false }, frets, tempo) {
  const perBeat = triplet ? 3 : Math.max(1, per / 4);
  const perBar = perBeat * 4;
  const value = triplet ? 8 : per;
  const chord = `(${frets.map((f, s) => (f < 0 ? null : `${f}.${6 - s}`)).filter(Boolean).join(' ')})`;
  const dead = `(${frets.map((f, s) => (f < 0 ? null : `x.${6 - s}`)).filter(Boolean).join(' ')})`;
  const cells = [...strokes];
  while (cells.length % perBar) cells.push(0);
  let ringing = false;
  const beats = cells.map((n) => {
    const tu = triplet ? ' tu 3' : '';
    if (!n) {
      // a gap in the strumming: the last chord keeps ringing
      if (!ringing) return `r.${value}${tu ? ` {${tu.trim()}}` : ''}`;
      return `${chord}.${value} {t${tu}}`;
    }
    const up = n > 100;
    const kind = n % 100;
    ringing = kind !== 2;
    const dy = kind === 3 ? 'f' : 'mp';
    return `${kind === 2 ? dead : chord}.${value} {${up ? 'su' : 'sd'} dy ${dy}${tu}}`;
  });
  const bars = [];
  for (let i = 0; i < beats.length; i += perBar) bars.push(beats.slice(i, i + perBar).join(' '));
  return [
    `\\tempo ${Math.round(tempo) || 90}`,
    '.',
    '\\track "Strum"',
    `\\instrument ${STEEL}`,
    '\\staff {tabs}',
    [...bars, ...bars].join(' |\n'),
  ].join('\n');
}

function ensureApi() {
  if (api) return ready;
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;left:-10000px;top:0;width:600px;';
  box.setAttribute('aria-hidden', 'true');
  document.body.append(box);
  ready = getValue('soundFont').catch(() => null).then((sf) => {
    api = new AT.AlphaTabApi(box, {
      core: { fontDirectory: VENDOR + 'font/', scriptFile: VENDOR + 'alphaTab.js' },
      display: { layoutMode: AT.LayoutMode.Horizontal, staveProfile: AT.StaveProfile.Tab },
      player: { playerMode: AT.PlayerMode.EnabledSynthesizer, soundFont: sf ? undefined : DEFAULT_SF, enableCursor: false, enableUserInteraction: false },
    });
    if (sf) api.loadSoundFont(sf.data, false);
    // MuseScore General is mixed quiet; the player lifts it the same way
    api.playerReady.on(() => { api.masterVolume = sf ? 1 : 2; });
    api.isLooping = true;
    api.playerPositionChanged.on((e) => {
      if (!state) return;
      if (e.currentTime + 50 < state.last) loopedOnce();
      state.last = e.currentTime;
    });
  });
  return ready;
}

// Each time round in slow practice: 5% faster every second loop, up to full speed.
function loopedOnce() {
  state.loops++;
  if (state.ramp && state.loops % 2 === 0 && api.playbackSpeed < 1) {
    api.playbackSpeed = Math.min(1, Math.round((api.playbackSpeed + 0.05) * 100) / 100);
    state.onSpeed?.(api.playbackSpeed);
  }
}

/**
 * Plays the pattern on a chord until stopStrum(). slow: start at 60% and build up.
 * onSpeed(speed) hears every speed change (1 = the song's tempo).
 */
export async function playStrum(pattern, { chord, capo = 0, tempo, slow = false, onSpeed } = {}) {
  stopStrum();
  const frets = chordFrets(chord, capo);
  if (!frets) return false;
  const run = { onSpeed, ramp: slow, loops: 0, last: 0 };
  state = run;
  await ensureApi();
  if (state !== run) return false; // stopped while the sounds loaded
  api.playbackSpeed = slow ? SLOW : 1;
  onSpeed?.(api.playbackSpeed);
  // ready once the new pattern's MIDI is in and the sounds have loaded (the first time, a while)
  let loaded = false;
  const mark = () => { loaded = true; };
  api.midiLoaded.on(mark);
  api.tex(strumTex(pattern, frets, tempo || pattern.bpm || 90));
  for (let t = 0; t < 600 && !(loaded && api.isReadyForPlayback); t++) {
    await new Promise((r) => setTimeout(r, 100));
    if (state !== run) break;
  }
  api.midiLoaded.off(mark);
  if (state !== run || !api.isReadyForPlayback) return false;
  api.play();
  return true;
}

export function stopStrum() {
  state = null;
  if (api) api.stop();
}

export const strumPlaying = () => !!state;
export const strumApi = () => api; // for checking in the console
