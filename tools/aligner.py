"""Line a song's tab up with its video by eye: the tab's sound and the video's sound as two waveforms.

  python tools/aligner.py            opens http://127.0.0.1:8433 in the browser
  python tools/aligner.py NAME       opens that song (part of its name is enough)
  python tools/aligner.py --port N   another port; --no-open: don't open the browser

Reads the songs tests/yt2gp5/listen.py and fromlink.py made (tests/yt2gp5/out/listen/<song>/), the tab's
rendered tracks and the video's audio from tests/yt2gp5/cache/real/. Nudge the video left or right, cut the
song into sections that each get their own shift, zoom with the number keys, play both to hear it. Save
writes the new bar times into the song's .fretboard file (the old one is kept as .before-aligner), then
import that file into Fretboard ("Replace it"). Everything stays on this PC. Needs numpy.
"""
import argparse
import datetime
import json
import re
import sys
import threading
import wave
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import numpy as np
except ImportError:
    sys.exit("numpy is missing. Run it with the yt2gp5 Python: %USERPROFILE%\\.fretboard\\yt2gp5-venv\\Scripts\\python.exe tools/aligner.py")

ROOT = Path(__file__).resolve().parents[1]
LISTEN = ROOT / "tests" / "yt2gp5" / "out" / "listen"
CACHE = ROOT / "tests" / "yt2gp5" / "cache" / "real"
PAGE = Path(__file__).with_name("aligner.html")
RATE = 22050  # the page's audio: mono, half the pipeline's rate (plenty for note starts)
SAFE = re.compile(r"^[A-Za-z0-9_.\-]+$")
_lock = threading.Lock()


