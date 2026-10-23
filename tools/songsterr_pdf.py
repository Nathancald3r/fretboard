"""Save a Songsterr song as one PDF per track, for Fretboard to import.

It uses Songsterr's own Print button, so it needs an account that can print on Songsterr
(Songsterr Plus). Without one the page prints only "Please use the website's Print button",
and this program stops and says so. It does not get around that.

How to use:
  1. In the collector Chrome (the one the UG helper starts, debugging port 9222), sign in to
     Songsterr and open the song.
  2. python tools/songsterr_pdf.py            (or give the song's URL)

The PDFs go to Downloads\\Songsterr Songs\\<Song> - <Artist>\\<Song> - <Artist> - <Track>.pdf.
Files already there are never replaced: a new copy gets " (2)". Ctrl+C stops and removes the
files this run made.
"""
import argparse, base64, json, re, sys, time
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is missing. Run:  python -m pip install playwright")

SONG_URL = re.compile(r"^https://(?:www\.)?songsterr\.com/a/wsa/(.+?)-tab-s(\d+)(?:t\d+)?(?:[/?#].*)?$")

STATE_JS = """() => {
  const el = document.getElementById('state');
  if (!el) return null;
  const st = JSON.parse(el.textContent);
  const m = (st.meta && (st.meta.current || st.meta)) || {};
  return { title: m.title, artist: m.artist, songId: m.songId, partId: st.part && st.part.partId,
           tracks: (m.tracks || []).map((t) => ({ partId: t.partId, name: t.name || '', instrument: t.instrument || '',
                                                 drums: !!t.isDrums, empty: !!t.isEmpty })) };
}"""

# Songsterr's Print button ends by calling window.print(). Catch that call instead of opening the
# print dialog, and note whether the page made its print view (no "NoPrint" marks on the tab).
CATCH_PRINT_JS = """() => {
  window.__fbPrint = null;
  window.print = () => {
    const tab = document.getElementById('tablature');
    const app = document.getElementById('app');
    const blocked = /NoPrint/.test((tab && tab.className) || '') || /NoPrint/.test((app && app.className) || '');
    window.__fbPrint = { blocked };
  };
}"""


def safe(s):
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", s or "")
    return re.sub(r"\s+", " ", s).strip(" .") or "Untitled"


def track_label(t, used):
    if t["drums"]:
        base = "Drums"
    else:
        # "Acoustic Guitar (steel)" names the sound; the track name says the player and role.
        role = t["name"].split("|")[-1].strip()
        base = t["instrument"] or role or f"Track {t['partId'] + 1}"
        if role and role.lower() not in base.lower():
            base = f"{base} ({role})"
    base = safe(base).replace(" - ", " ")  # Fretboard splits the file name on " - "
    name, n = base, 2
    while name.lower() in used:
        name, n = f"{base} {n}", n + 1
    used.add(name.lower())
    return name


def free_path(p):
    n = 2
    q = p
    while q.exists():
        q = p.with_name(f"{p.stem} ({n}){p.suffix}")
        n += 1
    return q


def find_page(ctx, url):
    if url:
        pg = ctx.new_page()
        pg.goto(url, wait_until="domcontentloaded")
        return pg, True
    for pg in ctx.pages:
        if SONG_URL.match(pg.url):
            return pg, False
    return None, False


def wait_for_tab(pg, timeout=40):
    """Wait until the tab's drawing stops changing."""
    pg.wait_for_selector("#tablature svg", state="attached", timeout=timeout * 1000)
    last, same, end = None, 0, time.time() + timeout
    while time.time() < end:
        now = pg.evaluate("() => { const t = document.getElementById('tablature'); return t ? t.querySelectorAll('*').length + ':' + t.scrollHeight : '' }")
        same = same + 1 if now == last else 0
        if same >= 3:
            return
        last = now
        pg.wait_for_timeout(500)


def print_track(ctx, pg):
    pg.evaluate(CATCH_PRINT_JS)
    pg.click("#control-print")
    end = time.time() + 30
    got = None
    while time.time() < end:
        got = pg.evaluate("window.__fbPrint")
        if got:
            break
        pg.wait_for_timeout(300)
    if not got or got["blocked"]:
        pg.keyboard.press("Escape")
        raise PermissionError(
            "Songsterr didn't make its print view for this account. Printing needs Songsterr Plus: "
            "sign in with your Plus account in this Chrome and run it again.")
    pg.wait_for_timeout(1500)  # let the print layout settle
    res = ctx.new_cdp_session(pg).send("Page.printToPDF", {"preferCSSPageSize": True, "printBackground": True})
    pg.evaluate("window.dispatchEvent(new Event('afterprint'))")
    return base64.b64decode(res["data"])


