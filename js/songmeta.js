// How a song is classified and ordered in the library: pro tab vs chord chart, ratings, folders.

/** 'pro' (Guitar Pro / MusicXML), 'sheet' (a PDF shown as pages), 'tab' (typed tab lines), 'chords' (chords over lyrics), 'exercise'. */
export function chartType(song) {
  if (song.kind === 'tex') return song.fileName && /\.pdf$/i.test(song.fileName) ? 'pro' : 'exercise'; // a PDF read into notes is a song, not a practice exercise
  if (song.kind === 'sheet') return 'sheet';
  if (song.kind !== 'text') return 'pro';
  return /^\s*[eEbBgGdDaA]?\|?[-0-9hpbrx/\~()]{0,3}\|?[-0-9hpbrx/\~()|]{8,}/m.test(String(song.data || '')) && /-{3,}/.test(String(song.data || '')) ? 'tab' : 'chords';
}

export const CHART_LABEL = { pro: 'Pro tab', tab: 'Text tab', chords: 'Chord chart', exercise: 'Exercise', sheet: 'Sheet music' };

export const SORTS = {
  recent: (a, b) => (b.lastOpened || b.added || 0) - (a.lastOpened || a.added || 0),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || SORTS.recent(a, b),
  title: (a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }),
  practiced: (a, b) => (b.practiceSeconds || 0) - (a.practiceSeconds || 0) || SORTS.recent(a, b),
};

/** Songs for the library page (exercises live on the Practice page). chart: 'all' | 'pro' | 'tab' | 'chords'. */
export function filterSongs(songs, { text = '', chart = 'all', folder = 'all' } = {}) {
  const q = text.trim().toLowerCase();
  return songs.filter((s) => {
    const type = chartType(s);
    if (type === 'exercise') return false;
    if (chart !== 'all' && type !== chart) return false;
    if (folder === '') return !s.folder; // unfiled
    if (folder !== 'all' && s.folder !== folder) return false;
    return !q || `${s.title} ${s.artist}`.toLowerCase().includes(q);
  });
}

export const folderNames = (songs, saved = []) =>
  [...new Set([...saved, ...songs.map((s) => s.folder).filter(Boolean)])].sort((a, b) => a.localeCompare(b));

export const stars = (n) => '★'.repeat(n || 0) + '☆'.repeat(5 - (n || 0));

/**
 * Where a song stands with its play-along video: 'none' (no video), 'progress' (linked, still being lined up)
 * or 'synced' (you marked it done). steps: linked, start found, tempo matched, confirmed.
 */
export function syncState(song) {
  const linked = !!song.recording;
  const start = linked && !!song.videoMaster && !!song.syncPoints?.length;
  const tempo = start && (song.syncPoints.length > 1 || !!song.videoBpm);
  const done = tempo && !!song.syncDone;
  const steps = [linked, start, tempo, done];
  const count = steps.filter(Boolean).length;
  const state = !linked ? 'none' : done ? 'synced' : 'progress';
  const label = { none: 'No video', progress: `Syncing ${count - 1}/3`, synced: 'Synced' }[state];
  return { state, steps, label };
}

/** "Studio original", "Live", "Cover · Artist" or "Live cover · Artist"; '' when no version is set. */
export function versionLabel(song) {
  const v = song.version;
  if (!v?.type) return '';
  if (v.type === 'official') return 'Studio original';
  if (v.type === 'live') return 'Live';
  const who = v.artist ? ` · ${v.artist}` : '';
  return `${v.live ? 'Live cover' : 'Cover'}${who}`;
}

/**
 * Songs that older imports split into one library entry per part ("Champion (Piano)",
 * "Champion (Shaker)"...), grouped so they can be combined into one song: the parts kept as
 * sheet music, joined to the song's tab ("Champion") when there is one.
 * @returns {{ title, artist, base: object|null, parts: { song, name }[] }[]}
 */
export function splitGroups(songs) {
  const groups = new Map();
  const low = (s) => (s || '').trim().toLowerCase();
  for (const s of songs) {
    const m = s.kind === 'sheet' && !s.sheets?.length && /^(.*\S)\s+\(([^()]+)\)$/.exec(s.title || '');
    if (!m) continue;
    const key = low(m[1]) + '\u0000' + low(s.artist);
    if (!groups.has(key)) groups.set(key, { title: m[1].trim(), artist: s.artist || '', parts: [] });
    groups.get(key).parts.push({ song: s, name: m[2].trim() });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    base: songs.filter((s) => s.kind !== 'sheet' && low(s.title) === low(g.title) && low(s.artist) === low(g.artist))
      .sort((a, b) => (b.added || 0) - (a.added || 0))[0] || null,
  })).filter((g) => g.base || g.parts.length > 1);
}
