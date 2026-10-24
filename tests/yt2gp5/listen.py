"""Listen to a song's tab on top of its YouTube recording, to hear that they match all the way through.

    python tests/yt2gp5/listen.py NAME            a song from songs.json (part of its name is enough)
    python tests/yt2gp5/listen.py NAME --url URL  against another video
    python tests/yt2gp5/listen.py NAME --again    build it again (else the last build opens straight away)

Each track of the tab is played by Fretboard's synth on its own, then stretched (pitch kept) to follow the
recording's timing, as real.whole_match lined the two up. A local page plays the recording in the left ear and
the tab in the right, one track alone or all, with keys to move by 10 s, by bar and by section (chorus, verse...).

The user's checks (wrong note, timing, too quiet, too loud, OK per track and section) and answers to check.py's
guesses are saved in tests/yt2gp5/truth/<song>.json, with the time map and the sections: what Claude fixes the
tab from, and what check.py is tuned on. (Older marks in tests/yt2gp5/marks/ are carried over.)

Everything stays on this PC (tests/yt2gp5/out/listen/, not committed): the recordings are not ours to share.
"""
import base64
import functools
import http.server
import json
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check  # noqa: E402
import real  # noqa: E402
import run  # noqa: E402
import songdb  # noqa: E402

OUT = HERE / "out" / "listen"
TRUTH = HERE / "truth"  # the user's checks and answers, one file per song (no audio: these are committed)
MARKS = HERE / "marks"  # the older marks files, read when a song has no truth file yet
RATE = 44100
STEP = 0.05  # the page's time map, every 50 ms
N_FFT, HOP = 2048, 512


def render_tracks(page, gp, folder, seconds):
    """Every track of the tab alone, the whole song, as (rate, [stereo float32 arrays]) (cached)."""
    import hashlib
    data = gp.read_bytes()
    sub = folder / f"gp-{hashlib.sha1(data).hexdigest()[:12]}" / "tracks"
    meta_file = sub / "meta.json"
    if not meta_file.exists():
        meta = page.evaluate("([b, o]) => renderSong(b, o)", [base64.b64encode(data).decode(),
                             {"start": 0, "seconds": seconds, "saveTo": f"real/{folder.name}/{sub.parent.name}/tracks"}])
        meta_file.write_text(json.dumps({k: meta[k] for k in ("rate", "tracks", "songEnd")}), encoding="utf-8")
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    return meta, [sub / f"track{t['index']}.f32" for t in meta["tracks"]]


def warp(y, tab_at):
    """y (mono, at RATE) played on a new timeline: output frame k sounds like y at tab time tab_at[k] (seconds).
    A phase vocoder whose rate changes from frame to frame, so the pitch stays put (librosa's, generalised)."""
    import librosa
    S = librosa.stft(y, n_fft=N_FFT, hop_length=HOP)
    steps = np.clip(tab_at * RATE / HOP, 0, S.shape[1] - 2)
    adv = np.linspace(0, np.pi * HOP, S.shape[0])
    S = np.pad(S, [(0, 0), (0, 2)])
    i = steps.astype(int)
    f = (steps - i).astype(np.float32)
    mag, ang = np.abs(S), np.angle(S)
    a, b = i, i + 1
    dp = ang[:, b] - ang[:, a] - adv[:, None]
    dp = adv[:, None] + dp - 2 * np.pi * np.round(dp / (2 * np.pi))
    # each frame's phase: the first one's plus every step's advance before it
    phase = ang[:, :1] + np.concatenate([np.zeros((len(adv), 1)), np.cumsum(dp[:, :-1], axis=1)], axis=1)
    out = ((1 - f) * mag[:, a] + f * mag[:, b]) * np.exp(1j * phase)
    return librosa.istft(out.astype(np.complex64), hop_length=HOP, n_fft=N_FFT)


def fine_tune(tab, rec, tab_at, win=6.0, every=2.0, most=0.3):
    """The chord line-up is right to a few tenths of a second. Here the note starts of the stretched tab (`tab`)
    and the recording are matched every `every` s (over `win` s, up to `most` s apart; a small shift is
    preferred, so a beat early or late doesn't win), and tab_at is corrected by what they say."""
    import librosa
    from scipy.ndimage import median_filter
    hop = RATE // 100  # 10 ms
    o_rec = librosa.onset.onset_strength(y=rec, sr=RATE, hop_length=hop)
    o_tab = librosa.onset.onset_strength(y=tab, sr=RATE, hop_length=hop)
    n, w, k = min(len(o_rec), len(o_tab)), int(win * 100), int(most * 100)
    ks = np.arange(-k, k + 1)
    prior = np.exp(-0.5 * (ks / 15.0) ** 2)  # 150 ms
    at, lag = [], []
    for s in range(0, n - w, int(every * 100)):
        a = o_rec[s:s + w] - o_rec[s:s + w].mean()
        b = o_tab[s:s + w] - o_tab[s:s + w].mean()
        if np.linalg.norm(a) < 1e-6 or np.linalg.norm(b) < 1e-6:
            continue
        c = np.array([np.dot(a[k:-k], np.roll(b, j)[k:-k]) for j in ks]) / (np.linalg.norm(a) * np.linalg.norm(b))
        if c.max() < 0.2:
            continue  # nothing clear to go by (a pad, silence)
        at.append((s + w / 2) / 100)
        lag.append(ks[np.argmax(c * prior)] / 100)  # > 0: the tab comes early by this much
    if len(lag) < 3:
        return tab_at
    lag = median_filter(np.array(lag), size=5, mode="nearest")
    frames = np.arange(len(tab_at)) * HOP / RATE
    shift = np.interp(frames, at, lag)
    return np.interp(frames - shift, frames, tab_at)


def encode(y, path, stereo=False):
    """float audio → .m4a (AAC 192 kb/s) with ffmpeg."""
    raw = np.ascontiguousarray(y, dtype=np.float32)
    subprocess.run([real.ffmpeg(), "-v", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", "2" if stereo else "1",
                    "-i", "-", "-c:a", "aac", "-b:a", "192k", str(path)], input=raw.tobytes(), check=True)


