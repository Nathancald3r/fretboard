// Finding a song's recording on YouTube, with no server of our own: public Piped and
// Invidious mirrors answer YouTube searches from the browser. Results are ranked to pick
// the artist's own upload (their channel, "Artist - Topic", VEVO, "official") over covers,
// lessons, karaoke and the like. Ranking is browser-free and tested in tests/ytsearch.test.mjs.

// Mirrors that answer requests from other sites (most don't). If they all fail, more are
// looked up in the Invidious directory.
const PIPED = ['https://api.piped.private.coffee', 'https://pipedapi.kavin.rocks'];
const INVIDIOUS = ['https://invidious.f5.si'];
const TIMEOUT = 9000;

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// Artist and title of a song record; "Artist - Title" titles are split when there's no artist.
export function songQuery(song) {
  let artist = (song?.artist || '').trim();
  let title = (song?.title || '').trim();
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
  if (!artist && dash) [, artist, title] = dash;
  return { artist, title, text: [artist, title].filter(Boolean).join(' ') };
}

// What the tab's version note says about the recording ("Passion Live version, no acapella
// bridge" -> words passion, acapella, bridge; live). Used to search for and prefer that version.
const STOP = new Set(('the and for with without left out version versions this that from was were are has have had obvious reasons reason info '
  + 'helpful yes tab tabs guitar pro chords chord official lyrics song cover tabbed by of in on at to is it its my your our').split(' '));
export function versionHints(song, base = '') {
  const note = norm(song?.versionNote || '');
  if (!note) return { words: [], flags: {} };
  const known = new Set(norm(`${song?.artist || ''} ${song?.title || ''} ${base}`).split(' '));
  const words = [...new Set(note.split(' '))].filter((w) => w.length > 2 && !STOP.has(w) && !known.has(w) && !/^\d+$/.test(w)).slice(0, 6);
  const has = (re) => re.test(note);
  return {
    words,
    flags: { live: has(/\blive\b/), acoustic: has(/\b(acoustic|unplugged|stripped)\b/), piano: has(/\bpiano\b/), studio: has(/\b(studio|album|original)\b/) },
  };
}

const BAD = [
  [/\bkaraoke\b/, 10], [/\b(lesson|tutorial|how to play|play along|playalong|backing track)\b/, 10],
  [/\b(cover|covered by)\b/, 7], [/\binstrumental\b/, 6], [/\b(chords?|tabs?)\b/, 6],
  [/\breaction\b/, 10], [/\b(full album|documentary|interview|story of|behind the song)\b/, 10], [/\b(remix|mashup)\b/, 5], [/\b(slowed|sped up|8d|nightcore|reverb)\b/, 7],
  [/\blive\b/, 3], [/\b(acoustic|piano version|guitar version)\b/, 3], [/\blyrics?\b/, 1],
];

