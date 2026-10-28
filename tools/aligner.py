"""Line a song's tab up with its video by eye: the tab's sound and the video's sound as two waveforms.

  python tools/aligner.py            opens http://127.0.0.1:8433 in the browser
  python tools/aligner.py NAME       opens that song (part of its name is enough)
  python tools/aligner.py --port N   another port; --no-open: don't open the browser

Reads the songs tests/yt2gp5/listen.py and fromlink.py made (tests/yt2gp5/out/listen/<song>/), the tab's
rendered tracks and the video's audio from tests/yt2gp5/cache/real/. Nudge the video left or right, cut the
song into sections that each get their own shift, zoom with the number keys, play both to hear it. Save
writes the new bar times into the song's .fretboard file (the old one is kept as .before-aligner), then
import that file into Fretboard ("Replace it"). Everything stays on this PC. Needs numpy.

Markers (X "around here", Shift+X "exactly here"), the / command box (@15-51, lock1, lock2, squeeze, retry ...) and Retry are
described in CLAUDE.md. The markers are kept in out/listen/<song>/aligner/markers.json; Retry (POST /api/retry/<song>) finds the
shift around each marker by the note starts, and the page applies the ones you pick.
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
AUDIO = re.compile(r"^(tab|rec|tab-\d{1,3}|rec-(drums|bass|other|vocals))\.wav$")
_lock = threading.Lock()


def read_json(p, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def fretboard_of(folder):
    """The song's own file; the variants beside it ("(key points)", "(steady)"...) only when it has none (the way qa.py picks it).
    Newest first among equals. A stale "(key points)" file put How Great's bar 1 at 0 s in the aligner while the song's own file had 8 s."""
    files = sorted(folder.glob("*.fretboard"), key=lambda p: ("(" in p.stem, -p.stat().st_mtime))
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


def read_mono(src):
    """A 16-bit wav as mono float32 at RATE."""
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
    return y


def rec_source(info):
    vid = video_id(info)
    src = CACHE / info["slug"] / f"recording-{vid}.wav"
    if not vid or not src.exists():
        raise FileNotFoundError(f"The video's audio is not saved ({src.name}). Run listen.py or fromlink.py again.")
    return src


def make_rec_wav(info, path):
    y = read_mono(rec_source(info))
    to_wav(y * (0.9 / max(1e-6, float(np.abs(y).max()))), path)


# The separate instruments, for the page's loudness sliders. Each is scaled by the same factor as the whole mix,
# so the tab's tracks add up to tab.wav and the video's stems add up (about) to rec.wav.
STEMS = ("drums", "bass", "other", "vocals")  # the video's stems, when drumclock.py has split it
_scales = {}


def stems_dir(info):
    vid = video_id(info)
    d = CACHE / info["slug"] / f"stems-{vid}"
    return d if vid and all((d / f"{s}.wav").exists() for s in STEMS) else None


def tab_files(info):
    found = tab_tracks(info)
    if not found:
        return []
    meta, _ = found
    sub = CACHE / info["slug"] / f"gp-{info['gp_sha']}" / "tracks"
    return [(t["index"], t["name"], sub / f"track{t['index']}.f32") for t in meta["tracks"] if (sub / f"track{t['index']}.f32").exists()]


def tab_mono(f):
    return half(np.fromfile(f, dtype=np.float32).reshape(-1, 2).mean(axis=1))


def scale_of(kind, info):
    key = (kind, info["gp_sha"] if kind == "tab" else video_id(info))
    if key not in _scales:
        if kind == "tab":
            mixed = None
            for _, _, f in tab_files(info):
                y = tab_mono(f)
                mixed = y if mixed is None else mixed[:len(y)] + y[:len(mixed)]
        else:
            mixed = read_mono(rec_source(info))
        _scales[key] = 0.9 / max(1e-6, float(np.abs(mixed).max()))
    return _scales[key]


def make_tab_track(info, index, path):
    f = next((f for i, _, f in tab_files(info) if i == index), None)
    if f is None:
        raise FileNotFoundError(f"The tab's track {index} is not saved.")
    to_wav(tab_mono(f) * scale_of("tab", info), path)


def make_rec_stem(info, stem, path):
    d = stems_dir(info)
    if stem not in STEMS or d is None:
        raise FileNotFoundError("This song's video has not been split into instruments (drumclock.py does that).")
    to_wav(read_mono(d / f"{stem}.wav") * scale_of("rec", info), path)


def mixer_data(info):
    """What the page's loudness panel can offer: the tab's tracks, and the video's stems when they exist."""
    return {"tab": [{"id": i, "name": n} for i, n, _ in tab_files(info)], "rec": list(STEMS) if stems_dir(info) else []}