def build(song, url):
    import soundfile as sf
    from playwright.sync_api import sync_playwright
    folder = real.CACHE / run.slug(song["name"])
    folder.mkdir(parents=True, exist_ok=True)
    out = OUT / run.slug(song["name"])
    out.mkdir(parents=True, exist_ok=True)
    srv = run.serve()
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page()
        pg.set_default_timeout(1_800_000)
        pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/tests/yt2gp5/render.html")
        pg.wait_for_function("window.renderReady === true")
        print("playing the tab...")
        meta_whole, gp_wav = real.render_whole(pg, Path(song["gp"]), folder)
        meta, files = render_tracks(pg, Path(song["gp"]), folder, int(np.ceil(meta_whole["songEnd"])) + 2)
        gp_bytes = Path(song["gp"]).read_bytes()
        notes = pg.evaluate("b => songNotes(b)", base64.b64encode(gp_bytes).decode())
        b.close()
    srv.shutdown()
    print("downloading the recording...")
    rec_wav = real.download(url, folder)
    print("lining them up...")
    m = real.whole_match(gp_wav, rec_wav)
    rec, sr = sf.read(str(rec_wav), dtype="float32", always_2d=True)
    assert sr == RATE
    encode(rec, out / "recording.m4a", stereo=True)
    # the recording's time → the tab's time, for every output frame (beyond the line-up, one to one)
    mp = np.array(m["map"])
    rec_t, tab_t = mp[:, 1], mp[:, 0]
    keep = np.concatenate([[True], np.diff(rec_t) > 1e-3])
    rec_t, tab_t = rec_t[keep], tab_t[keep]
    frames = np.arange(int(len(rec) / HOP) + 1) * HOP / RATE
    tab_at = np.interp(frames, rec_t, tab_t)
    tab_at = np.where(frames < rec_t[0], tab_t[0] - (rec_t[0] - frames), tab_at)
    tab_at = np.where(frames > rec_t[-1], tab_t[-1] + (frames - rec_t[-1]), tab_at)
    # one loudness for all tracks: the whole tab peaks at 0.9, as the mix does in real.render_whole
    mixed = None
    for f in files:
        y = np.fromfile(f, dtype=np.float32).reshape(-1, 2).mean(axis=1)
        mixed = y if mixed is None else mixed[:len(y)] + y[:len(mixed)]
    gain = 0.9 / max(1e-6, float(np.abs(mixed).max()))
    print("lining up the note starts...")
    tab_at = fine_tune(warp(mixed * gain, tab_at)[:len(rec)], rec.mean(axis=1), tab_at)
    del mixed
    import librosa
    tracks, mix, onsets = [], np.zeros(len(rec), dtype=np.float32), {}
    for t, f in zip(meta["tracks"], files):
        y = np.fromfile(f, dtype=np.float32).reshape(-1, 2).mean(axis=1) * gain
        if np.abs(y).max() < 1e-4:
            continue  # a silent track (nothing written for it)
        if m["shift"]:
            import librosa
            y = librosa.effects.pitch_shift(y, sr=RATE, n_steps=m["shift"])
        print(f"  {t['name']} ({t['category']})")
        y = warp(y, tab_at)[:len(rec)]
        mix[:len(y)] += y
        onsets[t["index"]] = librosa.onset.onset_strength(y=y, sr=RATE, hop_length=RATE // 100)
        name = f"track{t['index']}.m4a"
        encode(y, out / name)
        tracks.append({"file": name, "index": t["index"], "name": t["name"], "category": t["category"]})
    (out / "notes.json").write_text(json.dumps(notes), encoding="utf-8")  # the tab's notes and bars, as played
    print("checking for wrong notes and timing...")
    frames = np.arange(len(tab_at)) * HOP / RATE
    rising = np.maximum.accumulate(tab_at)
    rec_of = lambda t: np.interp(t, rising, frames)
    sus = check.suspects(rec.mean(axis=1), mix, onsets, notes, rec_of, m["shift"])
    del mix
    print(f"  {len(sus)} spots to listen to")
    # the recording's time → the tab's, every STEP s, for the page (bar numbers, marks)
    tab_every = np.interp(np.arange(0, len(rec) / RATE, STEP), frames, tab_at)
    off_t = mp[0, 0]  # the parts count from the tab's first sound; the map from the start of each file
    on_rec = lambda t: round(float(np.interp(t + off_t, mp[:, 0], mp[:, 1])), 2)
    parts = [{"tab": [p["tab"][0] + off_t, p["tab"][1] + off_t], "rec": [on_rec(p["tab"][0]), on_rec(p["tab"][1])],
              "dist": p["dist"], "why": p["why"]} for p in m["parts"]]
    import hashlib
    keep_tracks = {t["index"] for t in tracks}
    info = {"name": song["name"], "slug": run.slug(song["name"]), "gp": Path(song["gp"]).name,
            "gp_sha": hashlib.sha1(gp_bytes).hexdigest()[:12], "step": STEP,
            "tabAt": [round(float(v), 3) for v in tab_every],
            "bars": [[round(b["time"], 3), b["index"] + 1, b["num"], b.get("section")] for b in notes["bars"]],
            "notes": [[x["track"], round(x["start"], 3), x["pitch"] + m["shift"]] for x in notes["notes"] if x["track"] in keep_tracks],
            "suspects": sus, "url": url, "ok": m["ok"], "shift": m["shift"], "head_s": m["head_s"],
            "tail_s": m["tail_s"], "dist": m["dist"], "worst": m["worst"], "tracks": tracks, "parts": parts}
    (out / "info.json").write_text(json.dumps(info), encoding="utf-8")
    print(f"{'matches all the way through' if m['ok'] else 'does NOT match all the way through'}: {songdb.why(m)}")
    return out


class Ranged(http.server.SimpleHTTPRequestHandler):
    """Serves byte ranges, so the page can jump around in the audio, and keeps the user's marks
    (GET /marks.json, POST /marks) in `marks_file` (read from `old_file` until it exists)."""
    marks_file = old_file = None

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.split("?")[0] != "/marks.json":
            return super().do_GET()
        f = self.marks_file if self.marks_file.exists() else self.old_file
        body = f.read_bytes() if f and f.exists() else b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/marks":
            return self.send_error(404)
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        self.marks_file.parent.mkdir(parents=True, exist_ok=True)
        self.marks_file.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
        self.send_response(204)
        self.end_headers()

    def send_head(self):
        rng = self.headers.get("Range")
        path = Path(self.translate_path(self.path))
        if not rng or not path.is_file():
            return super().send_head()
        size = path.stat().st_size
        a, _, b = rng.removeprefix("bytes=").partition("-")
        a, b = int(a or 0), min(int(b) if b else size - 1, size - 1)
        f = path.open("rb")
        f.seek(a)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        self.send_header("Content-Length", str(b - a + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._left = b - a + 1
        return f

    def copyfile(self, src, dst):
        left = getattr(self, "_left", None)
        if left is None:
            return super().copyfile(src, dst)
        while left > 0:
            chunk = src.read(min(65536, left))
            if not chunk:
                break
            dst.write(chunk)
            left -= len(chunk)


def youtube_id(url):
    import re
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", url or "")
    return m.group(1) if m else None


def fretboard_file(song, info, out):
    """The song for Fretboard (a .fretboard file): the tab, its YouTube video, and where every bar starts in
    that video (the line-up), so Fretboard plays the tab in step with the video straight away."""
    import datetime
    A, step = np.array(info["tabAt"]), info["step"]
    rec_s = np.arange(len(A)) * step
    keep = np.r_[True, np.diff(A) > 0]  # tab time only moves on: np.interp needs it rising
    points, last = [], -1
    for p, b in enumerate(info["bars"]):
        ms = int(round(float(np.interp(b[0], A[keep], rec_s[keep])) * 1000))
        if ms > last:  # bars before the video begins all sit at 0: keep the first
            points.append([p, max(0, ms)])
            last = max(0, ms)
    vid = youtube_id(info["url"])
    video = song.get("video") or {}
    gp = Path(song["gp"])
    title = song.get("title") or song["name"].removesuffix(" (official)")
    entry = {
        "kind": "gp", "title": title, "artist": song.get("artist", ""), "fileName": gp.name,
        "data": {"$bytes": base64.b64encode(gp.read_bytes()).decode()},
        "recording": {"kind": "youtube", "id": vid, "title": video.get("title", ""), "author": video.get("channel", "")},
        "syncPoints": points, "syncDone": True,
        "autoSync": {"from": "yt2gp5", "gp_sha": info["gp_sha"], "chords": info.get("dist"), "made": datetime.date.today().isoformat()},
        "version": {"type": "official"},
        **({"sourceUrl": song["ug"]} if song.get("ug") else {}),
    }
    path = out / f"{run.slug(title)}.fretboard"
    path.write_text(json.dumps({"format": "fretboard-songs", "version": 1, "created": datetime.datetime.now().isoformat(),
                                "songs": [entry]}), encoding="utf-8")
    return path


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
    song = songdb.find_one(songdb.load(), a[0])
    url = a[a.index("--url") + 1] if "--url" in a else song.get("youtube")
    if not url or not song.get("gp"):
        sys.exit("that song needs a tab and a video (songdb.py find / set)")
    out = OUT / run.slug(song["name"])
    info = out / "info.json"
    old = json.loads(info.read_text(encoding="utf-8")) if info.exists() else {}
    import hashlib
    sha = hashlib.sha1(Path(song["gp"]).read_bytes()).hexdigest()[:12]
    if "--again" in a or old.get("url") != url or old.get("gp_sha") != sha:
        build(song, url)  # else the last build is still right: just open it
    else:
        print("(the same tab and video as last time: opening that; --again rebuilds it)")
    fb = fretboard_file(song, json.loads(info.read_text(encoding="utf-8")), out)
    print(f"for Fretboard (the tab, the video and where each bar is): {fb}")
    if "--export" in a:
        return
    (out / "index.html").write_text(PAGE.replace("/*INFO*/null", info.read_text(encoding="utf-8")), encoding="utf-8")
    Ranged.marks_file = TRUTH / f"{run.slug(song['name'])}.json"
    Ranged.old_file = MARKS / f"{run.slug(song['name'])}.json"
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Ranged, directory=str(out)))
    link = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    print(f"listen at {link} (Ctrl+C to stop)")
    print(f"your checks are saved in {Ranged.marks_file}")
    webbrowser.open(link)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Listen along</title>
<style>
:root { --bg:#fafaf8; --fg:#1d1d1b; --mute:#6b6b66; --line:#deded8; --soft:#f0f0ec; --bad:#c62828; --ok:#2e7d32; --acc:#1565c0; --warn:#b26a00; --quiet:#6a1b9a;
  --heard:#c8d6c4; --unheard:#e4e4de; --okc:#66bb6a; --badc:#e57373; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ececea; --mute:#9a9a94; --line:#33332f; --soft:#22221f; --bad:#ef5350; --ok:#66bb6a; --acc:#64b5f6; --warn:#ffb74d; --quiet:#ce93d8;
  --heard:#3a4a38; --unheard:#2a2a27; --okc:#2e7d32; --badc:#b71c1c; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.4 system-ui, sans-serif; }
main { max-width:1100px; margin:0 auto; padding:0 16px 40px; }
h1 { font-size:19px; margin:12px 0 2px; }
h2 { font-size:16px; margin:22px 0 6px; }
.mute { color:var(--mute); }
.verdict { font-weight:600; } .verdict.ok { color:var(--ok); } .verdict.no { color:var(--bad); }
kbd { border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 5px; font:12px ui-monospace, monospace; background:var(--bg); white-space:nowrap; }
button, select, input[type=text] { font:inherit; padding:4px 10px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg); }
button { cursor:pointer; } button.on { background:var(--acc); color:var(--bg); border-color:var(--acc); }
.top { position:sticky; top:0; background:var(--bg); z-index:5; border-bottom:1px solid var(--line); padding-bottom:6px; }
.transport { display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:8px 0 6px; }
.big { font-size:20px; font-weight:700; }
#where { font-variant-numeric:tabular-nums; }
#section { color:var(--acc); font-weight:600; }
.levels { display:flex; gap:18px; flex-wrap:wrap; align-items:center; font-size:14px; }
.levels label { display:flex; gap:6px; align-items:center; }
.levels input { width:130px; }
.db { font-variant-numeric:tabular-nums; min-width:52px; display:inline-block; }
#solo-name { color:var(--acc); }
/* timeline */
#tl { position:relative; margin-top:6px; cursor:pointer; user-select:none; }
#tl .strip { position:relative; height:18px; }
#tl .sec { position:absolute; top:0; height:18px; font-size:11px; line-height:18px; padding-left:3px; overflow:hidden; white-space:nowrap; border-left:1px solid var(--bg); color:#fff; }
#tl .lane { position:relative; height:12px; margin-top:2px; }
#tl .lane.solo { height:18px; outline:2px solid var(--acc); outline-offset:-2px; }
#tl .lane .name { position:absolute; left:4px; top:0; font-size:10px; line-height:12px; color:var(--fg); opacity:.6; pointer-events:none; }
#tl .lane.solo .name { opacity:.9; left:4px; top:1px; font-size:11px; font-weight:600; }
#tl .cov { position:absolute; top:0; bottom:0; }
#tl .tick { position:absolute; top:0; bottom:0; width:3px; margin-left:-1px; }
#tl .tick.sug { background:var(--warn); } #tl .tick.sug.chords { background:var(--bad); } #tl .tick.sug.timing { background:var(--acc); }
#tl .tick.sug.done { opacity:.25; }
#tl .tick.v { background:var(--fg); width:4px; }
#tl .head { position:absolute; top:0; bottom:0; width:2px; background:var(--fg); pointer-events:none; }
#card { position:relative; min-height:44px; margin-top:6px; }
#card .c { position:absolute; max-width:460px; background:var(--soft); border:2px solid var(--warn); border-radius:8px; padding:6px 10px; font-size:14px; }
#card .c.chords { border-color:var(--bad); } #card .c.timing { border-color:var(--acc); }
#card .c b { display:block; }
#card .c .keys { color:var(--mute); font-size:12px; margin-top:2px; }
#toast { position:fixed; left:50%; top:12px; transform:translateX(-50%); background:var(--fg); color:var(--bg); padding:6px 14px; border-radius:20px; font-weight:600; opacity:0; transition:opacity .2s; z-index:9; pointer-events:none; }
#toast.show { opacity:1; }
details.guide { background:var(--soft); border-radius:8px; padding:8px 12px; margin:10px 0; }
details.guide summary { cursor:pointer; font-weight:600; }
.keys2 { display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:2px 18px; font-size:14px; margin-top:8px; }
/* tracks */
.trk { display:flex; gap:10px; align-items:center; padding:4px 6px; border-bottom:1px solid var(--line); cursor:pointer; }
.trk.solo { background:var(--soft); outline:2px solid var(--acc); outline-offset:-2px; }
.trk .n { flex:1; } .trk input { width:120px; }
.cat { color:var(--mute); font-size:13px; }
/* coverage grid */
table.grid { border-collapse:collapse; font-size:12px; }
table.grid th, table.grid td { border:1px solid var(--bg); padding:2px 5px; text-align:center; white-space:nowrap; }
table.grid th.r { text-align:left; }
table.grid td { cursor:pointer; min-width:26px; }
.c-unheard { background:var(--unheard); } .c-heard { background:var(--heard); } .c-ok { background:var(--okc); color:#fff; } .c-issue { background:var(--badc); color:#fff; }
.item { border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin:5px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:14px; }
.item input[type=text] { flex:1; min-width:160px; }
#saved { font-size:13px; color:var(--mute); } #saved.err { color:var(--bad); font-weight:600; }
</style></head><body><main>
<h1 id="title"></h1><div class="mute" id="sub"></div>

<div class="top">
  <div class="transport">
    <button id="play">Play</button>
    <span id="where" class="big">0:00</span>
    <span id="section"></span>
    <span>Right ear: <b id="solo-name" class="big">all tracks</b></span>
    <span id="loopinfo" class="mute"></span>
    <span id="saved"></span>
  </div>
  <div class="levels">
    <label>Recording (left) <input id="rec-db" type="range" min="-24" max="12" step="1" value="0"><span class="db" id="rec-dbv"></span></label>
    <label>Tab (right) <input id="tab-db" type="range" min="-24" max="12" step="1" value="0"><span class="db" id="tab-dbv"></span></label>
    <label>Speed <select id="speed"><option value="1">100%</option><option value="0.85">85%</option><option value="0.7">70%</option><option value="0.5">50%</option></select></label>
    <span class="mute">Press <kbd>?</kbd> for all keys</span>
  </div>
  <div id="tl"></div>
  <div id="card"></div>
</div>
<div id="toast"></div>

<details class="guide" id="guide" open><summary>How to check this song</summary>
<ol>
<li>Use headphones. The <b>YouTube recording is always in your left ear, your tab in your right.</b> Set their levels with <kbd>↑</kbd><kbd>↓</kbd> (tab) and <kbd>Shift</kbd>+<kbd>↑</kbd><kbd>↓</kbd> (recording).</li>
<li>Press <kbd>S</kbd> to put <b>one track</b> in your right ear (press again for the next one, <kbd>A</kbd> for all). Listen to it against the recording through the song.</li>
<li>When that track sounds off, press a key straight away. It goes on that track, about ⅓ s back:
 <kbd>W</kbd> wrong note · <kbd>T</kbd> bad timing · <kbd>Q</kbd> can't hear it / too quiet · <kbd>L</kbd> too loud · <kbd>M</kbd> something else. Press it again to stretch it over more bars. <kbd>Z</kbd> undoes.</li>
<li>When a track sounds right through a whole section, press <kbd>K</kbd> (OK). The grid below fills in green, so you can see what's left to check.</li>
<li>The computer's guesses pop up under the timeline, at their time and on their track. <kbd>Enter</kbd> = yes, it's wrong. <kbd>X</kbd> = ignore it (it's fine). Or press the key of what's really wrong (<kbd>W</kbd> <kbd>T</kbd> <kbd>Q</kbd> <kbd>L</kbd>). <kbd>.</kbd> jumps to the next guess.</li>
<li>Move around: <kbd>1</kbd>–<kbd>9</kbd> jump through the song (<kbd>0</kbd> = start), <kbd>←</kbd><kbd>→</kbd> 10 s, <kbd>C</kbd> chorus, <kbd>V</kbd> verse, <kbd>B</kbd> bridge, <kbd>P</kbd> pre-chorus, <kbd>I</kbd> intro, <kbd>O</kbd> outro, <kbd>N</kbd> next section. Hold <kbd>Shift</kbd> to go back.</li>
<li>Everything saves by itself. When you're done, tell Claude: <b>"look at my checks for <span id="g-name"></span>"</b>.</li>
</ol>
<div class="keys2" id="keys"></div>
</details>

<h2>What's checked <span class="mute" id="cov-sum"></span></h2>
<div class="mute" style="font-size:13px;margin-bottom:4px">Each square is one track in one section: grey not heard alone yet, light green heard alone, green OK (<kbd>K</kbd>), red has a problem. Click a square to go there with that track in your right ear.</div>
<div style="overflow-x:auto"><table class="grid" id="grid"></table></div>

<h2>Tracks</h2><div id="tracks"></div>

<details><summary><b>Your checks</b> <span class="mute" id="v-count"></span></summary><div id="verdicts"></div></details>
<details><summary><b>The computer's guesses</b> <span class="mute" id="s-count"></span></summary><div id="sus"></div></details>
</main><script>
const INFO = /*INFO*/null;
const $ = (id) => document.getElementById(id);
const make = (tag, props = {}, kids = []) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const NOTE = 'C C# D D# E F F# G G# A A# B'.split(' ');
const pname = (p) => NOTE[p % 12] + (Math.floor(p / 12) - 1);
const dbg = (db) => Math.pow(10, db / 20);
const KIND = { wrong_note: 'Wrong note', timing: 'Bad timing', too_quiet: "Can't hear / too quiet", too_loud: 'Too loud', ok: 'OK', other: 'Something else' };
const KEYKIND = { KeyW: 'wrong_note', KeyT: 'timing', KeyQ: 'too_quiet', KeyL: 'too_loud' };
const SUGKIND = { notes: 'wrong_note', chords: 'wrong_note', timing: 'timing' };
$('title').textContent = INFO.name; $('g-name').textContent = INFO.name;
$('sub').append(make('span', { className: 'verdict ' + (INFO.ok ? 'ok' : 'no'), textContent: INFO.ok ? 'Lines up all the way through' : 'Does not line up all the way through' }),
  ` · ${INFO.head_s > 1 ? INFO.head_s + ' s extra at the start · ' : ''}${INFO.tail_s > 1 ? INFO.tail_s + ' s extra at the end · ' : ''}${INFO.shift ? 'tab moved ' + INFO.shift + ' semitones · ' : ''}`,
  make('a', { href: INFO.url, target: '_blank', rel: 'noopener', textContent: 'video' }));
try { if (localStorage.getItem('guide-closed2')) $('guide').open = false; } catch {}
$('guide').ontoggle = () => { try { $('guide').open ? localStorage.removeItem('guide-closed2') : localStorage.setItem('guide-closed2', '1'); } catch {} };
const KEYLIST = [['Space', 'play / pause'], ['1 … 9, 0', 'jump to 10% … 90%, start'], ['← →', '10 s back / ahead'], ['Shift ← →', 'one bar back / ahead'],
  ['C V B P I O', 'chorus, verse, bridge, pre-chorus, intro, outro (Shift: back)'], ['N', 'next section (Shift: back)'], ['S', 'next track in your right ear (Shift: back)'], ['A', 'all tracks in your right ear'],
  ['↑ ↓', 'tab louder / quieter'], ['Shift ↑ ↓', 'recording louder / quieter'], ['W', 'wrong note'], ['T', 'bad timing'], ['Q', "can't hear it / too quiet"], ['L', 'too loud'],
  ['K', 'this track is OK in this section'], ['M', 'something else (type a note)'], ['Enter', 'yes to the guess shown'], ['X', 'ignore the guess shown'], ['. ,', 'next / previous guess'],
  ['R', 'loop 4 s around here (again: off)'], ['F', 'slower (100 → 85 → 70 → 50%)'], ['Z', 'undo']];
$('keys').append(...KEYLIST.map(([k, d]) => make('div', {}, [make('kbd', { textContent: k }), ' ' + d])));

// ---- time: recording seconds ↔ tab seconds, bars and sections ----
const A = INFO.tabAt, STEP = INFO.step;
function tabAt(r) {
  const i = r / STEP, k = Math.floor(i);
  if (k < 0) return A[0] + r;
  if (k >= A.length - 1) return A[A.length - 1] + (r - (A.length - 1) * STEP);
  return A[k] + (A[k + 1] - A[k]) * (i - k);
}
function recOf(t) {
  let lo = 0, hi = A.length - 1;
  if (t <= A[0]) return t - A[0];
  if (t >= A[hi]) return hi * STEP + (t - A[hi]);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m] < t) lo = m; else hi = m; }
  return (lo + (t - A[lo]) / Math.max(1e-6, A[hi] - A[lo])) * STEP;
}
const B = INFO.bars; // [tab time, bar number, beats, section]
const occ = []; { const seen = {}; for (const b of B) { seen[b[1]] = (seen[b[1]] || 0) + 1; occ.push(seen[b[1]]); } }
function barIndex(tab) {
  if (!B.length || tab < B[0][0]) return -1;
  let lo = 0, hi = B.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (B[m][0] <= tab) lo = m; else hi = m - 1; }
  return lo;
}
function barAt(tab) {
  const i = barIndex(tab);
  if (i < 0) return null;
  const end = i + 1 < B.length ? B[i + 1][0] : B[i][0] + 2;
  return { i, bar: B[i][1], play: occ[i], beat: Math.min(B[i][2], 1 + Math.floor(((tab - B[i][0]) / Math.max(0.01, end - B[i][0])) * B[i][2])) };
}
function secKind(name) {
  const n = (name || '').toLowerCase();
  if (/pre.?chorus/.test(n)) return 'P';
  if (/post.?chorus/.test(n)) return null;
  if (/chorus|refrain/.test(n)) return 'C';
  if (/verse/.test(n)) return 'V';
  if (/bridge/.test(n)) return 'B';
  if (/intro/.test(n)) return 'I';
  if (/outro|ending|coda|tag/.test(n)) return 'O';
  return null;
}
const SEC_COL = { C: '#c62828', V: '#1565c0', B: '#6a1b9a', P: '#ef6c00', I: '#00838f', O: '#4e342e' };
const sections = [];
B.forEach((b, i) => {
  if (b[3] || i === 0) sections.push({ name: b[3] || 'Start', kind: secKind(b[3]), i0: i, tab0: b[0] });
});
sections.forEach((s, k) => {
  const nx = sections[k + 1];
  s.i1 = nx ? nx.i0 - 1 : B.length - 1;
  s.tab1 = nx ? nx.tab0 : B[B.length - 1][0] + 2;
  s.rec0 = Math.max(0, recOf(s.tab0)); s.rec1 = recOf(s.tab1);
  s.bars = [B[s.i0][1], B[s.i1][1]];
});
const secAt = (r) => { let s = null; for (const x of sections) if (x.rec0 <= r + 0.01) s = x; return s; };

