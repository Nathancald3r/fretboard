"""One command: a YouTube link → a synced song for Fretboard (a .fretboard file).

    python tests/yt2gp5/fromlink.py "https://www.youtube.com/watch?v=..."
        --ug URL        use this UG official tab (when the search picks the wrong one or finds none)
        --title T --artist A   the song's name, when the video's title doesn't say it plainly
        --again         redo every step, even the ones already done

What it does, each step skipped when it's done already:
  1. reads the video's title and artist (yt-dlp, nothing downloaded yet)
  2. finds the song's Official tab on Ultimate Guitar (in the collector Chrome, logged in to UG Pro)
  3. saves its tracks as PDFs (tools/ug_collect.py, no windows) into Downloads/UG Songs
  4. turns the PDFs into one .gp (ug_to_gp.py) and adds the song to songs.json with THIS video
  5. lines the tab up with the video: one steady tempo and the start (listen.py --export), then the
     QA gate says PASS, LISTEN or FAIL
Prints the .fretboard file at the end: open it in Fretboard (Import files).
Exit codes: 0 PASS, 1 failed, 2 LISTEN (made, but have a listen), 3 FAIL (made, sync is off).
"""
import argparse
import json
import re
import subprocess
import time
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VENV = Path.home() / ".fretboard" / "yt2gp5-venv" / "Scripts" / "python.exe"  # yt-dlp, torch, demucs... (PLAN.md)
if VENV.exists() and Path(sys.executable).resolve() != VENV.resolve() and __name__ == "__main__":
    sys.exit(subprocess.run([str(VENV), __file__, *sys.argv[1:]]).returncode)
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))
import songdb  # noqa: E402

UG_ROOT = Path.home() / "Downloads" / "UG Songs"  # the UG helper's songs (Fretboard adds these to the library)
OWN_ROOT = HERE / "cache" / "ug-pdf"  # this script's own UG saves
CACHE_UG = HERE / "cache" / "ug"
CDP = 9222
PROFILE = r"C:\ug-chrome"
# words in a video title that aren't the song's name
NOISE = re.compile(r"\s*[\(\[][^)\]]*(official|audio|video|lyric|visuali[sz]er|live|hd|4k|remaster)[^)\]]*[\)\]]", re.I)


def say(msg):
    print(msg, flush=True)


def video(url):
    """The video's id, title, channel, length, and the song name and artist when YouTube knows them."""
    import yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as y:
        v = y.extract_info(url, download=False)
    return {"id": v["id"], "title": v.get("title") or "", "channel": v.get("channel") or v.get("uploader") or "",
            "seconds": v.get("duration"), "track": v.get("track") or "", "artist": (v.get("artist") or v.get("creator") or "")}


def song_name(v):
    """(title, artist) from the video: YouTube's own track/artist fields (label uploads have them), else
    "Artist - Title (Official Video)" in the title, else the channel name as the artist."""
    artist = (v["artist"].split(",")[0]).strip()
    title = v["track"].strip()
    t = NOISE.sub("", v["title"]).strip()
    if not title:
        if " - " in t:
            a, title = [x.strip() for x in t.split(" - ", 1)]
            artist = artist or a
        else:
            title = t
    if not artist:
        artist = re.sub(r"\s*-\s*Topic$|VEVO$", "", v["channel"]).strip()
    title = re.sub(r"\s*\((feat|ft)\.?[^)]*\)", "", title, flags=re.I).strip()
    return title, artist


def chrome():
    """The collector Chrome (its own profile, logged in to UG Pro once), started out of sight when it's not up."""
    import ug_watch
    if ug_watch.song_tabs(CDP) is None:
        say("  starting the collector Chrome (out of sight)...")
        if not ug_watch.start_chrome(CDP, PROFILE):
            sys.exit("Chrome isn't installed where the UG helper looks for it.")
        ug_watch._hide_when_up(CDP)