def audio_file(slug, which):
    """tab.wav, rec.wav, tab-<track>.wav or rec-<stem>.wav for a song, made on first ask and kept (renewed when the tab or the video changed)."""
    d = LISTEN / slug
    info = read_json(d / "info.json")
    key = info["gp_sha"] if which.startswith("tab") else video_id(info)
    out = d / "aligner"
    out.mkdir(exist_ok=True)
    wav, stamp = out / f"{which}.wav", out / f"{which}.key"
    with _lock:
        if not wav.exists() or not stamp.exists() or stamp.read_text() != str(key):
            if which == "tab":
                make_tab_wav(info, wav)
            elif which == "rec":
                make_rec_wav(info, wav)
            elif which.startswith("tab-"):
                make_tab_track(info, int(which[4:]), wav)
            else:
                make_rec_stem(info, which[4:], wav)
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
        "mixer": mixer_data(info),
        "aligned": (entry.get("autoSync") or {}).get("aligned"),
        "marks": read_json(d / "aligner" / "markers.json", {}),
    }


def save_markers(slug, marks, region):
    """The page's markers (tab time) and its @a-b region, kept beside the song so Python and Claude can read them."""
    clean = []
    for m in marks:
        t = float(m["t"])
        if not np.isfinite(t) or t < 0:
            continue
        item = {"id": int(m["id"]), "t": round(t, 3), "kind": "precise" if m.get("kind") == "precise" else "approx", "tol": float(m.get("tol", 3))}
        if m.get("label"):
            item["label"] = str(m["label"])[:20]
        if m.get("region"):
            item["region"] = True
        clean.append(item)
    reg = {"ia": int(region["ia"]), "ib": int(region["ib"])} if region else None
    out = LISTEN / slug / "aligner"
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "markers.json.tmp"
    tmp.write_text(json.dumps({"marks": clean, "region": reg, "at": datetime.datetime.now().isoformat(timespec="seconds")}, indent=1), encoding="utf-8")
    tmp.replace(out / "markers.json")
    return {"ok": True, "marks": len(clean)}


HOP5 = 110  # 5 ms at 22050 Hz, the page's note-start step
SURE = 0.25  # a match below this is shown greyed, with no Apply (the page's M key needs 0.2, and acts at once; this one asks first)
_env_cache = {}


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        raw = w.readframes(w.getnframes())
        ch = w.getnchannels()
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return x.reshape(-1, ch).mean(axis=1) if ch > 1 else x


def note_starts(slug, which):
    """The sound's note starts (a rise in the square-rooted loudness, blurred ±10 ms), 5 ms apart: what the page's M key matches too."""
    wav = audio_file(slug, which)
    key = (str(wav), wav.stat().st_mtime_ns)
    if key not in _env_cache:
        x = read_wav(wav)
        n = len(x) // HOP5
        env = np.sqrt(np.sqrt((x[: n * HOP5].reshape(n, HOP5) ** 2).mean(axis=1)))
        on = np.maximum(0.0, np.diff(env, prepend=env[0]))
        k = np.array([1, 2, 3, 2, 1], float)
        _env_cache.clear()
        _env_cache[key] = np.convolve(on, k / k.sum(), mode="same")
    return _env_cache[key]


