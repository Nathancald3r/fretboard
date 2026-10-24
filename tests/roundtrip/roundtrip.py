"""Round-trip test of the PDF tab importer: how precisely does Fretboard read a song back?

For each song in tests/roundtrip/songs (a Guitar Pro file or alphaTex whose content is known):
  1. alphaTab draws each tab track the way UG's Tablature view looks, and the lines are laid out on
     pages like the UG helper's PDFs (one PDF per instrument; Letter paper, set in config.json)
  2. the real importer (pdfToTab in js/pdftab.js, which calls ugToAlphaTex) reads each PDF, and with
     two or more tracks the parts are also combined as the app does (ugToAlphaTex with extra parts)
  3. the result is compared with the original bar by bar (bar count, time signature, tempo, and per
     note the string/fret/onset/duration), and scored. A song scores its worst track.

Run (from the project folder):  python tests/roundtrip/roundtrip.py
  -k NAME     only songs whose file name contains NAME
  --keep      keep the PDFs and the importer's alphaTex in tests/roundtrip/out/
  --verbose   list the bars that differ for every track, not only failing ones
Pass marks are in tests/roundtrip/config.json. Exits 1 when a song falls below its pass mark.

Needs Python Playwright with its Chromium (pip install playwright; playwright install chromium).
The page files are served by a throwaway server on a free 127.0.0.1 port inside this process.
"""
import argparse
import base64
import functools
import http.server
import json
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
KINDS = {".gp": "gp", ".gp3": "gp", ".gp4": "gp", ".gp5": "gp", ".gpx": "gp", ".atex": "tex", ".alphatex": "tex", ".tex": "tex"}


