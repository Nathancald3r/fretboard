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

const BAD = [
  [/\bkaraoke\b/, 10], [/\b(lesson|tutorial|how to play|play along|playalong|backing track)\b/, 10],
  [/\b(cover|covered by)\b/, 7], [/\binstrumental\b/, 6], [/\b(chords?|tabs?)\b/, 6],
  [/\breaction\b/, 10], [/\b(full album|documentary|interview|story of|behind the song)\b/, 10], [/\b(remix|mashup)\b/, 5], [/\b(slowed|sped up|8d|nightcore|reverb)\b/, 7],
  [/\blive\b/, 3], [/\b(acoustic|piano version|guitar version)\b/, 3], [/\blyrics?\b/, 1],
];

// Higher is a better match for the artist's own recording of the song.
export function scoreResult(r, { artist, title, seconds }) {
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
  for (const [re, cost] of BAD) if (re.test(t) && !re.test(songTitle)) score -= cost;
  if (seconds && r.seconds) {
    const off = Math.abs(r.seconds - seconds);
    if (off <= 15) score += 2;
    else if (off > 90) score -= 2;
  }
  return score;
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
export async function findRecording(song, seconds) {
  const want = { ...songQuery(song), seconds };
  if (!want.text) return [];
  // Two searches: plain finds the artist's channel and album track, "official" the video.
  const [plain, official] = await Promise.allSettled([searchYouTube(want.text), searchYouTube(`${want.text} official`)]);
  if (plain.status === 'rejected' && official.status === 'rejected') throw plain.reason;
  return rankResults([...(official.value || []), ...(plain.value || [])], want);
}

export const youTubeSearchUrl = (song) => `https://www.youtube.com/results?search_query=${encodeURIComponent(songQuery(song).text + ' official')}`;
