"""UG part PDFs → .gp files, read by Fretboard's own PDF importer (render.js ugFolderToGp).

    python tests/yt2gp5/ug_to_gp.py "C:/Users/natha/Downloads/UG Songs" [-k NAME]

Each folder "Title - Artist (Key X)" with part PDFs becomes cache/ug/Artist - Title.gp, ready for
`songdb.py scan tests/yt2gp5/cache/ug`. Folders that already hold a .gp/.gp5/.gpx, or have no PDFs, are skipped.
"""
import argparse
import base64
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import run  # the page server

OUT = run.CACHE / "ug"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("-k", default="")
    ap.add_argument("--keep-off", action="store_true", help="keep parts whose bar count differs from the song's")
    args = ap.parse_args()
    todo = []
    for d in sorted(Path(args.folder).iterdir()):
        if not d.is_dir() or args.k.lower() not in d.name.lower():
            continue
        m = re.match(r"(.+?) - (.+?)(?: \(Key ([^)]+)\))?$", d.name)
        title, artist, key = m.group(1), m.group(2), m.group(3)
        # The helper's run file lists the files of its latest capture. A folder captured twice also holds the
        # older files ("Drums.pdf" from an old helper, one squeezed low-res picture, beside "Drums (2).pdf").
        pdfs = []
        try:
            info = json.loads((d / "fretboard-run.json").read_text(encoding="utf-8"))
            pdfs = [(d / t["file"], t["name"]) for t in info.get("tracks", []) if t["file"].lower().endswith(".pdf") and (d / t["file"]).exists()]
            key = info.get("key") or key
        except (OSError, ValueError, KeyError):
            pass
        if not pdfs:
            pdfs = [(p, None) for p in sorted(d.glob("*.pdf")) if not re.search(r"\(\d+\)\.pdf$", p.name)]
        if not pdfs or any(d.glob("*.gp*")) or " Power " in d.name:
            print(f"skip {d.name}")
            continue
        todo.append((d, pdfs, title, artist, key))
    OUT.mkdir(parents=True, exist_ok=True)
    from playwright.sync_api import sync_playwright
    srv = run.serve()
    with sync_playwright() as pw:
        page = pw.chromium.launch().new_page()
        page.set_default_timeout(1_200_000)
        page.on("pageerror", lambda e: print("  page error:", e, flush=True))
        page.goto(f"http://127.0.0.1:{srv.server_address[1]}/tests/yt2gp5/render.html")
        page.wait_for_function("window.renderReady === true")
        for d, pdfs, title, artist, key in todo:
            print(f"{artist} - {title}: {len(pdfs)} PDFs", flush=True)
            files = [{"name": p.name, "part": part, "b64": base64.b64encode(p.read_bytes()).decode()} for p, part in pdfs]
            try:
                r = page.evaluate("([f, o]) => ugFolderToGp(f, o)", [files, {"title": title, "artist": artist, "key": key, "keepOff": args.keep_off}])
            except Exception as e:
                print(f"  ERROR {e}", flush=True)
                continue
            dest = OUT / f"{artist} - {title}.gp"
            dest.write_bytes(base64.b64decode(r["gp"]))
            print(f"  {r['bars']} bars -> {dest.name}\n  " + "; ".join(r["parts"])
                  + (f"\n  skipped: {', '.join(r['skipped'])}" if r["skipped"] else "")
                  + (f"\n  WRONG BAR COUNT ({'kept' if args.keep_off else 'left out'}): {'; '.join(r['off'])}" if r["off"] else ""),
                  flush=True)


if __name__ == "__main__":
    main()