def retry(slug, points, marks):
    """For each marker: how far the video would have to move, here, to line up with the tab best, by the note starts in a window
    around it (±3 s for an "around here" marker, ±1.5 s for an exact one). The map is the page's current one. Among peaks nearly as
    good as the best, the one nearest 0 wins (a steady beat matches at every beat). Nothing is written: the page applies what you pick."""
    info = read_json(LISTEN / slug / "info.json")
    bars_t = np.array([b[0] for b in info["bars"]], float)
    px = np.array([bars_t[int(i)] for i, _ in points], float)
    py = np.array([ms / 1000 for _, ms in points], float)
    if len(px) < 2:
        raise ValueError("The sync map needs at least two bars.")

    def video_at(t):
        y = np.interp(t, px, py)
        y = np.where(t < px[0], py[0] + (t - px[0]), y)
        return np.where(t > px[-1], py[-1] + (t - px[-1]), y)

    tab, rec = note_starts(slug, "tab"), note_starts(slug, "rec")
    step = HOP5 / RATE
    out = []
    for m in marks:
        t, approx = float(m["t"]), m.get("kind") != "precise"
        half, reach = (3.0, 1.0) if approx else (1.5, 0.5)
        ts = np.arange(max(0.0, t - half), t + half, step)
        a = np.clip((ts / step).astype(int), 0, len(tab) - 1)
        tv = tab[a]
        if len(ts) < 100 or tv.std() < 1e-6:
            out.append({"id": m["id"], "ok": False, "conf": 0.0, "later_ms": 0.0, "why": "the tab is silent or too close to an end here"})
            continue
        tv = (tv - tv.mean()) / tv.std()
        lags = np.arange(-round(reach / step), round(reach / step) + 1)
        base_i = video_at(ts) / step
        scores = np.zeros(len(lags))
        for j, l in enumerate(lags):
            r = np.interp(base_i + l, np.arange(len(rec)), rec, left=0.0, right=0.0)
            sd = r.std()
            scores[j] = float(np.mean(tv * (r - r.mean()) / sd)) if sd > 1e-9 else 0.0
        best = int(np.argmax(scores))
        top = scores[best]
        alias = False
        for j in range(1, len(scores) - 1):  # the peak nearest 0 among those nearly as good
            if scores[j] >= top * 0.85 and scores[j] >= scores[j - 1] and scores[j] >= scores[j + 1] and abs(lags[j]) < abs(lags[best]):
                best, alias = j, True
        c = float(scores[best])
        edge = best in (0, len(scores) - 1)
        d = 0.0
        if not edge:
            lo, mid, hi = scores[best - 1], scores[best], scores[best + 1]
            d = (lo - hi) / (2 * (lo - 2 * mid + hi) or 1)
        out.append({"id": m["id"], "ok": bool(c >= SURE and not edge), "conf": c, "later_ms": round(float((lags[best] + d) * step * 1000), 1), "alias": alias,
                    "why": "the best match is at the edge of what it looks at (±%.1f s): nudge closer first" % reach if edge else ("" if c >= SURE else "no clear beat here")})
    return {"results": out}


def save(slug, points, note, by="aligner", sections=None):
    d = LISTEN / slug
    fb = fretboard_of(d)
    backup = fb.with_name(fb.name + f".before-{by}")
    if not backup.exists():
        backup.write_bytes(fb.read_bytes())  # the first version stays; later saves build on each other
    doc = json.loads(fb.read_text(encoding="utf-8"))
    entry = doc["songs"][0]
    pts = [[int(p[0]), int(p[1])] for p in points]
    if not pts or any(b[1] <= a[1] for a, b in zip(pts, pts[1:])) or pts[0][1] < 0:
        raise ValueError("The bar times must start at 0 or later and keep rising.")
    entry["syncPoints"] = pts
    entry["syncDone"] = True
    # "Replace it" keeps the library song's own nudge, start section and tempo unless the file sets them,
    # and they would sit on top of these bar times (the nudge buttons in the app, the old start point).
    entry["syncOffset"] = 0
    entry["videoMaster"] = 0
    entry["videoBpm"] = 0
    auto = entry.get("autoSync") or {}
    auto["aligned"] = {"by": by, "at": datetime.datetime.now().isoformat(timespec="seconds"), "note": note}
    if sections is not None:  # the bars where the tempo changes (0-based here, 1-based in the file, as fixsync.py writes them): the gate lets those jump
        auto.setdefault("beats", {})["tempo_sections"] = [int(p) + 1 for p in sections]
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
            if len(parts) == 3 and parts[0] == "audio" and SAFE.match(parts[1]) and AUDIO.match(parts[2]):
                return self.send(audio_file(parts[1], parts[2][:-4]).read_bytes(), "audio/wav")
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
            if len(parts) == 3 and parts[:2] == ["api", "markers"] and SAFE.match(parts[2]):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                return self.js(save_markers(parts[2], body.get("marks", []), body.get("region")))
            if len(parts) == 3 and parts[:2] == ["api", "retry"] and SAFE.match(parts[2]):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                return self.js(retry(parts[2], body["points"], body.get("marks", [])))
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
