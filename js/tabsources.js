// Only sites that give a Guitar Pro file for free are listed (MuseScore, Songsterr and
// Ultimate Guitar's text tabs need paid plans or give no .gp).
// Where to look for a song's tab online, as links to each site's search (none of them
// lets another site read its results, so the search opens there). Tested in
// tests/tabsources.test.mjs.

const enc = encodeURIComponent;
// 911tabs page names: lower case, words joined by "_", a leading "The" dropped.
const slug911 = (s) => s.toLowerCase().replace(/^the\s+/, '').replace(/&/g, 'and').replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// One search box: "Artist - Song" is split for the sites that search titles only.
export function splitQuery(text) {
  const t = (text || '').trim();
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(t);
  return dash ? { artist: dash[1], song: dash[2] } : { artist: '', song: t };
}

export const TAB_SOURCES = [
  {
    id: 'ug-gp', label: 'Ultimate Guitar · Guitar Pro', primary: true,
    note: 'The most Guitar Pro files; a free account downloads them. On a phone it opens in your browser: turn on Desktop site there, or it sends you to the app store',
    url: ({ artist, song }) => `https://www.ultimate-guitar.com/search.php?search_type=title&value=${enc(`${artist} ${song}`.trim())}&type=500`,
  },
  {
    id: 'gprotab', label: 'GProTab',
    note: 'Free Guitar Pro files, no account needed (searches song titles: type just the title, or Artist - Song)',
    // Its search takes a song title or an artist, not both.
    url: ({ artist, song }) => (song
      ? `https://gprotab.net/en/search?type=song&q=${enc(song)}`
      : `https://gprotab.net/en/search?type=artist&q=${enc(artist)}`),
  },
  {
    id: '911tabs', label: '911tabs · Guitar Pro',
    note: 'Guitar Pro files gathered from many sites',
    url: ({ artist, song }) => {
      const a = slug911(artist);
      const s = slug911(song);
      return a && s
        ? `https://www.911tabs.com/tabs/${a[0]}/${a}/guitar_pro_tabs/${s}_guitar_pro_tab.htm`
        : `https://www.911tabs.com/search.php?search=${enc(`${artist} ${song}`.trim())}`;
    },
  },
];

export const sourceUrl = (id, text) => TAB_SOURCES.find((s) => s.id === id)?.url(splitQuery(text));
