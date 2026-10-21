"""Walk through every instrument/vocal track of an official Ultimate Guitar Tab Pro song and
open Chrome's Print window for each one, already named "<Song> - <Instrument>".

It picks "Save as PDF", fills the file name and saves, all by itself (hands off the
keyboard while it runs). Your login is never touched.

1. Start Chrome with a debugging port (PowerShell):
     & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\ug-chrome"
   Log in to UG Pro in that window once, and open the song page.
2. pip install playwright
3. python tools/ug_collect.py "<song url>"            (add --only "Lead Guitar,Piano" to pick tracks)

Save every PDF into one folder, then use "PDFs for this song" in Fretboard.
"""
import argparse, json, re, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

PORT = 9222
DIALOG = Path(__file__).with_name("ug_save_dialog.ps1")


def targets():
    with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=5) as r:
        return json.load(r)


def print_open():
    return any(t["url"].startswith("chrome://print") for t in targets())


def close_old_prints():
    """A Print window left open freezes its tab, so shut any before starting."""
    ts = targets()
    stale = [t for t in ts if t["url"].startswith("chrome://print") and t["type"] == "page"]
    if stale:  # the tab that opened it can stay frozen, so close the UG tabs too; a fresh one opens
        stale += [t for t in ts if t["type"] == "page" and "tabs.ultimate-guitar.com/tab/" in t["url"]]
        # keep a tab open so closing those never closes the whole Chrome window
        ids = {t["id"] for t in stale}
        if not any(t["type"] == "page" and t["id"] not in ids for t in ts):
            urllib.request.urlopen(urllib.request.Request(f"http://localhost:{PORT}/json/new?about:blank", method="PUT"), timeout=5).read()
    for t in stale:
        urllib.request.urlopen(f"http://localhost:{PORT}/json/close/{t['id']}", timeout=5).read()
    time.sleep(1)


def set_a4(pr):
    """Paper size A4 (Letter cuts words off the page edge). It sits under 'More settings'."""
    try:
        more = pr.get_by_text("More settings", exact=True)
        if more.count() and more.first.is_visible():
            more.first.click(timeout=3000)
            pr.wait_for_timeout(600)
    except Exception:
        pass
    sels = pr.locator("select")
    for i in range(sels.count()):
        s = sels.nth(i)
        if s.evaluate("e=>[...e.options].some(o=>o.text.trim()=='A4')"):
            s.select_option(label=next(t for t in s.evaluate("e=>[...e.options].map(o=>o.text)") if t.strip() == "A4"))
            pr.wait_for_timeout(2000)  # preview re-renders
            return True
    print("  (couldn't find the A4 paper option; saved with Chrome's default size)")
    return False


def song_page(ctx, url):
    for pg in reversed(ctx.pages):
        if pg.url.split("?")[0] == url.split("?")[0] and not pg.is_closed():
            return pg
    pg = ctx.new_page()
    pg.set_viewport_size({"width": 1500, "height": 1000})
    pg.goto(url, wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)
    return pg


def open_instruments(pg):
    """Show the player's Instruments panel (track list) if it's folded away."""
    for _ in range(3):
        shown = pg.evaluate("""()=>{const h=[...document.querySelectorAll('h2')].find(e=>e.innerText.trim()=='Instruments');
          if(h&&h.getBoundingClientRect().width>0&&h.closest('[aria-hidden=true]')==null)return true;
          return false}""")
        if shown:
            return
        try:
            pg.locator('[class*=_0kBTe]').first.click(timeout=3000)  # the |<- tab at the score's right edge
        except Exception:
            pass
        pg.wait_for_timeout(1200)


def track_names(pg):
    return pg.evaluate("""()=>{const h=[...document.querySelectorAll('h2')].find(e=>e.innerText.trim()=='Instruments');
      if(!h)return [];const root=h.closest('[class*=ivABo]')||h.parentElement.parentElement;
      return root.innerText.split('\\n').map(s=>s.trim()).filter(s=>s&&!['Instruments','Pin','Unpin','C','S','M'].includes(s)&&!/^\\d+%$/.test(s))}""")