def main():
    ap = argparse.ArgumentParser(description="Save a Songsterr song as one PDF per track (needs Songsterr Plus).")
    ap.add_argument("url", nargs="?", default="", help="the song's Songsterr URL (default: the Songsterr tab open in Chrome)")
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--root", default=str(Path.home() / "Downloads" / "Songsterr Songs"))
    ap.add_argument("--only", default="", help="save only tracks whose name contains this text")
    ap.add_argument("--list", action="store_true", help="list the tracks and stop")
    ap.add_argument("--gap", type=float, default=2, help="seconds to wait between tracks")
    a = ap.parse_args()
    if a.url and not SONG_URL.match(a.url):
        sys.exit("That isn't a Songsterr song link (songsterr.com/a/wsa/...-tab-s123).")

    made, made_dir = [], None
    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(f"http://localhost:{a.port}")
        except Exception:
            sys.exit(f"Can't reach Chrome on port {a.port}. Start the collector Chrome first "
                     "(Start UG helper does that), then open the song on songsterr.com in it.")
        ctx = browser.contexts[0]
        pg, opened = find_page(ctx, a.url)
        if not pg:
            sys.exit("No Songsterr song is open in the collector Chrome. Open the song there, or give its URL.")
        start_url = pg.url
        m = SONG_URL.match(start_url)
        slug, song_id = m.group(1), m.group(2)
        try:
            pg.reload(wait_until="domcontentloaded")  # fresh page state for the song
            info = pg.evaluate(STATE_JS)
            if not info or not info["tracks"]:
                sys.exit("Couldn't read the song's track list from the page.")
            used = set()
            tracks = [dict(t, label=track_label(t, used)) for t in info["tracks"] if not t["empty"]]
            if a.only:
                tracks = [t for t in tracks if a.only.lower() in (t["label"] + " " + t["name"]).lower()]
            song, artist = safe(info["title"]), safe(info["artist"])
            print(f"{info['title']} - {info['artist']}: {len(tracks)} track(s)")
            for t in tracks:
                print(f"  {t['partId']}: {t['label']}")
            if a.list or not tracks:
                return

            out = Path(a.root) / f"{song} - {artist}"
            if not out.exists():
                out.mkdir(parents=True)
                made_dir = out
            for i, t in enumerate(tracks, 1):
                if i > 1 and a.gap:
                    time.sleep(a.gap)
                print(f"[{i}/{len(tracks)}] {t['label']} ...", flush=True)
                pg.goto(f"https://www.songsterr.com/a/wsa/{slug}-tab-s{song_id}t{t['partId']}", wait_until="domcontentloaded")
                now = pg.evaluate(STATE_JS)
                if not now or now["partId"] != t["partId"]:
                    raise RuntimeError(f"Songsterr didn't switch to track {t['partId']} ({t['label']}).")
                wait_for_tab(pg)
                data = print_track(ctx, pg)
                dest = free_path(out / f"{song} - {artist} - {t['label']}.pdf")
                tmp = dest.with_suffix(".part")
                tmp.write_bytes(data)
                tmp.rename(dest)
                made.append(dest)
                print(f"    saved {dest.name} ({len(data) // 1024} KB)")
            print(f"Done: {len(made)} PDF(s) in {out}")
        except KeyboardInterrupt:
            for f in made:
                f.unlink(missing_ok=True)
            if made_dir and made_dir.exists() and not any(made_dir.iterdir()):
                made_dir.rmdir()
            print("\nStopped. Removed the files this run made.")
        except Exception as e:
            msg = str(e) if isinstance(e, (PermissionError, RuntimeError)) else f"{type(e).__name__}: {str(e).splitlines()[0]}"
            print(f"\nStopped: {msg}")
            if made:
                print(f"Kept {len(made)} PDF(s) already saved in {made[0].parent}")
            elif made_dir and made_dir.exists() and not any(made_dir.iterdir()):
                made_dir.rmdir()
            sys.exit(1)
        finally:
            try:
                if opened:
                    pg.close()
                elif pg.url != start_url:
                    pg.goto(start_url, wait_until="domcontentloaded")
            except Exception:
                pass


if __name__ == "__main__":
    main()