// Higher is a better match for the artist's own recording of the song.
export function scoreResult(r, { artist, title, seconds, hints, evidence }) {
  const t = norm(r.title);
  const a = norm(r.author);
  const songTitle = norm(title);
  const songArtist = norm(artist);
  let score = 0;
  if (songTitle && t.includes(songTitle)) score += 4;
  else if (songTitle) {
    const words = songTitle.split(' ').filter((w) => w.length > 2);
    const found = words.filter((w) => t.includes(w)).length;
    score += words.length && found / words.length >= 0.7 ? 1 : -6;
  }
  const channel = a.replace(/\b(vevo|topic|official|music|tv)\b/g, '').replace(/\s+/g, ' ').trim();
  const byArtist = songArtist && channel && (channel === songArtist.replace(/\s+/g, ' ')
    || channel.replace(/ /g, '') === songArtist.replace(/ /g, ''));
  if (byArtist) score += 6;
  else if (songArtist && t.includes(songArtist)) score += 1;
  else if (songArtist) score -= 4; // someone else's version
  if (/ topic$/.test(a) && byArtist) score += 2; // YouTube Music's "Artist - Topic": the album track
  if (/vevo/.test(a)) score += 2;
  if (/\bofficial\b/.test(t)) score += 2;
  if (r.verified) score += 1;
  const flags = hints?.flags || {};
  for (const [re, cost] of BAD) {
    if (!re.test(t) || re.test(songTitle)) continue;
    // A version the note asks for is not a mark against a result.
    if ((flags.live && /live/.test(re.source)) || (flags.acoustic && /acoustic/.test(re.source)) || (flags.piano && /piano/.test(re.source))) continue;
    score -= cost;
  }
  if (hints?.words?.length) {
    const hit = hints.words.filter((w) => t.includes(w) || a.includes(w)).length;
    score += Math.min(6, hit * 2);
  }
  if (flags.live && /\blive\b/.test(t)) score += 3;
  if (flags.acoustic && /\b(acoustic|unplugged)\b/.test(t)) score += 3;
  if (flags.piano && /\bpiano\b/.test(t)) score += 3;
  if (seconds && r.seconds) {
    const off = Math.abs(r.seconds - seconds);
    const rel = off / seconds;
    if (rel <= 0.04 || off <= 8) score += 3;
    else if (rel <= 0.08 || off <= 15) score += 2;
    else if (rel > 0.25 || off > 90) score -= 3;
    else if (rel > 0.15) score -= 1;
  }
  const ev = evidence || {};
  // A tab from an official/pro transcription follows the album recording.
  if (ev.official && !flags.live && !/\b(live|acoustic|cover)\b/.test(t) && (byArtist || /\bofficial\b/.test(t))) score += 1;
  // Vocal tracks in the file: the sung song, not an instrumental or a solo-guitar arrangement.
  if (ev.vocals && /\b(instrumental|karaoke|solo guitar|fingerstyle)\b/.test(t)) score -= 2;
  if (ev.acousticOnly && !flags.acoustic && /\b(acoustic|unplugged)\b/.test(t)) score += 2;
  return score;
}

// Extra evidence about the recording from the tab: its source link (type: Official/Pro/Guitar Pro),
// the track names in the file. `parsed` is tabinfo.parseSource's result; `tracks` are names.
export function tabEvidence(parsed, tracks = []) {
  const names = (tracks || []).map((n) => norm(n));
  const guitars = names.filter((n) => /guitar|gtr/.test(n));
  return {
    official: /^(Official|Pro)$/.test(parsed?.type || ''),
    vocals: names.some((n) => /\b(vocal|vocals|voice|lead vox|vox|singer)\b/.test(n)),
    acousticOnly: guitars.length > 0 && guitars.every((n) => /acoustic|nylon|steel/.test(n)),
  };
}

// When one result is clearly the right one it can be attached without asking: a clear score
// lead, and a length within 8% of the tab's (when both are known; otherwise a bigger lead).
export function pickConfident(ranked, seconds) {
  const [top, next] = ranked;
  if (!top || top.score < 6) return null;
  const lead = next ? top.score - next.score : 99;
  const known = !!(seconds && top.seconds);
  if (known && Math.abs(top.seconds - seconds) / seconds > 0.08) return null;
  if (lead < (known ? 4 : 7)) return null;
  return top;
}

// A few words on why a result was picked.
export function explainPick(r, { artist, seconds, hints }) {
  const why = [];
  const a = norm(r.author).replace(/\b(vevo|topic|official|music|tv)\b/g, '').replace(/\s+/g, ' ').trim();
  const sa = norm(artist);
  if (sa && a && a.replace(/ /g, '') === sa.replace(/ /g, '')) why.push(/ topic$/.test(norm(r.author)) ? 'album track' : "artist's own channel");
  if (/\bofficial\b/.test(norm(r.title))) why.push('official');
  const f = hints?.flags || {};
  const t = norm(r.title);
  if ((f.live && /\blive\b/.test(t)) || (f.acoustic && /acoustic|unplugged/.test(t)) || (f.piano && /piano/.test(t))) why.push('matches the tab’s version note');
  else if (hints?.words?.some((w) => t.includes(w))) why.push('matches the version note');
  if (seconds && r.seconds) {
    const pct = Math.round(Math.abs(r.seconds - seconds) / seconds * 100);
    why.push(pct <= 1 ? 'same length as the tab' : `length within ${pct}% of the tab`);
  }
  return why.length ? why.join(', ') : 'best title match';
}

