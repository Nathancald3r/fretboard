"""See the TabMaker data factory: its progress, and each example's stems with their labels.

  python tools/factoryview.py            opens http://127.0.0.1:8432 in the browser
  python tools/factoryview.py --port N   another port; --no-open: don't open the browser

Reads %USERPROFILE%\\fretboard-data\\factory (or FRETBOARD_DATA), as written by tools/datafactory.py.
It only reads; it can run while the factory runs. Plain Python, no packages needed.
"""
import argparse, json, os, re, threading, time, webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

DATA = Path(os.environ.get("FRETBOARD_DATA", Path.home() / "fretboard-data"))
OUT = DATA / "factory"
PAGE = Path(__file__).with_name("factoryview.html")
SAFE = re.compile(r"^[A-Za-z0-9_.\-]+$")
_cache = {}  # labels.json path -> (mtime, summary)
_lock = threading.Lock()


def summary(lab):
    m = lab.stat().st_mtime
    with _lock:
        hit = _cache.get(lab)
        if hit and hit[0] == m:
            return hit[1]
    d = json.loads(lab.read_text(encoding="utf-8"))
    s = {"source": lab.parent.parent.name, "name": lab.parent.name, "id": d.get("id"), "duration": d.get("duration"),
         "instruments": sorted(d.get("instruments", {})), "shift_ms": d.get("label_shift_ms"),
         "stems": {k: {"rms": v.get("rms"), "notes": len(v.get("notes", []))} for k, v in d.get("stems", {}).items()},
         "made": m}
    with _lock:
        _cache[lab] = (m, s)
    return s


def examples():
    out = []
    for lab in sorted(OUT.glob("*/*/labels.json")):
        try:
            out.append(summary(lab))
        except (OSError, ValueError):
            pass  # being written right now
    return out


def read_json(p, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def progress():
    p = read_json(OUT / "progress.json")
    now = time.time()
    if p:
        p["now"] = now
        # A run updates the file at the start and end of every example (~100 s each); much longer means it stopped.
        p["state"] = "finished" if p.get("finished") else ("running" if now - p["updated"] < 900 else "stopped")
    aam_total = len(list((DATA / "aam-labels").glob("[0-9][0-9][0-9][0-9]_beatinfo.arff")))
    made = {}
    for lab in OUT.glob("*/*/labels.json"):
        made[lab.parent.parent.name] = made.get(lab.parent.parent.name, 0) + 1
    idx = read_json(OUT / "train_index.json", {})
    return {"run": p, "made": made, "aam_total": aam_total, "hours": idx.get("hours") if isinstance(idx, dict) else None}


def checks():
    out = {}
    for r in read_json(OUT / "check.json", []) or []:
        out.setdefault(r["example"], []).append(r)
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def js(self, obj):
        self.send(json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        path = self.path.split("?")[0]
        parts = [p for p in path.split("/") if p]
        try:
            if not parts:
                return self.send(PAGE.read_bytes(), "text/html; charset=utf-8")
            if parts == ["api", "progress"]:
                return self.js(progress())
            if parts == ["api", "list"]:
                return self.js({"examples": examples(), "checks": checks()})
            if len(parts) == 4 and parts[0] in ("labels", "audio") and all(SAFE.match(p) for p in parts[1:]):
                f = OUT / parts[1] / parts[2] / parts[3]
                if f.is_file():
                    return self.send(f.read_bytes(), "application/json" if parts[0] == "labels" else "audio/flac")
            self.send(b"not found", "text/plain", 404)
        except (ConnectionError, OSError):
            pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8432)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    url = f"http://127.0.0.1:{a.port}/"
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(f"Factory viewer: {url}  (reading {OUT}; Ctrl+C stops it)", flush=True)
    if not a.no_open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