// per-track note times (tab s), to skip tracks that are silent here
const noteTimes = {};
for (const [t, s] of INFO.notes) (noteTimes[t] = noteTimes[t] || []).push(s);
Object.values(noteTimes).forEach((a) => a.sort((x, y) => x - y));
function playsNear(track, tab, w = 4) {
  const a = noteTimes[track] || [];
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < tab - w) lo = m + 1; else hi = m; }
  return lo < a.length && a[lo] <= tab + w;
}
const notesNear = (track, tab, w = 0.3) => INFO.notes.filter((n) => n[0] === track && Math.abs(n[1] - tab) <= w).map((n) => pname(n[2]));

// ---- audio: recording in the left ear, the tab in the right ----
const ctx = new AudioContext();
const recGain = ctx.createGain(), tabGain = ctx.createGain();
const panL = new StereoPannerNode(ctx, { pan: -1 }), panR = new StereoPannerNode(ctx, { pan: 1 });
recGain.connect(panL).connect(ctx.destination); tabGain.connect(panR).connect(ctx.destination);
function source(file, to) {
  const el = new Audio(file); el.preload = 'auto'; el.preservesPitch = true;
  const g = ctx.createGain(); ctx.createMediaElementSource(el).connect(g).connect(to);
  return { el, g };
}
const rec = source('recording.m4a', recGain);
const tracks = INFO.tracks.map((t) => ({ ...source(t.file, tabGain), info: t, db: 0 }));
const all = [rec, ...tracks];

