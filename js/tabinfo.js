// "Tab info": where a tab came from and which version it is. The file itself carries little
// (a tabber's name at best), so this reads what it can from the file, the file's name and a
// pasted page link, and keeps a note the user can edit. Nothing is fetched from any site.
// Tested in tests/tabinfo.test.mjs.

const TYPES = {
  'guitar-pro': 'Guitar Pro', 'guitar-pro-tab': 'Guitar Pro', official: 'Official', pro: 'Pro', tabs: 'Tab',
  chords: 'Chords', bass: 'Bass', ukulele: 'Ukulele', power: 'Power', drums: 'Drums',
};

const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** A tab page link -> { site, type, version, artist, song, id } (whatever its address shows). */
export function parseSource(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^www\./, '');
  const out = { site: host, type: '', version: 0, artist: '', song: '', id: '' };
  if (/ultimate-guitar\.com$/.test(host)) {
    out.site = 'Ultimate Guitar';
    const m = /\/tab\/(?:([^/]+)\/)?([^/?#]+?)-(\d{4,})\/?$/.exec(u.pathname) || /\/tab\/(?:([^/]+)\/)?([^/?#]+)\/?$/.exec(u.pathname);
    if (m) {
      out.artist = m[1] ? titleCase(m[1]) : '';
      let slug = m[2];
      out.id = m[3] || '';
      const ver = /-ver-?(\d+)(?=-|$)/.exec(slug); // before or after the type: "…-ver2-guitar-pro", "…-guitar-pro-ver-2"
      if (ver) { out.version = Number(ver[1]); slug = slug.replace(ver[0], ''); }
      for (const t of Object.keys(TYPES).sort((a, b) => b.length - a.length)) {
        if (slug.endsWith('-' + t)) { out.type = TYPES[t]; slug = slug.slice(0, -t.length - 1); break; }
      }
      out.song = titleCase(slug);
    }
  } else if (/gprotab\.net$/.test(host)) out.site = 'GProTab';
  else if (/911tabs\.com$/.test(host)) out.site = '911tabs';
  else if (/musescore\.com$/.test(host)) out.site = 'MuseScore';
  else if (/songsterr\.com$/.test(host)) out.site = 'Songsterr';
  return out;
}

/** Ultimate Guitar names its downloads "Artist-Song-MM-DD-YYYY.gp" (with " (1)" for repeats). */
export function parseFilename(name) {
  const m = /^(.+?)-(.+)-(\d{2})-(\d{2})-(\d{4})(?: \(\d+\))?\.\w+$/.exec(name || '');
  if (!m) return null;
  const month = Number(m[3]);
  const day = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { artist: m[1], song: m[2], date: `${m[5]}-${m[3]}-${m[4]}` };
}

/** One line for under the title: "Ultimate Guitar · Guitar Pro · ver 2 · note". */
export function sourceLine(song) {
  const p = song?.sourceUrl ? parseSource(song.sourceUrl) : null;
  const bits = [];
  if (p) {
    bits.push(p.site);
    if (p.type) bits.push(p.type);
    if (p.version) bits.push(`ver ${p.version}`);
  }
  if (song?.versionNote) bits.push(song.versionNote.split('\n')[0].slice(0, 60));
  return bits.join(' · ');
}

/** Facts from the loaded score and the song record, for the info sheet. */
export function facts(song, score) {
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') rows.push([k, String(v).trim()]); };
  if (score) {
    add('Tabbed by', score.tab);
    add('Words', score.words);
    add('Music', score.music);
    add('Album', score.album);
    add('Notes in the file', [score.notices, score.instructions].filter(Boolean).join(' '));
    add('Copyright', score.copyright);
    add('Tracks', (score.tracks || []).map((t) => t.name).filter(Boolean).join(', '));
    add('Bars', score.masterBars?.length);
  }
  const f = parseFilename(song?.fileName);
  if (f) add('Downloaded', `${f.date} (Ultimate Guitar's file naming)`);
  else add('File', song?.fileName);
  return rows;
}