export function rankResults(results, want) {
  const seen = new Set();
  return results
    .filter((r) => r.id && !seen.has(r.id) && seen.add(r.id))
    .map((r) => ({ ...r, score: scoreResult(r, want) }))
    .sort((x, y) => y.score - x.score);
}

/* ---------- searching ---------- */

const fromPiped = (data) => (data?.items || []).filter((i) => i.type === 'stream' && i.url).map((i) => ({
  id: /v=([\w-]{11})/.exec(i.url)?.[1], title: i.title, author: i.uploaderName, seconds: i.duration, verified: !!i.uploaderVerified,
}));
const fromInvidious = (data) => (Array.isArray(data) ? data : []).filter((i) => i.type === 'video').map((i) => ({
  id: /^[\w-]{11}$/.test(i.videoId) ? i.videoId : null, title: i.title, author: i.author, seconds: i.lengthSeconds, verified: !!i.authorVerified,
}));

async function getJson(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function nonEmpty(promise) {
  const list = await promise;
  if (!list.length) throw new Error('no results');
  return list;
}

function searchAt(pipedBases, invidiousBases, q) {
  const e = encodeURIComponent(q);
  return Promise.any([
    ...pipedBases.map((b) => nonEmpty(getJson(`${b}/search?filter=videos&q=${e}`).then(fromPiped))),
    ...invidiousBases.map((b) => nonEmpty(getJson(`${b}/api/v1/search?type=video&q=${e}`).then(fromInvidious))),
  ]);
}

// Raw results for a query from whichever mirror answers first.
export async function searchYouTube(q) {
  try {
    return await searchAt(PIPED, INVIDIOUS, q);
  } catch {
    // The fixed mirrors are all down: ask the Invidious directory for others that allow it.
    const list = await getJson('https://api.invidious.io/instances.json?sort_by=health').catch(() => []);
    const more = list.filter(([, i]) => i?.api && i?.cors && i?.type === 'https').map(([, i]) => i.uri).slice(0, 6);
    if (!more.length) throw new Error('YouTube search is unavailable right now.');
    return searchAt([], more, q).catch(() => { throw new Error('YouTube search is unavailable right now.'); });
  }
}

// The song's recording, best match first.
export async function findRecording(song, seconds, evidence) {
  const q = songQuery(song);
  const want = { ...q, seconds, hints: versionHints(song, q.text), evidence };
  const ranked = await findRanked(song, want);
  return Object.assign(ranked, { want });
}

async function findRanked(song, want) {
  if (!want.text) return [];
  // Searches: plain finds the artist's channel and album track, "official" the video, and, when
  // the tab's version note says which version it is, one with those words in.
  const extra = want.hints.words.length ? searchYouTube(`${want.text} ${want.hints.words.join(' ')}`) : Promise.resolve([]);
  const [plain, official, versioned] = await Promise.allSettled([searchYouTube(want.text), searchYouTube(`${want.text} official`), extra]);
  if (plain.status === 'rejected' && official.status === 'rejected' && versioned.status === 'rejected') throw plain.reason;
  return rankResults([...(versioned.value || []), ...(official.value || []), ...(plain.value || [])], want);
}

export const youTubeSearchUrl = (song) => {
  const q = songQuery(song).text;
  const hint = versionHints(song, q).words.join(' ');
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${q} ${hint || 'official'}`.trim())}`;
};