// ---- state (saved to truth/<song>.json) ----
let state = { name: INFO.name, gp: INFO.gp, gp_sha: INFO.gp_sha, url: INFO.url, verdicts: [], answers: {}, heard: {}, levels: { rec: 0, tab: 0, tracks: {} } };
let solo = null, speed = 1, loop = null, undo = [];
const soloTrack = () => (solo == null ? null : tracks[solo]);
function apply() {
  recGain.gain.value = dbg(state.levels.rec); tabGain.gain.value = dbg(state.levels.tab);
  tracks.forEach((x, i) => { x.g.gain.value = (solo == null || solo === i) ? dbg(state.levels.tracks[x.info.index] || 0) : 0; });
  $('rec-db').value = state.levels.rec; $('tab-db').value = state.levels.tab;
  $('rec-dbv').textContent = (state.levels.rec > 0 ? '+' : '') + state.levels.rec + ' dB';
  $('tab-dbv').textContent = (state.levels.tab > 0 ? '+' : '') + state.levels.tab + ' dB';
  $('solo-name').textContent = solo == null ? 'all tracks' : tracks[solo].info.name;
  document.querySelectorAll('.trk').forEach((e, i) => e.classList.toggle('solo', i === solo));
}
$('rec-db').oninput = (e) => { state.levels.rec = +e.target.value; apply(); save(); };
$('tab-db').oninput = (e) => { state.levels.tab = +e.target.value; apply(); save(); };
$('speed').onchange = (e) => setSpeed(+e.target.value);
function setSpeed(v) { speed = v; $('speed').value = String(v); all.forEach((x) => { x.el.playbackRate = v; }); }
function setSolo(i) { solo = i; apply(); drawTimeline(); drawCard(); }

