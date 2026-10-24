"""Listen to a song's tab on top of its YouTube recording, to hear that they match all the way through.

    python tests/yt2gp5/listen.py NAME            a song from songs.json (part of its name is enough)
    python tests/yt2gp5/listen.py NAME --url URL  against another video

Each track of the tab is played by Fretboard's synth on its own, then stretched (pitch kept) to follow the
recording's timing, as real.whole_match lined the two up. A local page plays them all together: a switch
and a volume per track, the recording's volume, recording left / tab right, and the 10-s stretches with
the ones that don't match in red (click one to go there).

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
import real  # noqa: E402
import run  # noqa: E402
import songdb  # noqa: E402

OUT = HERE / "out" / "listen"
RATE = 44100
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
    tracks = []
    for t, f in zip(meta["tracks"], files):
        y = np.fromfile(f, dtype=np.float32).reshape(-1, 2).mean(axis=1) * gain
        if np.abs(y).max() < 1e-4:
            continue  # a silent track (nothing written for it)
        if m["shift"]:
            import librosa
            y = librosa.effects.pitch_shift(y, sr=RATE, n_steps=m["shift"])
        print(f"  {t['name']} ({t['category']})")
        y = warp(y, tab_at)[:len(rec)]
        name = f"track{t['index']}.m4a"
        encode(y, out / name)
        tracks.append({"file": name, "name": t["name"], "category": t["category"]})
    off_t = mp[0, 0]  # the parts count from the tab's first sound; the map from the start of each file
    on_rec = lambda t: round(float(np.interp(t + off_t, mp[:, 0], mp[:, 1])), 2)
    parts = [{"tab": [p["tab"][0] + off_t, p["tab"][1] + off_t], "rec": [on_rec(p["tab"][0]), on_rec(p["tab"][1])],
              "dist": p["dist"], "why": p["why"]} for p in m["parts"]]
    info = {"name": song["name"], "url": url, "ok": m["ok"], "shift": m["shift"], "head_s": m["head_s"],
            "tail_s": m["tail_s"], "dist": m["dist"], "worst": m["worst"], "tracks": tracks, "parts": parts}
    (out / "index.html").write_text(PAGE.replace("/*INFO*/null", json.dumps(info)), encoding="utf-8")
    print(f"{'matches all the way through' if m['ok'] else 'does NOT match all the way through'}: {songdb.why(m)}")
    return out


class Ranged(http.server.SimpleHTTPRequestHandler):
    """Serves byte ranges, so the page can jump around in the audio."""
    def log_message(self, *a):
        pass

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
    out = build(song, url)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Ranged, directory=str(out)))
    link = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    print(f"listen at {link} (Ctrl+C to stop)")
    webbrowser.open(link)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Listen along</title>
<style>
:root { --bg:#fafaf8; --fg:#1d1d1b; --mute:#6b6b66; --line:#deded8; --bad:#c62828; --ok:#2e7d32; --acc:#1565c0; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ececea; --mute:#9a9a94; --line:#33332f; --bad:#ef5350; --ok:#66bb6a; --acc:#64b5f6; } }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.4 system-ui, sans-serif; }
main { max-width:860px; margin:0 auto; padding:16px; }
h1 { font-size:20px; margin:0 0 4px; }
.sub { color:var(--mute); margin-bottom:12px; }
.verdict { font-weight:600; } .verdict.ok { color:var(--ok); } .verdict.no { color:var(--bad); }
.bar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:10px 0; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); }
button { font:inherit; padding:6px 14px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; }
#seek { flex:1; min-width:200px; }
.row { display:flex; gap:10px; align-items:center; padding:6px 0; border-bottom:1px solid var(--line); }
.row label { flex:1; } .row input[type=range] { width:160px; }
.cat { color:var(--mute); font-size:13px; }
#parts { display:flex; flex-wrap:wrap; gap:4px; margin-top:12px; }
#parts span { padding:3px 6px; border-radius:4px; border:1px solid var(--line); font-size:12px; cursor:pointer; font-variant-numeric:tabular-nums; }
#parts span.bad { border-color:var(--bad); color:var(--bad); }
#parts span.now { background:var(--acc); color:var(--bg); border-color:var(--acc); }
h2 { font-size:16px; margin:18px 0 6px; }
</style></head><body><main>
<h1 id="title"></h1><div class="sub" id="sub"></div>
<div class="bar"><button id="play">Play</button><span id="time">0:00</span><input id="seek" type="range" min="0" max="1" step="0.1" value="0"></div>
<div class="row"><label><input type="checkbox" id="rec-on" checked> YouTube recording</label><input type="range" id="rec-vol" min="0" max="1.5" step="0.05" value="1"></div>
<div class="row"><label><input type="checkbox" id="split"> Recording in the left ear, tab in the right</label></div>
<div class="row"><label>Tab timing nudge <span id="nudge-v">0 ms</span></label><input type="range" id="nudge" min="-300" max="300" step="10" value="0"></div>
<h2>Your tab's tracks</h2><div id="tracks"></div>
<h2>Every 10 s of the tab (red: doesn't match there)</h2><div id="parts"></div>
</main><script>
const INFO = /*INFO*/null;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
document.getElementById('title').textContent = INFO.name;
document.getElementById('sub').innerHTML = `<span class="verdict ${INFO.ok ? 'ok' : 'no'}">${INFO.ok ? 'Matches all the way through' : 'Does not match all the way through'}</span>
  · chords ${INFO.dist} (worst 10 s ${INFO.worst}) · ${INFO.head_s > 1 ? INFO.head_s + ' s extra at the start · ' : ''}${INFO.tail_s > 1 ? INFO.tail_s + ' s extra at the end · ' : ''}${INFO.shift ? 'tab moved ' + INFO.shift + ' semitones · ' : ''}<a href="${INFO.url}" target="_blank" rel="noopener">video</a>`;
const ctx = new AudioContext();
const els = [];
function add(file, pan) {
  const el = new Audio(file); el.preload = 'auto'; el.preservesPitch = true;
  const src = ctx.createMediaElementSource(el), g = ctx.createGain(), p = ctx.createStereoPanner();
  src.connect(g).connect(p).connect(ctx.destination);
  const x = { el, g, p, pan, on: true, vol: 1 }; els.push(x); return x;
}
const rec = add('recording.m4a', -1);
const tracks = INFO.tracks.map((t) => {
  const x = add(t.file, 1);
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = `<label><input type="checkbox" checked> ${t.name} <span class="cat">${t.category}</span></label><input type="range" min="0" max="1.5" step="0.05" value="1">`;
  row.querySelector('input[type=checkbox]').onchange = (e) => { x.on = e.target.checked; apply(); };
  row.querySelector('input[type=range]').oninput = (e) => { x.vol = +e.target.value; apply(); };
  document.getElementById('tracks').append(row); return x;
});
const split = document.getElementById('split');
function apply() {
  for (const x of els) { x.g.gain.value = x.on ? x.vol : 0; x.p.pan.value = split.checked ? x.pan : 0; }
}
document.getElementById('rec-on').onchange = (e) => { rec.on = e.target.checked; apply(); };
document.getElementById('rec-vol').oninput = (e) => { rec.vol = +e.target.value; apply(); };
split.onchange = apply; apply();
let nudge = 0;
document.getElementById('nudge').oninput = (e) => { nudge = +e.target.value / 1000; document.getElementById('nudge-v').textContent = e.target.value + ' ms'; seek(rec.el.currentTime); };
const seekEl = document.getElementById('seek');
rec.el.addEventListener('loadedmetadata', () => { seekEl.max = rec.el.duration; });
function seek(t) {
  rec.el.currentTime = t;
  for (const x of tracks) x.el.currentTime = Math.max(0, t - nudge);
}
seekEl.oninput = () => seek(+seekEl.value);
const playBtn = document.getElementById('play');
playBtn.onclick = async () => {
  await ctx.resume();
  if (rec.el.paused) { seek(rec.el.currentTime); await Promise.all(els.map((x) => x.el.play())); playBtn.textContent = 'Pause'; }
  else { els.forEach((x) => x.el.pause()); playBtn.textContent = 'Play'; }
};
rec.el.addEventListener('ended', () => { els.forEach((x) => x.el.pause()); playBtn.textContent = 'Play'; });
// the tracks follow the recording: a small drift is eased out by speed, a big one by a jump
setInterval(() => {
  const t = rec.el.currentTime;
  seekEl.value = t; document.getElementById('time').textContent = fmt(t);
  document.querySelectorAll('#parts span').forEach((s) => s.classList.toggle('now', t >= +s.dataset.r0 && t < +s.dataset.r1));
  if (rec.el.paused) return;
  for (const x of tracks) {
    const d = x.el.currentTime - (t - nudge);
    if (Math.abs(d) > 0.15) { x.el.currentTime = t - nudge; x.el.playbackRate = 1; }
    else x.el.playbackRate = Math.abs(d) > 0.01 ? 1 - Math.max(-0.05, Math.min(0.05, d)) : 1;
  }
}, 100);
for (const p of INFO.parts) {
  const s = document.createElement('span');
  s.textContent = fmt(p.rec[0]); s.dataset.r0 = p.rec[0]; s.dataset.r1 = p.rec[1];
  s.title = `tab ${fmt(p.tab[0])}–${fmt(p.tab[1])} · chords ${p.dist}${p.why ? ' · ' + p.why : ''}`;
  if (p.why) s.className = 'bad';
  s.onclick = () => seek(p.rec[0]);
  document.getElementById('parts').append(s);
}
</script></body></html>
"""

if __name__ == "__main__":
    main()