FIND_JS = r"""([q]) => {
  const r = window.UGAPP?.store?.page?.data?.results;
  if (!Array.isArray(r)) return null;
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const words = norm(q).split(' ').filter(Boolean);
  let best = null, top = -1;
  for (const x of r) {
    if (!x || x.type !== 'Official' || !/-official-\d+$/.test(x.tab_url || '')) continue;
    const hay = ' ' + norm(`${x.artist_name} ${x.song_name}`) + ' ';
    const m = words.filter((w) => hay.includes(` ${w} `)).length / Math.max(1, words.length);
    const score = m * 100 + (x.rating || 0) * 4 + Math.min(9, Math.log10(1 + (x.votes || 0)) * 2);
    if (score > top) { top = score; best = { url: x.tab_url, m, artist: x.artist_name, song: x.song_name, name: `${x.artist_name} - ${x.song_name}` }; }
  }
  return best && best.m >= 0.75 ? best : {};
}"""


def find_official(title, artist):
    """The song's Official tab on UG: {"url", "name"}, or None."""
    from playwright.sync_api import sync_playwright
    chrome()
    q = f"{artist} {title}".strip()
    with sync_playwright() as p:
        ctx = p.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP}").contexts[0]
        pg = ctx.new_page()
        try:
            pg.goto("https://www.ultimate-guitar.com/search.php?" + urllib.parse.urlencode({"search_type": "title", "value": q}),
                    wait_until="domcontentloaded", timeout=30000)
            best = None
            for _ in range(150):
                best = pg.evaluate(FIND_JS, [q])
                if best is not None:
                    break
                pg.wait_for_timeout(100)
            return best if best and best.get("url") else None
        finally:
            pg.close()


def key(s):
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def saved_folder(title, artist):
    """The song's folder in Downloads/UG Songs, when the helper saved it before (with its PDFs)."""
    for d in [d for r in (OWN_ROOT, UG_ROOT) if r.exists() for d in r.iterdir()]:
        m = re.match(r"(.+?) - (.+?)(?: \(Key [^)]+\))?$", d.name)
        if d.is_dir() and m and key(m.group(1)) == key(title) and key(m.group(2)) == key(artist) and any(d.glob("*.pdf")):
            return d
    return None


def collect(ug_url):
    """Saves the official song's tracks as PDFs (ug_collect.py, no windows). Its folder."""
    chrome()
    say("  saving every track from UG (about 20 s)...")
    import os
    try:  # its own lines show as they happen; a stuck save (UG's player never loading) ends after 10 min
        # into a folder of our own and without telling the UG helper: else Fretboard adds the song to the
        # library by itself, a copy with no video beside the synced one this script makes
        r = subprocess.run([sys.executable, str(ROOT / "tools" / "ug_collect.py"), ug_url, "--no-ui", "--auto-official", "--claim", "--root", str(OWN_ROOT)],
                           cwd=ROOT, env={**os.environ, "PYTHONUNBUFFERED": "1", "FB_HELPER_PORT": "9"}, timeout=600)
    except subprocess.TimeoutExpired:
        sys.exit("The UG save took over 10 minutes and was stopped. Is the collector Chrome logged in to UG Pro?")
    if r.returncode != 0:
        sys.exit(f"The UG helper couldn't save {ug_url} (code {r.returncode}): see above.")
    latest = (OWN_ROOT / "latest.txt").read_text(encoding="utf-8").strip().splitlines()[-1]
    return OWN_ROOT / latest  # latest.txt holds the folder's name (a full path stays as it is)


def to_gp(folder, again):
    """The song's .gp in cache/ug, made from the folder's PDFs by Fretboard's own importer."""
    m = re.match(r"(.+?) - (.+?)(?: \(Key [^)]+\))?$", folder.name)
    gp = CACHE_UG / f"{m.group(2)} - {m.group(1)}.gp"
    if gp.exists() and not again and gp.stat().st_mtime >= max(p.stat().st_mtime for p in folder.glob("*.pdf")):
        say(f"  {gp.name} is there already")
        return gp
    say("  turning the PDFs into one .gp...")
    for i in range(3):  # again when it fails (right after a UG save it has failed without a word)
        r = subprocess.run([sys.executable, "-u", str(HERE / "ug_to_gp.py"), str(folder.parent), "-k", folder.name], cwd=ROOT)
        if gp.exists():
            break
        say(f"  the .gp wasn't made (exit code {r.returncode}); trying again")
        time.sleep(5 * (i + 1))
    if not gp.exists():
        sys.exit(f"Couldn't turn {folder.name} into a .gp: see above.")
    return gp