def song_name(pg):
    """("Champion", "Bethel Music") from the page heading "Official Champion Tab by Bethel Music"."""
    h1, link = pg.evaluate("[document.querySelector('h1')?.innerText||'', document.querySelector('a[href*=\"/artist/\"]')?.innerText||'']")
    t = re.sub(r"^Official\s+", "", h1.strip(), flags=re.I)
    song, _, artist = t.partition(" by ")
    # the heading sometimes loads without "by <artist>": use the artist link, else the URL (/tab/bethel-music/...)
    artist = artist or link.strip() or pg.url.split("/tab/")[-1].split("/")[0].replace("-", " ").title()
    clean = lambda x: re.sub(r'[\\/:*?"<>|]+', " ", x).strip()
    return clean(re.sub(r"\s+(Tab|Chords|Pro)\b.*$", "", song, flags=re.I)) or "Song", clean(artist.split(" @")[0])


def main():
    global PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default="", help="exact folder to save into")
    ap.add_argument("--root", default=str(Path.home() / "Downloads" / "UG Songs"), help="parent of the per-song folders")
    ap.add_argument("--gap", type=float, default=10, help="seconds to wait between tracks")
    a = ap.parse_args()
    PORT = a.port
    only = [s.strip().lower() for s in a.only.split(",") if s.strip()]
    close_old_prints()

    with sync_playwright() as p:
        ctx = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
        pg = song_page(ctx, a.url)
        if "login" in pg.url.lower():
            sys.exit("Not logged in: log in to UG Pro in that Chrome window and rerun.")
        open_instruments(pg)
        names = track_names(pg)
        song, artist = song_name(pg)
        # original key from the "Tuning: ... · Key: Bb · Capo: ..." line
        km = re.search(r"Key:\s*([A-G][#b♭♯]?m?)", pg.evaluate("document.body.innerText"))
        key = km.group(1).replace("♭", "b").replace("♯", "#") if km else ""
        if not names:
            sys.exit("Couldn't read the Instruments list. Open the song's player page, show the Instruments panel, rerun.")
    if only:
        names = [n for n in names if n.lower() in only]
    # one folder per song: Downloads\UG Songs\Champion - Bethel Music (Key Bb)
    folder = " - ".join(x for x in (song, artist) if x) + (f" (Key {key})" if key else "")
    out = (Path(a.out) if a.out else Path(a.root) / folder).resolve()
    old = Path.home() / "Downloads" / f"UG {song}"  # earlier runs saved here; move them over
    if not a.out and old.is_dir() and not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        old.rename(out)
    print(f"{song}: {len(names)} tracks -> {', '.join(names)}\n"
          f"Saving each one into {out} by itself; keep hands off keyboard and mouse until it says Done.\n")

    out.mkdir(parents=True, exist_ok=True)
    for n in names:
        label = f"{song} - {artist} - {n}" if artist else f"{song} - {n}"
        dest = out / f"{label}.pdf"
        k = 2
        while dest.exists():  # every track is saved; an existing file is never replaced, the new one gets "(2)", "(3)"...
            dest = out / f"{label} ({k}).pdf"
            k += 1
        with sync_playwright() as p:
            ctx = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
            pg = song_page(ctx, a.url)
            open_instruments(pg)
            pg.get_by_text(n, exact=True).first.click()
            pg.wait_for_timeout(2500)
            # window.print runs after this call returns, so the driver isn't stuck behind the dialog
            pg.evaluate("""l=>{document.title=l;setTimeout(()=>[...document.querySelectorAll('button')]
                .find(b=>b.innerText.trim()=='Print').click(),200)}""", label)
        time.sleep(4)
        with sync_playwright() as p:
            ctx = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
            pr = [x for x in ctx.pages if x.url.startswith("chrome://print")][-1]
            pr.locator("select").first.select_option("Save as PDF/local/")
            pr.wait_for_timeout(2500)
            set_a4(pr)
            pr.locator("cr-button.action-button").first.click(no_wait_after=True, timeout=5000)
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(DIALOG), str(dest)],
                           capture_output=True, text=True)
        for _ in range(40):  # Chrome writes the file a moment after Save
            if dest.exists():
                break
            time.sleep(0.5)
        print(f"  {dest.name}: " + ("saved" if dest.exists() else
              f"NOT saved ({r.stdout.strip() or r.stderr.strip()[:80]}); rerun later to fetch it"))
        for _ in range(30):
            if not print_open():
                break
            time.sleep(1)
        close_old_prints()  # a Print window that didn't close would freeze the next track
        time.sleep(a.gap)  # unhurried pace, about what printing by hand takes
    print("Done. Now use 'PDFs for this song' in Fretboard.")


if __name__ == "__main__":
    main()