for (const [i, x] of tracks.entries()) {
  const vol = make('input', { type: 'range', min: -24, max: 12, step: 1, value: 0, title: 'this track only (dB)' });
  const dv = make('span', { className: 'db', textContent: '0 dB' });
  vol.onclick = (e) => e.stopPropagation();
  vol.oninput = () => { state.levels.tracks[x.info.index] = +vol.value; dv.textContent = vol.value + ' dB'; apply(); save(); };
  x.vol = vol; x.dv = dv;
  const row = make('div', { className: 'trk' }, [make('span', { className: 'n' }, [x.info.name + ' ', make('span', { className: 'cat', textContent: x.info.category })]), vol, dv]);
  row.title = 'click: this track alone in your right ear';
  row.onclick = () => setSolo(solo === i ? null : i);
  $('tracks').append(row);
}

// ---- playing ----
rec.el.addEventListener('loadedmetadata', () => { drawTimeline(); });
const dur = () => rec.el.duration || A.length * STEP;
function seek(t) {
  t = Math.max(0, Math.min(t, dur() - 0.05));
  rec.el.currentTime = t;
  for (const x of tracks) x.el.currentTime = Math.max(0, t);
  tick();
}
async function play() { await ctx.resume(); seek(rec.el.currentTime); await Promise.all(all.map((x) => x.el.play())); $('play').textContent = 'Pause'; }
function pause() { all.forEach((x) => x.el.pause()); $('play').textContent = 'Play'; }
$('play').onclick = () => (rec.el.paused ? play() : pause());
rec.el.addEventListener('ended', pause);
function setLoop(a, b) {
  loop = a == null ? null : { a: Math.max(0, a), b };
  $('loopinfo').textContent = loop ? `looping ${fmt(loop.a)}–${fmt(loop.b)} (R: off)` : '';
}
let lastT = null;
function tick() {
  const t = rec.el.currentTime, tab = tabAt(t), b = barAt(tab), s = secAt(t);
  $('where').textContent = fmt(t) + (b ? ` · bar ${b.bar}, beat ${b.beat}` : '');
  $('section').textContent = s ? s.name : '';
  const h = document.querySelector('#tl .head');
  if (h) h.style.left = (100 * t / dur()) + '%';
  drawCard();
}
setInterval(() => {
  const t = rec.el.currentTime;
  tick();
  if (rec.el.paused) { lastT = null; return; }
  // listening time, per track alone and section, for the grid
  if (lastT != null && solo != null && t > lastT && t - lastT < 1) {
    const s = secAt(t);
    if (s) { const key = tracks[solo].info.index + ':' + sections.indexOf(s); state.heard[key] = (state.heard[key] || 0) + (t - lastT); }
  }
  lastT = t;
  if (loop && t >= loop.b) { seek(loop.a); return; }
  for (const x of tracks) {
    const d = x.el.currentTime - t;
    if (Math.abs(d) > 0.15) { x.el.currentTime = t; x.el.playbackRate = speed; }
    else x.el.playbackRate = speed * (Math.abs(d) > 0.01 ? 1 - Math.max(-0.05, Math.min(0.05, d)) : 1);
  }
}, 100);
setInterval(() => { if (!rec.el.paused) { drawGrid(); save(); } }, 3000);