def add_song(gp, v, ug_url):
    """The song in songs.json, with this .gp, this video and the UG link. Its name there."""
    import hashlib
    db = songdb.load()
    sha = hashlib.sha1(gp.read_bytes()).hexdigest()[:16]
    hit = next((s for s in db["songs"] if Path(s.get("gp") or "").resolve() == gp.resolve()), None)
    if not hit:
        songdb.cmd_scan(db, [str(gp.parent)], official=True)
        db = songdb.load()
        hit = next((s for s in db["songs"] if Path(s.get("gp") or "").resolve() == gp.resolve()), None)
        if not hit:  # scan matched it to a song already in the list (same title and length): use that one
            hit = next((s for s in db["songs"] if s.get("sha1") == sha), None)
        if not hit:
            sys.exit(f"Couldn't add {gp.name} to songs.json: see above.")
    hit.update(gp=str(gp.relative_to(ROOT)) if gp.is_relative_to(ROOT) else str(gp), sha1=sha, official=True, ug=ug_url or hit.get("ug"),
               youtube=f"https://www.youtube.com/watch?v={v['id']}",
               video={"title": v["title"], "channel": v["channel"], "seconds": v["seconds"]}, status="confirmed", confidence=None)
    hit.pop("problem", None)
    songdb.save(db)
    return hit["name"]


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("link")
    ap.add_argument("--ug", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--artist", default="")
    ap.add_argument("--again", action="store_true")
    a = ap.parse_args()

    say("1. the video")
    v = video(a.link)
    title, artist = song_name(v)
    title, artist = a.title or title, a.artist or artist
    say(f"  {v['title']} ({v['channel']}, {v['seconds'] // 60}:{v['seconds'] % 60:02d}) → {artist} - {title}")

    say("2. the official tab on UG")
    ug = a.ug
    if not ug:
        hit = find_official(title, artist)
        if not hit:
            sys.exit(f"UG has no Official tab for '{artist} - {title}'. Give one with --ug URL, "
                     "or the right name with --title/--artist.")
        ug = hit["url"]
        title, artist = hit["song"] or title, hit["artist"] or artist  # UG's spelling names its folder
        say(f"  {hit['name']}: {ug}")
    if not re.search(r"-official-\d+", ug):
        sys.exit("--ug must be an Official tab (its link has -official- in it).")

    say("3. its tracks")
    folder = None if a.again else saved_folder(title, artist)
    if folder:
        say(f"  saved before: {folder.name}")
    else:
        folder = collect(ug)

    say("4. the .gp and the song list")
    gp = to_gp(folder, a.again)
    name = add_song(gp, v, ug)
    say(f"  songs.json: {name}")
    tab_s = next((s.get("seconds") for s in songdb.load()["songs"] if s["name"] == name), None)
    if tab_s and v["seconds"] and abs(v["seconds"] - tab_s) > 0.08 * tab_s:
        say(f"  WARNING: the video is {v['seconds'] // 60}:{v['seconds'] % 60:02d}, the tab {tab_s // 60}:{tab_s % 60:02d}: "
            "probably another version of the song (live, radio edit...). The line-up will likely FAIL; "
            f"songdb.py find --official suggests a video that matches the tab.")

    say("5. lining the tab up with the video")
    r = subprocess.run([sys.executable, str(HERE / "listen.py"), name, "--export", *(["--again"] if a.again else [])], cwd=ROOT)
    if r.returncode != 0:
        sys.exit("The line-up failed: see above.")
    import run
    out = HERE / "out" / "listen" / run.slug(name)
    fb = next(iter(sorted(out.glob("*.fretboard"), key=lambda p: p.stat().st_mtime, reverse=True)), None)
    verdict = json.loads((out / "qa.json").read_text(encoding="utf-8")) if (out / "qa.json").exists() else {}
    v_ = str(verdict.get("verdict") or verdict.get("result") or "").upper()
    say(f"\nDone: {fb}\nOpen it in Fretboard (Import files). Sync check: {v_ or '?'}")
    if v_ in ("LISTEN", "FAIL"):
        say(f'To line it up by eye: python tools/aligner.py "{name}"')
    sys.exit({"PASS": 0, "LISTEN": 2, "FAIL": 3}.get(v_, 0))


if __name__ == "__main__":
    main()