class Quiet(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".woff2": "font/woff2", ".wasm": "application/wasm"}

    def log_message(self, *a):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def weighted(checks, weights):
    total = sum(weights.get(k, 0) for k in checks)
    return sum(v * weights.get(k, 0) for k, v in checks.items()) / total if total else 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-k", default="", help="only songs whose file name contains this")
    ap.add_argument("--keep", action="store_true", help="keep PDFs and alphaTex in tests/roundtrip/out")
    ap.add_argument("--verbose", action="store_true", help="list differing bars for every track")
    args = ap.parse_args()

    cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    weights, render = cfg["weights"], cfg.get("render", {})
    per_song = cfg.get("songs", {})
    songs = sorted(p for p in (HERE / "songs").iterdir() if p.suffix.lower() in KINDS and args.k.lower() in p.name.lower())
    if not songs:
        print("no songs found")
        return 2
    out = HERE / "out"
    if args.keep:
        out.mkdir(exist_ok=True)

    from playwright.sync_api import sync_playwright
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/tests/roundtrip/harness.html"
    results, failed = [], []
    t_all = time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        # 2x pictures, like the helper's print pictures
        ctx = browser.new_context(device_scale_factor=2, viewport={"width": 1200, "height": 900})
        page = ctx.new_page()
        page.set_default_timeout(120000)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        def fresh(path):  # a new page with the song loaded
            page.goto(base)
            page.wait_for_function("() => window.loadSong && window.readSong")
            return page.evaluate("([b, k]) => loadSong(b, k)", [base64.b64encode(path.read_bytes()).decode(), KINDS[path.suffix.lower()]])
        for path in songs:
            conf = {**cfg.get("default", {}), **per_song.get(path.name, {})}
            song = {"song": path.name, "tracks": [], "pass": conf.get("pass", cfg["pass"])}
            results.append(song)
            try:
                info = fresh(path)
            except Exception as e:  # the song file itself doesn't load
                song.update(score=0.0, ok=False, error=f"couldn't load: {str(e).splitlines()[0]}")
                failed.append(path.name)
                continue
            tracks = [t for t in info["tracks"] if t["tab"] and (not conf.get("tracks") or t["index"] in conf["tracks"])]
            parts = []
            for t in tracks:  # one PDF per track, each drawn on a fresh page
                fresh(path)
                drawn = page.evaluate("([i, o]) => renderTrack(i, o)", [t["index"], render])
                pdf = page.pdf(prefer_css_page_size=True, print_background=True)
                t["file"] = f"{path.stem} - {t['name'] or 'Track ' + str(t['index'] + 1)}"
                t.update(drawn)
                if args.keep:
                    (out / f"{t['file']}.pdf").write_bytes(pdf)
                parts.append({"b64": base64.b64encode(pdf).decode(), "index": t["index"]})
            # a fresh page for the reading, as in the app: all of the song's PDFs read and combined
            fresh(path)
            read = page.evaluate("([p, o]) => readSong(p, o)", [parts, {"listBars": cfg.get("listBars", 5)}]) if parts else {"tracks": []}
            if args.keep and read.get("togetherTex"):
                (out / f"{path.stem} - all parts.atex").write_text(read["togetherTex"], encoding="utf-8")
            for t, res in zip(tracks, read["tracks"]):
                if args.keep and res.get("tex"):
                    (out / f"{t['file']}.atex").write_text(res["tex"], encoding="utf-8")
                res.pop("tex", None)
                res["track"] = t["name"]
                res["lines"], res["pages"] = t["lines"], t["pages"]
                res["score"] = weighted(res["checks"], weights) if "checks" in res else 0.0
                song["tracks"].append(res)
            # the parts as the app combines them (cut or padded to the first part's bars)
            for t, res in zip(tracks, read.get("together") or []):
                res["track"] = f"{t['name']} (all parts)"
                res["score"] = weighted(res["checks"], weights) if "checks" in res else 0.0
                res.setdefault("ms", 0)
                song["tracks"].append(res)
            song["score"] = min((r["score"] for r in song["tracks"]), default=0.0)
            song["ok"] = bool(song["tracks"]) and song["score"] >= song["pass"]
            if not song["ok"]:
                failed.append(path.name)
        browser.close()
    srv.shutdown()

    # the scorecard
    names = list(weights)
    print()
    print(f"{'song / track':44} {'score':>6}  " + " ".join(f"{n[:7]:>7}" for n in names) + "   ms")
    print("-" * (54 + 8 * len(names) + 5))
    for s in results:
        print(f"{s['song'][:44]:44} {s['score'] * 100:5.1f}%  {'PASS' if s['ok'] else 'FAIL'} (pass {s['pass'] * 100:.0f}%)")
        if s.get("error"):
            print(f"{'':6}{s['error']}")
        for r in s["tracks"]:
            label = f"  {r['track'][:40]}"
            if "error" in r:
                print(f"{label:44}   0.0%  {r['error']}")
                continue
            print(f"{label:44} {r['score'] * 100:5.1f}%  " + " ".join(f"{r['checks'][n] * 100:6.1f}%" for n in names) + f" {r['ms']:5d}")
            f = r["facts"]
            if f["bars"][0] != f["bars"][1] or f["tempo"][0] != f["tempo"][1] or f["notes"][0] != f["notes"][1]:
                print(f"{'':6}bars {f['bars'][0]} -> {f['bars'][1]}   tempo {f['tempo'][0]} -> {f['tempo'][1]}   notes {f['notes'][0]} -> {f['notes'][1]}")
            if r["diffs"] and (args.verbose or not s["ok"]):
                for d in r["diffs"]:
                    print(f"{'':6}bar {d['bar']}: {d['why']}")
                    print(f"{'':10}want {d['want']}")
                    print(f"{'':10}got  {d['got']}")
    if errors:
        print("\npage errors:", *errors[:5], sep="\n  ")
    overall = sum(s["score"] for s in results) / len(results)
    print(f"\n{len(results) - len(failed)} of {len(results)} songs pass, mean score {overall * 100:.1f}%, {time.time() - t_all:.0f} s")
    if args.keep:
        (out / "report.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