// ---- saving ----
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const body = { ...state, match: { shift: INFO.shift, head_s: INFO.head_s, tail_s: INFO.tail_s, dist: INFO.dist },
      tracks: INFO.tracks.map((t) => ({ index: t.index, name: t.name, category: t.category })),
      sections: sections.map((s) => ({ name: s.name, kind: s.kind, bars: s.bars, rec: [+s.rec0.toFixed(2), +s.rec1.toFixed(2)] })),
      cells: cells(), align: { step: STEP, tab: A } };
    try {
      const r = await fetch('marks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.status);
      $('saved').className = ''; $('saved').textContent = 'saved';
    } catch { $('saved').className = 'err'; $('saved').textContent = 'NOT saved: is listen.py still running?'; }
  }, 400);
}
let toastTimer;
function toast(s) { const e = $('toast'); e.textContent = s; e.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove('show'), 1600); }

// ---- checks (verdicts) ----
let lastKey = null;
function verdict(kind, note = '') {
  const playing = !rec.el.paused;
  const r = Math.max(0, rec.el.currentTime - (playing ? 0.35 * speed : 0));
  const tab = tabAt(r), b = barAt(tab), s = secAt(r);
  const x = soloTrack(), track = x ? x.info.index : null;
  const now = performance.now();
  if (kind !== 'ok' && kind !== 'other' && lastKey && lastKey.kind === kind && lastKey.track === track && now - lastKey.at < 2500) {
    const v = lastKey.v; // the same key again: stretch it to this bar
    if (b) v.bars[1] = Math.max(v.bars[1], b.bar);
    v.rec[1] = +r.toFixed(2); lastKey.at = now;
    toast(`${KIND[kind]} · ${x ? x.info.name : 'whole tab'} · bars ${v.bars[0]}–${v.bars[1]}`);
  } else {
    let v;
    if (kind === 'ok') {
      if (!s) return;
      v = { id: Date.now(), track, kind, bars: s.bars.slice(), rec: [+s.rec0.toFixed(2), +s.rec1.toFixed(2)], section: s.name, section_i: sections.indexOf(s) };
    } else {
      v = { id: Date.now(), track, kind, bars: b ? [b.bar, b.bar] : [null, null], play: b?.play ?? null, beat: b?.beat ?? null,
        rec: [+r.toFixed(2), +r.toFixed(2)], tab: +tab.toFixed(3), section: s?.name ?? null, section_i: s ? sections.indexOf(s) : null,
        notes: track != null ? notesNear(track, tab) : [], note };
    }
    v.levels = { rec: state.levels.rec, tab: state.levels.tab, track: track != null ? (state.levels.tracks[track] || 0) : null };
    v.gp_sha = INFO.gp_sha;
    state.verdicts.push(v); undo.push({ type: 'verdict', v });
    lastKey = { kind, track, at: now, v };
    toast(`${KIND[kind]} · ${x ? x.info.name : 'whole tab'}${kind === 'ok' ? ' · ' + s.name : b ? ' · bar ' + b.bar : ''}`);
  }
  refresh();
}
function answer(s, how, kind) {
  const prev = state.answers[s.id];
  state.answers[s.id] = { ...s, answer: how, kind_said: kind || null, gp_sha: INFO.gp_sha, levels: { ...state.levels, tracks: undefined } };
  undo.push({ type: 'answer', id: s.id, prev });
  toast(how === 'ignore' ? 'Ignored' : how === 'agree' ? `Yes: ${KIND[SUGKIND[s.kind]]}` : `It's: ${KIND[kind]}`);
  refresh();
}
function undoLast() {
  const u = undo.pop();
  if (!u) return toast('Nothing to undo');
  if (u.type === 'verdict') state.verdicts = state.verdicts.filter((v) => v !== u.v);
  else if (u.prev) state.answers[u.id] = u.prev; else delete state.answers[u.id];
  lastKey = null; toast('Undone'); refresh();
}
function refresh() { drawTimeline(); drawCard(); drawGrid(); drawLists(); save(); }

