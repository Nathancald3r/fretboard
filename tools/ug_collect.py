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


def song_page(ctx, url):
    for pg in ctx.pages:
        if pg.url.split("?")[0] == url.split("?")[0]:
            return pg
    pg = ctx.new_page()
    pg.set_viewport_size({"width": 1500, "height": 1000})
    pg.goto(url, wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)
    return pg


def open_instruments(pg):
    if pg.get_by_role("heading", name="Instruments").count() == 0:
        pg.get_by_role("button", name="Collapse").first.click()
        pg.wait_for_timeout(300)
    # the player's expand control sits at the edge of the score
    if pg.get_by_role("heading", name="Instruments").count() == 0 or not pg.get_by_role("heading", name="Instruments").first.is_visible():
        pg.evaluate("""()=>{const b=document.querySelector('[class*=_0kBTe]');if(b)b.click()}""")
        pg.wait_for_timeout(1200)


def track_names(pg):
    return pg.evaluate("""()=>{const h=[...document.querySelectorAll('h2')].find(e=>e.innerText.trim()=='Instruments');
      if(!h)return [];const root=h.closest('[class*=ivABo]')||h.parentElement.parentElement;
      return root.innerText.split('\\n').map(s=>s.trim()).filter(s=>s&&!['Instruments','Pin','Unpin','C','S','M'].includes(s)&&!/^\\d+%$/.test(s))}""")


def song_name(pg):
    t = re.sub(r"^Official\s+", "", pg.evaluate("document.querySelector('h1')?.innerText||document.title"), flags=re.I)
    return re.sub(r'[\\/:*?"<>|]+', " ", re.sub(r"\s+(Tab|Chords|Pro)\b.*$", "", t.split(" by ")[0], flags=re.I)).strip() or "Song"


def main():
    global PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--gap", type=float, default=10, help="seconds to wait between tracks")
    a = ap.parse_args()
    PORT = a.port
    only = [s.strip().lower() for s in a.only.split(",") if s.strip()]

    with sync_playwright() as p:
        ctx = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
        pg = song_page(ctx, a.url)
        if "login" in pg.url.lower():
            sys.exit("Not logged in: log in to UG Pro in that Chrome window and rerun.")
        open_instruments(pg)
        names = track_names(pg)
        song = song_name(pg)
        if not names:
            sys.exit("Couldn't read the Instruments list. Open the song's player page, show the Instruments panel, rerun.")
    if only:
        names = [n for n in names if n.lower() in only]
    out = Path(a.out) if a.out else Path.home() / "Downloads" / f"UG {song}"
    print(f"{song}: {len(names)} tracks -> {', '.join(names)}\n"
          f"Saving each one into {out} by itself; keep hands off keyboard and mouse until it says Done.\n")

    out.mkdir(parents=True, exist_ok=True)
    for n in names:
        label = f"{song} - {n}"
        dest = out / f"{label}.pdf"
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
            pr.locator("cr-button.action-button").first.click(no_wait_after=True, timeout=5000)
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(DIALOG), str(dest)],
                           capture_output=True, text=True)
        print(f"  {dest.name}: {r.stdout.strip() or r.stderr.strip()[:80]}")
        for _ in range(30):
            if not print_open():
                break
            time.sleep(1)
        time.sleep(a.gap)  # unhurried pace, about what printing by hand takes
    print("Done. Now use 'PDFs for this song' in Fretboard.")


if __name__ == "__main__":
    main()