def read_json(p, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def fretboard_of(folder):
    files = sorted(folder.glob("*.fretboard"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def songs():
    out = []
    for d in sorted(LISTEN.glob("*/")):
        info = read_json(d / "info.json")
        if info and fretboard_of(d):
            out.append({"slug": d.name, "name": info.get("name", d.name)})
    return out


def video_id(info):
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", info.get("url") or "")
    return m.group(1) if m else None


def tab_tracks(info):
    """The tab's tracks as the pipeline rendered them (float32 stereo, 44.1 kHz), or None."""
    sub = CACHE / info["slug"] / f"gp-{info['gp_sha']}" / "tracks"
    meta = read_json(sub / "meta.json")
    if not meta:
        return None
    files = [sub / f"track{t['index']}.f32" for t in meta["tracks"]]
    return meta, [f for f in files if f.exists()]


def to_wav(y, path):
    pcm = (np.clip(y, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


def half(y):
    n = len(y) // 2 * 2
    return y[:n].reshape(-1, 2).mean(axis=1)


def make_tab_wav(info, path):
    """All the tab's tracks mixed, on the tab's own time (not stretched to the video), peaking at 0.9."""
    found = tab_tracks(info)
    if not found:
        raise FileNotFoundError("The tab's rendered tracks are not saved (tests/yt2gp5/cache/real/...). Run listen.py again.")
    meta, files = found
    mixed = None
    for f in files:
        y = half(np.fromfile(f, dtype=np.float32).reshape(-1, 2).mean(axis=1))
        mixed = y if mixed is None else mixed[:len(y)] + y[:len(mixed)]
    to_wav(mixed * (0.9 / max(1e-6, float(np.abs(mixed).max()))), path)


def make_rec_wav(info, path):
    vid = video_id(info)
    src = CACHE / info["slug"] / f"recording-{vid}.wav"
    if not vid or not src.exists():
        raise FileNotFoundError(f"The video's audio is not saved ({src.name}). Run listen.py or fromlink.py again.")
    with wave.open(str(src)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("The video's audio is not 16-bit.")
        ch, rate = w.getnchannels(), w.getframerate()
        y = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    y = y.reshape(-1, ch).mean(axis=1)
    if rate == RATE * 2:
        y = half(y)
    elif rate != RATE:
        y = np.interp(np.arange(0, len(y) / rate, 1 / RATE), np.arange(len(y)) / rate, y)
    to_wav(y * (0.9 / max(1e-6, float(np.abs(y).max()))), path)


def audio_file(slug, which):
    """tab.wav or rec.wav for a song, made on first ask and kept (renewed when the tab or the video changed)."""
    d = LISTEN / slug
    info = read_json(d / "info.json")
    key = info["gp_sha"] if which == "tab" else video_id(info)
    out = d / "aligner"
    out.mkdir(exist_ok=True)
    wav, stamp = out / f"{which}.wav", out / f"{which}.key"
    with _lock:
        if not wav.exists() or not stamp.exists() or stamp.read_text() != str(key):
            (make_tab_wav if which == "tab" else make_rec_wav)(info, wav)
            stamp.write_text(str(key))
    return wav


def song_data(slug):
    d = LISTEN / slug
    info = read_json(d / "info.json")
    fb = fretboard_of(d)
    entry = read_json(fb)["songs"][0]
    return {
        "slug": slug, "name": info["name"], "file": str(fb), "rate": RATE,
        "bars": info["bars"],  # [tab time, bar number, beats, section]
        "points": entry.get("syncPoints") or [],  # [bar index, video ms]
        "notes": [round(n[1], 3) for n in info.get("notes", [])],  # where the tab's notes start (tab time)
        "tracks": [t["name"] for t in info.get("tracks", [])],
        "aligned": (entry.get("autoSync") or {}).get("aligned"),
    }


def save(slug, points, note):
    d = LISTEN / slug
    fb = fretboard_of(d)
    backup = fb.with_name(fb.name + ".before-aligner")
    if not backup.exists():
        backup.write_bytes(fb.read_bytes())  # the first version stays; later saves build on each other
    doc = json.loads(fb.read_text(encoding="utf-8"))
    entry = doc["songs"][0]
    pts = [[int(p[0]), int(p[1])] for p in points]
    if not pts or any(b[1] <= a[1] for a, b in zip(pts, pts[1:])) or pts[0][1] < 0:
        raise ValueError("The bar times must start at 0 or later and keep rising.")
    entry["syncPoints"] = pts
    entry["syncDone"] = True
    auto = entry.get("autoSync") or {}
    auto["aligned"] = {"by": "aligner", "at": datetime.datetime.now().isoformat(timespec="seconds"), "note": note}
    entry["autoSync"] = auto
    fb.write_text(json.dumps(doc), encoding="utf-8")
    return {"ok": True, "file": str(fb), "backup": str(backup), "points": len(pts)}


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

    def js(self, obj, code=200):
        self.send(json.dumps(obj).encode(), "application/json", code)

    def do_GET(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        try:
            if not parts:
                return self.send(PAGE.read_bytes(), "text/html; charset=utf-8")
            if parts == ["api", "songs"]:
                return self.js(songs())
            if len(parts) == 3 and parts[:2] == ["api", "song"] and SAFE.match(parts[2]):
                return self.js(song_data(parts[2]))
            if len(parts) == 3 and parts[0] == "audio" and SAFE.match(parts[1]) and parts[2] in ("tab.wav", "rec.wav"):
                return self.send(audio_file(parts[1], parts[2][:3]).read_bytes(), "audio/wav")
            self.send(b"not found", "text/plain", 404)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:  # shown on the page
            self.js({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):
        parts = [p for p in self.path.split("/") if p]
        try:
            if len(parts) == 3 and parts[:2] == ["api", "save"] and SAFE.match(parts[2]):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                return self.js(save(parts[2], body["points"], body.get("note", "")))
            self.send(b"not found", "text/plain", 404)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:
            self.js({"error": f"{type(e).__name__}: {e}"}, 400)


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", nargs="?", default="")
    ap.add_argument("--port", type=int, default=8433)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    query = ""
    if a.name:
        hits = [s for s in songs() if a.name.lower().replace(" ", "_") in s["slug"].lower() or a.name.lower() in s["name"].lower()]
        if not hits:
            sys.exit(f"No saved song matches '{a.name}'. Songs: " + ", ".join(s["name"] for s in songs()))
        query = "?song=" + hits[0]["slug"]
    url = f"http://127.0.0.1:{a.port}/{query}"
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(f"Aligner: {url}  (Ctrl+C stops it)", flush=True)
    if not a.no_open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
