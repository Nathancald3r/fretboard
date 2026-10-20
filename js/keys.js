// Chords & keys view: circle of fifths with the chords of each key, a chord finder,
// a one-minute chord-change drill and a fretboard note quiz.
import { noteName, pitchClass } from './theory.js';
import {
  CHORD_TYPES, CIRCLE_MAJOR, CIRCLE_MINOR, chordVoicings, diatonicChords, enharmonic, keySignature,
  noteAt, progressionChords, PROGRESSIONS, spellScale, splitChord,
} from './chordshapes.js';
import { strum, pluckNote, beep } from './pluck.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pretty = (name) => name.replace(/#/g, '♯').replace(/([A-G])b/g, '$1♭').replace('7b5', '7♭5');
const PREFS_KEY = 'fretboard-keys-prefs';
const DRILL_KEY = 'fretboard-chord-changes';
const FLAT_ROOTS = [1, 3, 5, 8, 10];

let prefs = { key: 'G', sevenths: false, chord: 0, cfRoot: 0, cfType: '', ccA: 'C', ccB: 'G', ccLen: 60, fnRange: '0-12', fnNaturals: true, fnSound: true, tempo: 90 };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* ignore */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

/* ---------- chord diagram ---------- */

const INTERVAL_LABEL = ['R', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♯5', '6', '♭7', '7'];

/** SVG chord box. frets low E → high e (-1 muted); root labels the dots with intervals. */
export function chordDiagram(frets, root, { title = '', barre = 0 } = {}) {
  const w = 120, h = 150, left = 18, top = 34, sg = 17, fg = 22, rows = 5;
  const played = frets.filter((f) => f > 0);
  const maxF = played.length ? Math.max(...played) : 0;
  const start = maxF <= rows ? 1 : Math.min(...played);
  const x = (s) => left + s * sg;
  const y = (f) => top + (f - start + 0.5) * fg;
  let svg = `<svg viewBox="0 0 ${w} ${h}" class="chord-box" role="img" aria-label="${escape(title)} chord diagram">`;
  if (title) svg += `<text x="${left + 2.5 * sg}" y="12" class="cb-title">${escape(pretty(title))}</text>`;
  svg += start === 1
    ? `<line x1="${x(0)}" x2="${x(5)}" y1="${top}" y2="${top}" class="cb-nut"/>`
    : `<text x="${left - 5}" y="${top + fg * 0.65}" class="cb-start">${start}</text>`;
  for (let r = 0; r <= rows; r++) svg += `<line x1="${x(0)}" x2="${x(5)}" y1="${top + r * fg}" y2="${top + r * fg}" class="cb-fret"/>`;
  for (let s = 0; s < 6; s++) svg += `<line x1="${x(s)}" x2="${x(s)}" y1="${top}" y2="${top + rows * fg}" class="cb-string"/>`;
  if (barre) {
    const strings = frets.map((f, s) => [f, s]).filter(([f]) => f >= 0).map(([, s]) => s);
    svg += `<rect x="${x(strings[0]) - 7}" y="${y(barre) - 7}" width="${x(strings[strings.length - 1]) - x(strings[0]) + 14}" height="14" rx="7" class="cb-barre"/>`;
  }
  frets.forEach((f, s) => {
    if (f < 0) { svg += `<text x="${x(s)}" y="${top - 6}" class="cb-mark">×</text>`; return; }
    const label = INTERVAL_LABEL[(noteAt(s, f) - root + 12) % 12];
    if (f === 0) { svg += `<circle cx="${x(s)}" cy="${top - 10}" r="4.5" class="cb-open${label === 'R' ? ' root' : ''}"/>`; return; }
    svg += `<g class="cb-dot${label === 'R' ? ' root' : ''}"><circle cx="${x(s)}" cy="${y(f)}" r="7.5"/><text x="${x(s)}" y="${y(f) + 3.5}">${label}</text></g>`;
  });
  return svg + '</svg>';
}

function chordCard(name, voicing, root, caption = '') {
  return `<button class="chord-card" data-frets="${voicing.frets.join(',')}" title="Play ${escape(name)}">
    ${chordDiagram(voicing.frets, root, { title: name, barre: voicing.barre })}
    ${caption ? `<span class="small-text muted">${escape(caption)}</span>` : ''}</button>`;
}

const firstVoicing = (name) => {
  const c = splitChord(name);
  return c && chordVoicings(c.root, c.type)[0];
};

/* ---------- circle of fifths ---------- */

function drawCircle() {
  const size = 340, c = size / 2, rOut = 165, rMid = 118, rIn = 74;
  const sel = prefs.key;
  const minor = sel.endsWith('m');
  const idx = (minor ? CIRCLE_MINOR : CIRCLE_MAJOR).indexOf(sel);
  const pt = (r, deg) => [c + r * Math.sin((deg * Math.PI) / 180), c - r * Math.cos((deg * Math.PI) / 180)];
  const wedge = (r1, r2, i) => {
    const a = i * 30 - 15, b = i * 30 + 15;
    const [x1, y1] = pt(r2, a), [x2, y2] = pt(r2, b), [x3, y3] = pt(r1, b), [x4, y4] = pt(r1, a);
    return `M${x1},${y1} A${r2},${r2} 0 0 1 ${x2},${y2} L${x3},${y3} A${r1},${r1} 0 0 0 ${x4},${y4} Z`;
  };
  let svg = `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Circle of fifths">`;
  for (let i = 0; i < 12; i++) {
    // The six chords of the selected key sit in the three wedges around it.
    const near = Math.min((i - idx + 12) % 12, (idx - i + 12) % 12) <= 1;
    for (const [ring, names, r1, r2] of [['major', CIRCLE_MAJOR, rMid, rOut], ['minor', CIRCLE_MINOR, rIn, rMid]]) {
      const name = names[i];
      const active = name === sel;
      const [tx, ty] = pt((r1 + r2) / 2, i * 30);
      const alt = ring === 'major' ? enharmonic(name) : null;
      svg += `<g class="cof-key ${ring}${near ? ' near' : ''}${active ? ' active' : ''}" data-key="${name}" tabindex="0" role="button" aria-label="${name.replace(/m$/, ' minor')}${ring === 'major' ? ' major' : ''}">
        <path d="${wedge(r1, r2, i)}"/>
        <text x="${tx}" y="${ty + (alt ? -2 : 5)}">${pretty(name)}</text>
        ${alt ? `<text x="${tx}" y="${ty + 13}" class="alt">${pretty(alt)}</text>` : ''}</g>`;
    }
    const [sx, sy] = pt(rIn - 16, i * 30);
    const sig = keySignature(CIRCLE_MAJOR[i]);
    const count = sig.sharps.length ? `${sig.sharps.length}♯` : sig.flats.length ? `${sig.flats.length}♭` : '–';
    svg += `<text x="${sx}" y="${sy + 4}" class="cof-sig">${count}</text>`;
  }
  $('cof').innerHTML = svg + '</svg>';
}

function sigText(name) {
  const { sharps, flats } = keySignature(name);
  const list = sharps.length ? sharps : flats;
  if (!list.length) return 'No sharps or flats';
  return `${list.length} ${sharps.length ? 'sharp' : 'flat'}${list.length > 1 ? 's' : ''}: ${list.map(pretty).join(' ')}`;
}

function renderKeyInfo() {
  const name = prefs.key;
  const minor = name.endsWith('m');
  const i = (minor ? CIRCLE_MINOR : CIRCLE_MAJOR).indexOf(name);
  const relative = minor ? CIRCLE_MAJOR[i] : CIRCLE_MINOR[i];
  const tonicName = minor ? name.slice(0, -1) : name;
  const chords = diatonicChords(name, prefs.sevenths);
  const chord = chords[Math.min(prefs.chord, 6)];
  const near = [CIRCLE_MAJOR[(i + 11) % 12], CIRCLE_MAJOR[(i + 1) % 12]].map((k) => (minor ? CIRCLE_MINOR[CIRCLE_MAJOR.indexOf(k)] : k));
  const voicing = chordVoicings(chord.root, chord.type)[0];

  const progs = PROGRESSIONS.map((p, n) => ({ p, n, chords: progressionChords(p, name) })).filter((x) => x.chords);
  $('key-info').innerHTML = `
    <h3>${pretty(tonicName)} ${minor ? 'minor' : 'major'} <span class="muted small-text">· relative ${minor ? 'major' : 'minor'}: ${pretty(relative)}</span></h3>
    <p class="small-text">${sigText(name)}<br>Scale: <b>${spellScale(tonicName, minor).map(pretty).join(' ')}</b></p>
    <div class="row spread"><b>Chords in the key</b>
      <label class="small-text"><input type="checkbox" id="key-sevenths" ${prefs.sevenths ? 'checked' : ''}> 7th chords</label></div>
    <div class="degree-row">${chords.map((c, n) => `
      <button class="degree${n === prefs.chord ? ' active' : ''}" data-degree="${n}">
        <span class="roman">${c.roman}</span><b>${pretty(c.name)}</b><span class="small-text muted">${c.number}</span></button>`).join('')}</div>
    <div class="key-chord">
      ${voicing ? chordCard(chord.name, voicing, chord.root) : ''}
      <p class="small-text muted">${['Home — songs start and end here.', 'Leads to V (the ii – V – I move).', 'Shares two notes with I; a softer substitute.', 'Moves away from home; pairs with V.', 'Tension that pulls back to I.', 'The relative minor; the sad side of the key.', 'Unstable; resolves up to I.'][prefs.chord]}
      Click the diagram to hear it. More shapes in the chord finder below.</p>
    </div>
    <p class="small-text muted">Next-door keys (one sharp or flat apart): ${near.map(pretty).join(', ')}. Songs often borrow chords from them.</p>
    <div class="row spread"><b>Common progressions</b>
      <label class="small-text">Tempo <input type="number" id="key-tempo" min="40" max="200" value="${prefs.tempo}"> BPM</label></div>
    <ul class="progressions">${progs.map(({ p, n, chords: cs }) => `
      <li><button class="small" data-prog="${n}" title="Play">▶</button>
      <span><span class="muted small-text">${escape(p.name)}</span><br>${cs.map((c, j) => `<span class="prog-chord" data-j="${j}">${pretty(c.name)}</span>`).join(' ')}</span></li>`).join('')}</ul>`;
}

let progTimer = null;
function playProgression(n, li) {
  clearTimeout(progTimer);
  document.querySelectorAll('.prog-chord.on').forEach((e) => e.classList.remove('on'));
  const chords = progressionChords(PROGRESSIONS[n], prefs.key);
  const beat = 60 / prefs.tempo;
  let j = 0;
  const next = () => {
    li.querySelectorAll('.prog-chord').forEach((e) => e.classList.toggle('on', Number(e.dataset.j) === j));
    if (j >= chords.length) return;
    const v = chordVoicings(chords[j].root, chords[j].type)[0];
    // One bar per chord: down, down-up, down, down-up.
    [[0, true], [1, true], [1.5, false], [2, true], [3, true], [3.5, false]]
      .forEach(([b, down]) => strum(down ? v.frets : v.frets.slice(2), { delay: b * beat, down, spread: down ? 0.022 : 0.012 }));
    j++;
    progTimer = setTimeout(next, beat * 4 * 1000);
  };
  next();
}

function initCircle() {
  $('cof').addEventListener('click', (e) => {
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (!k) return;
    prefs.key = k; prefs.chord = 0; savePrefs();
    drawCircle(); renderKeyInfo();
  });
  $('cof').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.closest('[data-key]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); } });
  $('key-info').addEventListener('click', (e) => {
    const deg = e.target.closest('[data-degree]');
    if (deg) {
      prefs.chord = Number(deg.dataset.degree); savePrefs(); renderKeyInfo();
      const c = diatonicChords(prefs.key, prefs.sevenths)[prefs.chord];
      const v = chordVoicings(c.root, c.type)[0];
      if (v) strum(v.frets);
      return;
    }
    const prog = e.target.closest('[data-prog]');
    if (prog) playProgression(Number(prog.dataset.prog), prog.closest('li'));
  });
  $('key-info').addEventListener('change', (e) => {
    if (e.target.id === 'key-sevenths') { prefs.sevenths = e.target.checked; savePrefs(); renderKeyInfo(); }
    if (e.target.id === 'key-tempo') { prefs.tempo = Math.max(40, Math.min(200, Number(e.target.value) || 90)); savePrefs(); }
  });
  drawCircle();
  renderKeyInfo();
}

/* ---------- chord finder ---------- */

function renderFinder() {
  const root = prefs.cfRoot, type = prefs.cfType;
  const name = noteName(root, FLAT_ROOTS.includes(root)) + type;
  const { intervals, label } = CHORD_TYPES[type];
  const notes = intervals.map((iv) => noteName(root + iv, FLAT_ROOTS.includes(root)));
  $('cf-notes').textContent = `${pretty(name)} (${label}): ${notes.join(' ')} — ${intervals.map((iv) => INTERVAL_LABEL[iv]).join(' ')}`;
  $('cf-shapes').innerHTML = chordVoicings(root, type).map((v) => chordCard(name, v, root, v.name)).join('');
}

function initFinder() {
  for (let pc = 0; pc < 12; pc++) {
    const label = FLAT_ROOTS.includes(pc) ? `${NOTE_SHARP(pc)} / ${noteName(pc, true)}` : noteName(pc);
    $('cf-root').add(new Option(pretty(label), pc));
  }
  for (const [t, { label }] of Object.entries(CHORD_TYPES)) $('cf-type').add(new Option(`${t || 'maj'} — ${label}`, t));
  $('cf-root').value = prefs.cfRoot;
  $('cf-type').value = prefs.cfType;
  const update = () => { prefs.cfRoot = Number($('cf-root').value); prefs.cfType = $('cf-type').value; savePrefs(); renderFinder(); };
  $('cf-root').addEventListener('change', update);
  $('cf-type').addEventListener('change', update);
  renderFinder();
}
const NOTE_SHARP = (pc) => noteName(pc, false);

/* ---------- chord-change drill ---------- */

const DRILL_CHORDS = ['C', 'A', 'G', 'E', 'D', 'Am', 'Em', 'Dm', 'F', 'Bm', 'C7', 'A7', 'G7', 'E7', 'D7', 'B7',
  'Cmaj7', 'Fmaj7', 'Am7', 'Em7', 'Dm7', 'Asus2', 'Asus4', 'Dsus2', 'Dsus4', 'Cadd9', 'F#m', 'Bb', 'E5', 'A5'];
const BEGINNER_PAIRS = [['A', 'D'], ['D', 'E'], ['A', 'E'], ['C', 'G'], ['G', 'D'], ['Em', 'C'], ['Am', 'E'], ['C', 'Am'],
  ['G', 'Em'], ['D', 'Am'], ['C', 'F'], ['G', 'C'], ['Am', 'F'], ['E', 'Bm'], ['D', 'Bm'], ['G', 'Cadd9']];

const drill = { running: false, count: 0, end: 0, timer: null, current: 0 };
const pairKey = () => [prefs.ccA, prefs.ccB].sort().join('–');
function drillHistory() {
  try { return JSON.parse(localStorage.getItem(DRILL_KEY) || '{}'); } catch { return {}; }
}

function renderDrill() {
  const cards = [prefs.ccA, prefs.ccB].map((n, i) => {
    const v = firstVoicing(n);
    const card = v ? chordCard(n, v, splitChord(n).root) : '';
    return `<div class="drill-chord${drill.running && drill.current === i ? ' now' : ''}">${card}</div>`;
  });
  $('cc-shapes').innerHTML = cards.join('<span class="drill-arrow">⇄</span>');
  const runs = drillHistory()[pairKey()] || [];
  const best = runs.length ? Math.max(...runs.map((r) => r.count * (60 / r.seconds))) : 0;
  $('cc-best').textContent = runs.length
    ? `${pretty(pairKey())}: best ${Math.round(best)} changes a minute · last ${runs.slice(-5).map((r) => Math.round(r.count * (60 / r.seconds))).join(', ')}`
    : `No runs for ${pretty(pairKey())} yet. 30+ changes a minute makes a chord pair usable in songs; 60 is smooth.`;
}

function stopDrill(save) {
  clearInterval(drill.timer);
  drill.running = false;
  $('cc-start').textContent = 'Start';
  $('cc-tap').disabled = true;
  if (save) {
    beep(660, 0.4);
    const all = drillHistory();
    (all[pairKey()] ||= []).push({ date: Date.now(), count: drill.count, seconds: prefs.ccLen });
    all[pairKey()] = all[pairKey()].slice(-50);
    try { localStorage.setItem(DRILL_KEY, JSON.stringify(all)); } catch { /* ignore */ }
    $('cc-status').textContent = `${drill.count} changes in ${prefs.ccLen} s.`;
  }
  renderDrill();
}

function startDrill() {
  $('cc-start').blur(); // Space counts changes; don't let it press Stop
  if (drill.running) { stopDrill(false); $('cc-status').textContent = 'Stopped.'; return; }
  drill.running = true; drill.count = 0; drill.current = 0;
  $('cc-start').textContent = 'Stop';
  let countdown = 3;
  $('cc-status').textContent = 'Get ready… 3';
  beep(440);
  renderDrill();
  drill.timer = setInterval(() => {
    if (countdown > 1) { countdown--; $('cc-status').textContent = `Get ready… ${countdown}`; beep(440); return; }
    if (countdown === 1) {
      countdown = 0; beep(880, 0.2);
      drill.end = Date.now() + prefs.ccLen * 1000;
      $('cc-tap').disabled = false;
    }
    const left = Math.ceil((drill.end - Date.now()) / 1000);
    if (left <= 0) { stopDrill(true); return; }
    $('cc-status').textContent = `${left} s · ${drill.count} changes`;
  }, 1000);
}

function tapChange() {
  if (!drill.running || $('cc-tap').disabled) return;
  drill.count++;
  drill.current = 1 - drill.current;
  $('cc-status').textContent = `${Math.ceil((drill.end - Date.now()) / 1000)} s · ${drill.count} changes`;
  document.querySelectorAll('.drill-chord').forEach((el, i) => el.classList.toggle('now', i === drill.current));
}

function initDrill() {
  for (const id of ['cc-a', 'cc-b']) DRILL_CHORDS.forEach((n) => $(id).add(new Option(pretty(n), n)));
  $('cc-a').value = prefs.ccA; $('cc-b').value = prefs.ccB; $('cc-len').value = prefs.ccLen;
  const update = () => {
    prefs.ccA = $('cc-a').value; prefs.ccB = $('cc-b').value; prefs.ccLen = Number($('cc-len').value);
    savePrefs(); $('cc-status').textContent = ''; renderDrill();
  };
  ['cc-a', 'cc-b', 'cc-len'].forEach((id) => $(id).addEventListener('change', update));
  $('cc-random').addEventListener('click', () => {
    let pair;
    do pair = BEGINNER_PAIRS[Math.floor(Math.random() * BEGINNER_PAIRS.length)];
    while (pair.join() === [prefs.ccA, prefs.ccB].join());
    [$('cc-a').value, $('cc-b').value] = pair;
    update();
  });
  $('cc-start').addEventListener('click', startDrill);
  $('cc-tap').addEventListener('click', tapChange);
  renderDrill();
}

/* ---------- fretboard note quiz ---------- */

const quiz = { target: null, shown: 0, right: 0, total: 0, streak: 0, times: [], missed: false };
const NATURAL = [0, 2, 4, 5, 7, 9, 11];

function quizRange() {
  const [lo, hi] = prefs.fnRange.split('-').map(Number);
  return { lo, hi };
}

function nextNote() {
  const { lo, hi } = quizRange();
  const strings = [...document.querySelectorAll('#fn-strings input:checked')].map((c) => Number(c.value));
  if (!strings.length) { $('fn-score').textContent = 'Pick at least one string.'; return; }
  let t;
  for (let tries = 0; tries < 200; tries++) {
    t = { string: strings[Math.floor(Math.random() * strings.length)], fret: lo + Math.floor(Math.random() * (hi - lo + 1)) };
    const same = quiz.target && t.string === quiz.target.string && t.fret === quiz.target.fret;
    if (!same && (!prefs.fnNaturals || NATURAL.includes(noteAt(t.string, t.fret)))) break;
  }
  quiz.target = t;
  quiz.shown = performance.now();
  quiz.missed = false;
  document.querySelectorAll('#fn-answers button').forEach((b) => b.classList.remove('right', 'wrong'));
  drawQuizBoard();
}

function drawQuizBoard(reveal = false) {
  const maxF = Math.max(12, quizRange().hi);
  const left = 30, top = 18, fw = 46, sg = 24;
  const width = left + (maxF + 0.5) * fw, height = top * 2 + sg * 5 + 12;
  const x = (f) => (f === 0 ? left - 14 : left + (f - 0.5) * fw);
  const y = (s) => top + (5 - s) * sg;
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Fretboard">`;
  for (let f = 0; f <= maxF; f++) {
    svg += `<line x1="${left + f * fw}" x2="${left + f * fw}" y1="${top}" y2="${top + sg * 5}" class="${f === 0 ? 'fb-nut' : 'fb-fret'}"/>`;
    if ([3, 5, 7, 9, 15].includes(f)) svg += `<circle cx="${x(f)}" cy="${top + sg * 2.5}" r="5" class="fb-inlay"/>`;
    if (f === 12) svg += `<circle cx="${x(f)}" cy="${top + sg * 1.5}" r="5" class="fb-inlay"/><circle cx="${x(f)}" cy="${top + sg * 3.5}" r="5" class="fb-inlay"/>`;
    if (f) svg += `<text x="${x(f)}" y="${height - 2}" class="fb-num">${f}</text>`;
  }
  for (let s = 0; s < 6; s++) svg += `<line x1="${left}" x2="${left + maxF * fw}" y1="${y(s)}" y2="${y(s)}" class="fb-string" style="stroke-width:${1 + (5 - s) * 0.35}"/>`;
  'EADGBE'.split('').forEach((n, s) => { svg += `<text x="8" y="${y(s) + 4}" class="fb-num">${n}</text>`; });
  const t = quiz.target;
  if (t) {
    svg += `<g class="fb-dot on root"><circle cx="${x(t.fret)}" cy="${y(t.string)}" r="11"/>`;
    svg += `<text x="${x(t.fret)}" y="${y(t.string) + 4}">${reveal ? noteName(noteAt(t.string, t.fret)) : '?'}</text></g>`;
  }
  $('fn-board').innerHTML = svg + '</svg>';
  if (t) {
    const el = $('fn-board');
    el.scrollLeft = (x(t.fret) * el.scrollWidth) / width - el.clientWidth / 2;
  }
}

function answer(pc, button) {
  if (!quiz.target) return;
  const correct = noteAt(quiz.target.string, quiz.target.fret);
  if (pc !== correct) {
    button.classList.add('wrong');
    quiz.missed = true;
    quiz.streak = 0;
    renderQuizScore();
    return;
  }
  button.classList.add('right');
  if (prefs.fnSound) pluckNote(quiz.target.string, quiz.target.fret);
  quiz.total++;
  if (!quiz.missed) {
    quiz.right++;
    quiz.streak++;
    quiz.times.push((performance.now() - quiz.shown) / 1000);
  }
  drawQuizBoard(true);
  renderQuizScore();
  setTimeout(nextNote, 650);
}

function renderQuizScore() {
  const avg = quiz.times.length ? (quiz.times.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, quiz.times.length)).toFixed(1) : '–';
  $('fn-score').textContent = quiz.total
    ? `${quiz.right} / ${quiz.total} right first time · streak ${quiz.streak} · average ${avg} s (aim for under 2 s)`
    : 'Name the highlighted note.';
}

function initQuiz() {
  const answers = $('fn-answers');
  for (let pc = 0; pc < 12; pc++) {
    const b = document.createElement('button');
    b.textContent = FLAT_ROOTS.includes(pc) ? `${noteName(pc)}/${noteName(pc, true)}` : noteName(pc);
    b.dataset.pc = pc;
    b.classList.toggle('accidental', !NATURAL.includes(pc));
    answers.append(b);
  }
  const showAccidentals = () => answers.querySelectorAll('.accidental').forEach((b) => { b.hidden = prefs.fnNaturals; });
  answers.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) answer(Number(b.dataset.pc), b);
  });
  $('fn-range').value = prefs.fnRange;
  $('fn-naturals').checked = prefs.fnNaturals;
  $('fn-sound').checked = prefs.fnSound;
  const update = () => {
    prefs.fnRange = $('fn-range').value; prefs.fnNaturals = $('fn-naturals').checked; prefs.fnSound = $('fn-sound').checked;
    savePrefs(); showAccidentals(); nextNote();
  };
  ['fn-range', 'fn-naturals', 'fn-sound'].forEach((id) => $(id).addEventListener('change', update));
  $('fn-strings').addEventListener('change', nextNote);
  showAccidentals();
  renderQuizScore();
  nextNote();
}

/* ---------- shared ---------- */

// Letter keys answer the note quiz; Space counts a change in the drill.
function onKey(e) {
  if ($('view-keys').hidden || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.target.matches?.('input[type=number], input[type=text], input[type=search], textarea')) return;
  if (e.code === 'Space' && drill.running) { e.preventDefault(); tapChange(); return; }
  const letter = /^[a-g]$/i.test(e.key) ? pitchClass(e.key.toUpperCase()) : null;
  if (letter !== null && quiz.target) {
    const b = $('fn-answers').querySelector(`[data-pc="${letter}"]`);
    if (b && !b.hidden) answer(letter, b);
  }
}

export function renderKeys() {
  drawQuizBoard(); // measured for scrolling once the view is visible
}

export function initKeys() {
  initCircle();
  initFinder();
  initDrill();
  initQuiz();
  document.addEventListener('keydown', onKey);
  $('view-keys').addEventListener('click', (e) => {
    const card = e.target.closest('.chord-card');
    if (card) strum(card.dataset.frets.split(',').map(Number));
  });
  // Don't let a clicked control keep focus and swallow Space.
  $('view-keys').addEventListener('change', (e) => { if (e.target.matches('select, input[type=checkbox]')) e.target.blur(); });
}