// ---- the guess near the playhead ----
const SUS = INFO.suspects;
const forSolo = (s) => { const x = soloTrack(); return !x || s.track == null || s.track === x.info.index; };
function current() {
  const t = rec.el.currentTime;
  let best = null, bd = 1e9;
  for (const s of SUS) {
    if (state.answers[s.id] || !forSolo(s)) continue;
    if (t < s.rec[0] - 2 || t > s.rec[1] + 1.5) continue;
    const d = Math.abs(t - s.rec[0]);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
let shown = null;
function drawCard() {
  const s = current();
  if (s === shown) return;
  shown = s;
  const box = $('card'); box.textContent = '';
  if (!s) return;
  const pct = Math.min(70, Math.max(0, 100 * s.rec[0] / dur() - 10));
  const name = s.track == null ? 'whole tab' : (INFO.tracks.find((t) => t.index === s.track) || {}).name;
  box.append(make('div', { className: 'c ' + s.kind, style: `left:${pct}%` }, [
    make('b', { textContent: `${fmt(s.rec[0])} · ${name}` }), make('span', { textContent: s.text }),
    make('div', { className: 'keys', textContent: 'Enter: yes, wrong · X: ignore · or W T Q L: it\'s that instead' })]));
}
function nextGuess(dir) {
  const t = rec.el.currentTime;
  const open = SUS.filter((s) => !state.answers[s.id] && forSolo(s)).sort((a, b) => a.rec[0] - b.rec[0]);
  const s = dir > 0 ? open.find((x) => x.rec[0] > t + 2.1) : open.reverse().find((x) => x.rec[0] < t - 2.1);
  if (!s) return toast(dir > 0 ? 'No more guesses ahead' : 'No guesses before here');
  if (s.track != null) { const i = tracks.findIndex((x) => x.info.index === s.track); if (i >= 0 && solo != null) setSolo(i); }
  setLoop(s.rec[0] - 2, s.rec[1] + 1); seek(s.rec[0] - 2);
}

// ---- the timeline: sections, one lane per track, guesses and checks ----
const TONE = { wrong_note: 'var(--bad)', timing: 'var(--acc)', too_quiet: 'var(--quiet)', too_loud: 'var(--warn)', other: 'var(--fg)', ok: 'var(--ok)' };
function cellOf(track, si) {
  const vs = state.verdicts.filter((v) => v.track === track && (v.section_i === si || (v.kind !== 'ok' && v.rec[0] >= sections[si].rec0 && v.rec[0] < sections[si].rec1)));
  if (vs.some((v) => v.kind !== 'ok')) return 'issue';
  if (vs.some((v) => v.kind === 'ok')) return 'ok';
  const s = sections[si];
  return (state.heard[track + ':' + si] || 0) >= 0.5 * (s.rec1 - s.rec0) ? 'heard' : 'unheard';
}
function cells() {
  const out = {};
  for (const x of tracks) for (let si = 0; si < sections.length; si++) out[x.info.index + ':' + si] = cellOf(x.info.index, si);
  return out;
}
function drawTimeline() {
  const tl = $('tl'); tl.textContent = '';
  const D = dur(), pc = (t) => (100 * Math.max(0, t) / D) + '%';
  const strip = make('div', { className: 'strip' });
  for (const s of sections) strip.append(make('div', { className: 'sec', textContent: s.name, title: s.name,
    style: `left:${pc(s.rec0)};width:${100 * (s.rec1 - s.rec0) / D}%;background:${SEC_COL[s.kind] || '#757575'}` }));
  tl.append(strip);
  tracks.forEach((x, i) => {
    const lane = make('div', { className: 'lane' + (i === solo ? ' solo' : '') });
    lane.dataset.i = i;
    sections.forEach((s, si) => {
      const c = cellOf(x.info.index, si);
      lane.append(make('div', { className: 'cov c-' + c, style: `left:${pc(s.rec0)};width:${100 * (s.rec1 - s.rec0) / D}%` }));
    });
    for (const s of SUS) if (s.track === x.info.index) lane.append(make('div', { className: `tick sug ${s.kind}${state.answers[s.id] ? ' done' : ''}`, style: `left:${pc(s.rec[0])}`, title: s.text }));
    for (const v of state.verdicts) if (v.track === x.info.index && v.kind !== 'ok') lane.append(make('div', { className: 'tick v', style: `left:${pc(v.rec[0])};background:${TONE[v.kind]}`, title: KIND[v.kind] }));
    lane.append(make('span', { className: 'name', textContent: x.info.name }));
    tl.append(lane);
  });
  // whole-tab lane: chord guesses and checks with no track
  const lane = make('div', { className: 'lane' + (solo == null ? ' solo' : '') });
  lane.dataset.i = -1;
  for (const s of SUS) if (s.track == null) lane.append(make('div', { className: `tick sug ${s.kind}${state.answers[s.id] ? ' done' : ''}`, style: `left:${pc(s.rec[0])}`, title: s.text }));
  for (const v of state.verdicts) if (v.track == null && v.kind !== 'ok') lane.append(make('div', { className: 'tick v', style: `left:${pc(v.rec[0])};background:${TONE[v.kind]}`, title: KIND[v.kind] }));
  lane.append(make('span', { className: 'name', textContent: 'All tracks' }));
  tl.append(lane);
  tl.append(make('div', { className: 'head', style: `left:${pc(rec.el.currentTime)}` }));
}
$('tl').onclick = (e) => {
  const r = $('tl').getBoundingClientRect();
  const lane = e.target.closest('.lane');
  if (lane) setSolo(+lane.dataset.i < 0 ? null : +lane.dataset.i);
  seek(dur() * (e.clientX - r.left) / r.width);
};

// ---- the grid: tracks × sections ----
function drawGrid() {
  const g = $('grid'); g.textContent = '';
  g.append(make('tr', {}, [make('th'), ...sections.map((s) => make('th', { textContent: s.name.replace(/(Pre-|Post-)?Chorus/, (m) => m.replace('Chorus', 'Ch')).replace('Verse ', 'V').replace('Bridge', 'Br').replace('Interlude', 'Int'), title: s.name }))]));
  let ok = 0, n = 0;
  tracks.forEach((x, i) => {
    const tr = make('tr', {}, [make('th', { className: 'r', textContent: x.info.name })]);
    sections.forEach((s, si) => {
      const c = cellOf(x.info.index, si);
      const silent = !playsNear(x.info.index, (s.tab0 + s.tab1) / 2, (s.tab1 - s.tab0) / 2 + 0.5);
      if (!silent) { n++; if (c === 'ok') ok++; }
      const td = make('td', { className: silent ? '' : 'c-' + c, textContent: silent ? '·' : c === 'ok' ? '✓' : c === 'issue' ? '!' : '', title: silent ? `${x.info.name} doesn't play in ${s.name}` : `${x.info.name} · ${s.name}` });
      td.onclick = () => { setSolo(i); seek(s.rec0); };
      tr.append(td);
    });
    g.append(tr);
  });
  $('cov-sum').textContent = `(${ok} of ${n} OK)`;
}

// ---- lists ----
function drawLists() {
  const vb = $('verdicts'); vb.textContent = '';
  $('v-count').textContent = `(${state.verdicts.length})`;
  for (const v of [...state.verdicts].sort((a, b) => a.rec[0] - b.rec[0])) {
    const name = v.track == null ? 'whole tab' : (INFO.tracks.find((t) => t.index === v.track) || {}).name;
    const go = make('button', { textContent: fmt(v.rec[0]) }); go.onclick = () => seek(v.rec[0] - 1.5);
    const note = make('input', { type: 'text', placeholder: 'a word about it (optional), e.g. "should be G"', value: v.note || '' });
    note.oninput = () => { v.note = note.value; save(); };
    note.onkeydown = (e) => { if (e.key === 'Enter' || e.key === 'Escape') note.blur(); };
    const del = make('button', { textContent: '✕', title: 'delete' }); del.onclick = () => { state.verdicts = state.verdicts.filter((y) => y !== v); refresh(); };
    const where = v.kind === 'ok' ? v.section : `bar ${v.bars[0]}${v.bars[1] !== v.bars[0] ? '–' + v.bars[1] : ''}`;
    const row = make('div', { className: 'item' }, [go, make('b', { textContent: KIND[v.kind], style: `color:${TONE[v.kind]}` }), `${name} · ${where}`, v.notes?.length ? make('span', { className: 'mute', textContent: 'tab has ' + [...new Set(v.notes)].join(' ') }) : '', note, del]);
    row.dataset.vid = v.id;
    vb.append(row);
  }
  const sb = $('sus'); sb.textContent = '';
  const done = SUS.filter((s) => state.answers[s.id]).length;
  $('s-count').textContent = `(${done} of ${SUS.length} answered)`;
  for (const s of SUS) {
    const a = state.answers[s.id];
    const go = make('button', { textContent: fmt(s.rec[0]) });
    go.onclick = () => { if (s.track != null) { const i = tracks.findIndex((x) => x.info.index === s.track); if (i >= 0) setSolo(i); } setLoop(s.rec[0] - 2, s.rec[1] + 1); seek(s.rec[0] - 2); if (rec.el.paused) play(); };
    sb.append(make('div', { className: 'item' }, [go, make('span', { textContent: s.text }), make('span', { className: 'mute', textContent: a ? (a.answer === 'ignore' ? 'ignored' : a.answer === 'agree' ? 'yes' : 'it\'s ' + KIND[a.kind_said]) : '' })]));
  }
}

// ---- keys ----
function jumpSection(kind, dir) {
  const t = rec.el.currentTime;
  const list = sections.filter((s) => !kind || s.kind === kind);
  if (!list.length) return toast('This tab has no ' + ({ C: 'chorus', V: 'verse', B: 'bridge', P: 'pre-chorus', I: 'intro', O: 'outro' }[kind] || 'sections'));
  const s = dir > 0 ? (list.find((x) => x.rec0 > t + 0.5) || list[0]) : ([...list].reverse().find((x) => x.rec0 < t - 1.5) || list[list.length - 1]);
  seek(s.rec0); toast(s.name);
}
function cycleSolo(dir) {
  const tab = tabAt(rec.el.currentTime);
  for (let k = 1; k <= tracks.length; k++) {
    const i = ((solo == null ? (dir > 0 ? -1 : 0) : solo) + dir * k + tracks.length * 2) % tracks.length;
    if (playsNear(tracks[i].info.index, tab)) { setSolo(i); toast('Right ear: ' + tracks[i].info.name); return; }
  }
  toast('No track plays here');
}
function level(which, d) {
  if (which === 'rec') state.levels.rec = Math.max(-24, Math.min(12, state.levels.rec + d));
  else if (solo != null) {
    const x = tracks[solo], k = x.info.index;
    state.levels.tracks[k] = Math.max(-24, Math.min(12, (state.levels.tracks[k] || 0) + d));
    x.vol.value = state.levels.tracks[k]; x.dv.textContent = state.levels.tracks[k] + ' dB';
  } else state.levels.tab = Math.max(-24, Math.min(12, state.levels.tab + d));
  apply(); save();
  toast(which === 'rec' ? `Recording ${state.levels.rec} dB` : solo != null ? `${tracks[solo].info.name} ${state.levels.tracks[tracks[solo].info.index]} dB` : `Tab ${state.levels.tab} dB`);
}
function barStep(dir) {
  const b = barAt(tabAt(rec.el.currentTime));
  const i = b ? Math.max(0, Math.min(B.length - 1, b.i + dir)) : 0;
  seek(recOf(B[i][0]));
}
document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input[type=text], textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const c = e.code, sh = e.shiftKey;
  const sec = { KeyC: 'C', KeyV: 'V', KeyB: 'B', KeyP: 'P', KeyI: 'I', KeyO: 'O' };
  let used = true;
  if (c === 'Space') rec.el.paused ? play() : pause();
  else if (/^Digit\d$/.test(c)) seek(dur() * (+c.slice(5)) / 10);
  else if (c === 'ArrowLeft') sh ? barStep(-1) : seek(rec.el.currentTime - 10);
  else if (c === 'ArrowRight') sh ? barStep(1) : seek(rec.el.currentTime + 10);
  else if (c === 'ArrowUp') level(sh ? 'rec' : 'tab', 2);
  else if (c === 'ArrowDown') level(sh ? 'rec' : 'tab', -2);
  else if (sec[c]) jumpSection(sec[c], sh ? -1 : 1);
  else if (c === 'KeyN') jumpSection(null, sh ? -1 : 1);
  else if (c === 'KeyS') cycleSolo(sh ? -1 : 1);
  else if (c === 'KeyA') { setSolo(null); toast('Right ear: all tracks'); }
  else if (KEYKIND[c]) { const s = current(); if (s) answer(s, SUGKIND[s.kind] === KEYKIND[c] ? 'agree' : 'relabel', KEYKIND[c]); else verdict(KEYKIND[c]); }
  else if (c === 'Enter') { const s = current(); if (s) answer(s, 'agree'); else used = false; }
  else if (c === 'KeyX') { const s = current(); if (s) answer(s, 'ignore'); else toast('No guess here to ignore'); }
  else if (c === 'KeyK') verdict('ok');
  else if (c === 'KeyM') { verdict('other'); const d = document.querySelector('details:has(#verdicts)'); if (d) d.open = true; const v = state.verdicts[state.verdicts.length - 1]; const inp = document.querySelector(`[data-vid="${v.id}"] input`); if (inp) { pause(); inp.focus(); } }
  else if (c === 'Period') nextGuess(1);
  else if (c === 'Comma') nextGuess(-1);
  else if (c === 'KeyR') loop ? setLoop(null) : setLoop(rec.el.currentTime - 2, rec.el.currentTime + 2);
  else if (c === 'KeyF') { const v = [1, 0.85, 0.7, 0.5]; setSpeed(v[(v.indexOf(speed) + 1) % v.length]); toast('Speed ' + Math.round(speed * 100) + '%'); }
  else if (c === 'KeyZ') undoLast();
  else if (e.key === '?') $('guide').open = !$('guide').open;
  else used = false;
  if (used) e.preventDefault();
});

fetch('marks.json', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
  if (d && Array.isArray(d.marks) && !d.verdicts) { // the old marks/ file: carry its marks over
    const K = { 'wrong note': 'wrong_note', timing: 'timing', 'bad timing': 'timing', 'too quiet': 'too_quiet', 'too loud': 'too_loud' };
    d.verdicts = d.marks.map((m) => { const r = recOf(m.tab), s = secAt(r);
      return { id: m.id, track: m.track, kind: K[m.kind] || 'other', bars: [m.bar, m.bar], beat: m.beat, rec: [m.rec, m.rec], tab: m.tab,
        section: s?.name ?? null, section_i: s ? sections.indexOf(s) : null, notes: m.notes || [], note: m.note || '', gp_sha: d.gp_sha }; });
  }
  if (d && Array.isArray(d.verdicts)) state ={ ...state, verdicts: d.verdicts, answers: d.answers || {}, heard: d.heard || {}, levels: { rec: 0, tab: 0, tracks: {}, ...(d.levels || {}) } };
  for (const x of tracks) { const v = state.levels.tracks[x.info.index] || 0; x.vol.value = v; x.dv.textContent = v + ' dB'; }
  if (d.gp_sha && d.gp_sha !== INFO.gp_sha) toast('These checks were made on an older version of the tab');
}).catch(() => {}).finally(() => { apply(); drawTimeline(); drawGrid(); drawLists(); tick(); });
</script></body></html>
"""

if __name__ == "__main__":
    main()
