"""Line a song's tab up with its video by the note starts in the two sounds. Light CPU, numpy only, no GPU.

    python tests/yt2gp5/wavefit.py NAME            fit, and write the bar times when the gate says it is better
    python tests/yt2gp5/wavefit.py NAME --check    measure and print only (the .fretboard file stays as it is)
    python tests/yt2gp5/wavefit.py --selftest      the fake recordings of synctest.py, where the right answer is known
    --layers mix (default) | stems | all | drums,bass,other,vocals     what is lined up against what
    --range S  seconds of lag searched either side of the file's sync (default 1.5);  -v  every window's lag

The sheet music is never touched. The sync is a clock map (bar N starts at video time X), so notes and rests keep
the tab's spacing inside a bar; only the bar start times move. A rest is silent in both sounds, so it casts no vote.

How (the same few steps for every song):
  1. Both sounds become note-start strength curves, one every 5 ms (a jump in the spectrum, blurred +-10 ms so a
     synth attack and a real one can agree). Default layer "mix": all the tab's tracks against the whole recording,
     which is also what the gate listens to. "stems" lines each of the recording's stems (made once by drumclock.py)
     with the tab's tracks of that kind; the stems disagree with each other by about 60 ms on Ho Hey (drums +15,
     the rest -48), so the mix is the safe default.
  2. The tab is cut into windows of about 5 s (whole bars). For each window and each lag from -1.5 s to +1.5 s
     (5 ms steps) the two curves are compared; a window with no notes has no vote. If the lags run near the edge
     of the search, it is centred again on what it found and repeated.
  3. One path through the windows, the best total evidence, with a small cost for every ms the lag moves from one
     window to the next (Viterbi). It decides among look-alike peaks (the 8th notes of a strum) by the whole
     song, not by one window. A parabola on the peak gives the lag to about 2 ms.
  4. One straight line (one steady tempo and the start) through the confident windows (robust fit). A tempo change
     is added only where a stretch of windows sits more than 40 ms off the line, only at a bar line, only with two
     clear windows on each side, and only within 4% of the line's speed.
  5. Whole-song tuning: each tempo knot is nudged (+-0.1 s, steps 20 ms down to 1 ms) to the time where the whole
     tab's note starts line up best with the whole recording's. This is the step that makes the steady middle exact.
  6. The trust check is the gate itself (qa.judge, scored by fixsync.score). Written only when it is better than the
     file's own sync; the old file is kept as "<song>.fretboard.before-wavefit". fixsync.py also runs this as one of
     its tries, so `fixsync.py NAME` picks it when it wins.

What it cannot do: a band that rushes inside one bar (a bar-level clock has no way to say so), and a recording that
plays something the tab doesn't (the confidence rule lets those windows follow their neighbours). The floor is the
two sounds' own attack difference, about 10-20 ms; nothing in the sound can be more exact than that.
"""
import argparse
import re
import sys
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VENV = Path.home() / ".fretboard" / "yt2gp5-venv" / "Scripts" / "python.exe"
if __name__ == "__main__" and VENV.exists() and Path(sys.executable).resolve() != VENV.resolve():  # the gate needs its Python
    import subprocess
    sys.exit(subprocess.call([str(VENV), __file__, *sys.argv[1:]]))

import numpy as np  # noqa: E402

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))
import aligner  # noqa: E402  (finding the songs, the saved tracks, writing the .fretboard)

RATE = 22050
HOP = 110                  # 5 ms
DT = HOP / RATE
NFFT = 1024
LO, HI = 4, 232            # bins 85 Hz - 5 kHz
STEMS = ("drums", "bass", "other", "vocals")
STEM_OF = {"guitar": "other", "piano": "other", "other": "other", "bass": "bass", "drums": "drums", "vocals": "vocals"}
WINDOW_S = 5.0             # a window is whole bars of at least this long
RANGE_S = 1.5              # the lag searched either side of the file's own sync
LAMBDA = 0.02              # cost (in z) per 5 ms the lag moves between windows
KNOT_TOL = 0.040           # s: a stretch this far off the line gets its own tempo (the gate's STEADY_MS)
KNOT_GAP = 8.0             # s: tempo changes at least this far apart
TEMPO_PCT = 4              # a segment's tempo stays within this of the song's one line (%)
NEED_Z = 3.0               # a window is "clear" when its peak stands this far above its other lags (z)
FLOOR_Z = 1.5              # below this a window has no say in the line
REFINE_S = 0.10            # s: the whole-song tuning moves a knot at most this far from where the windows put it


class Sync:
    """Tab time (s) -> video time (s): straight lines between the points, the tab's own speed outside."""

    def __init__(self, x, y):
        self.x, self.y = np.asarray(x, float), np.asarray(y, float)

    def __call__(self, t):
        t = np.asarray(t, float)
        v = np.interp(t, self.x, self.y)
        v = np.where(t < self.x[0], self.y[0] - (self.x[0] - t), v)
        return np.where(t > self.x[-1], self.y[-1] + (t - self.x[-1]), v)


# ---------- sound -> note-start curves ----------

def to_rate(y, sr):
    if sr == RATE:
        return y.astype(np.float32)
    if sr == 2 * RATE:
        n = len(y) // 2 * 2
        return y[:n].reshape(-1, 2).mean(axis=1).astype(np.float32)
    return np.interp(np.arange(0, len(y) / sr, 1 / RATE), np.arange(len(y)) / sr, y).astype(np.float32)


def read_wav(path):
    with wave.open(str(path)) as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{Path(path).name} is not 16-bit")
        ch, sr = w.getnchannels(), w.getframerate()
        y = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    return to_rate(y.reshape(-1, ch).mean(axis=1), sr)


def moving_mean(x, w):
    w |= 1
    return np.convolve(np.pad(x, (w // 2, w // 2), mode="edge"), np.ones(w, np.float32) / w, "valid")[:len(x)]


def flux(y):
    """Spectral flux: how much the (log) spectrum grows from one 5 ms frame to the next, 85 Hz - 5 kHz."""
    y = y / (float(np.abs(y).max()) + 1e-9)
    pad = np.pad(y, (NFFT // 2, NFFT))
    frames = np.lib.stride_tricks.sliding_window_view(pad, NFFT)[::HOP]
    win = np.hanning(NFFT).astype(np.float32)
    parts = []
    for a in range(0, len(frames), 4096):
        mag = np.abs(np.fft.rfft(frames[a:a + 4096] * win, axis=1))[:, LO:HI]
        parts.append(np.log1p(30 * mag).astype(np.float32))
    lm = np.concatenate(parts)
    return np.maximum(0, np.diff(lm, axis=0, prepend=lm[:1])).sum(axis=1)


def curves(y):
    """(raw, blurred): note-start strength per 5 ms frame, each part of the song on its own level."""
    fl = flux(y)
    c = np.maximum(0, fl - moving_mean(fl, 41))
    scale = np.maximum(moving_mean(c, 601), 0.15 * float(c.mean()) + 1e-9)
    raw = np.minimum(c / scale, 5).astype(np.float32)
    return raw, np.convolve(raw, np.array([1, 2, 3, 2, 1], np.float32) / 9, "same")


def recording_id(entry, info):
    rid = (entry.get("recording") or {}).get("id")
    if rid:
        return rid
    m = re.search(r"v=([\w-]+)", info.get("url") or "")
    return m.group(1) if m else None


def load_sounds(info, vid, use):
    """{layer: (tab_sound, recording_sound)} for each stem (the tab's tracks of that kind), or one "mix" layer without stems."""
    folder = aligner.CACHE / info["slug"]
    sub = folder / f"gp-{info['gp_sha']}" / "tracks"
    meta = aligner.read_json(sub / "meta.json")
    if not meta:
        raise FileNotFoundError("The tab's rendered tracks are not saved. Run listen.py again.")
    wav = folder / f"recording-{vid}.wav"
    if not wav.exists():  # the fake recordings of synctest.py keep a longer name than the file's 11-character id
        wav = next(iter(sorted(folder.glob(f"recording-{vid}*.wav"))), wav)
    stems = folder / f"stems-{wav.stem.split('recording-')[-1]}"
    have = all((stems / f"{s}.wav").exists() for s in STEMS)
    tab = {}
    add = lambda key, y: tab.__setitem__(key, y if key not in tab else np.pad(tab[key], (0, max(0, len(y) - len(tab[key])))) + np.pad(y, (0, max(0, len(tab[key]) - len(y)))))
    for t in meta["tracks"]:
        f = sub / f"track{t['index']}.f32"
        if not f.exists():
            continue
        y = to_rate(np.fromfile(f, np.float32).reshape(-1, 2).mean(axis=1), meta["rate"])
        add("mix", y)
        if have:
            add(STEM_OF.get(t["category"], "other"), y)
    if not wav.exists():
        raise FileNotFoundError(f"The video's audio is not saved ({wav.name}). Run listen.py or fromlink.py again.")
    want = set(use or {"mix"})
    if want & {"stems", "all"}:
        want |= set(STEMS)
    if "all" in want:
        want.add("mix")
    # each stem against the tab's tracks of that kind
    out = {s: (tab[s], read_wav(stems / f"{s}.wav")) for s in STEMS if have and s in tab and s in want}
    if "mix" in want or not out:  # all the tab against the whole recording
        out["mix"] = (tab["mix"], read_wav(wav))
    return out


# ---------- windows, scores, the path ----------

def windows(bars_t):
    edges = [float(bars_t[0])]
    for t in bars_t[1:]:
        if t - edges[-1] >= WINDOW_S:
            edges.append(float(t))
    end = float(bars_t[-1] + np.median(np.diff(bars_t)))
    if end - edges[-1] < WINDOW_S / 2 and len(edges) > 1:
        edges.pop()
    edges.append(end)
    return np.array(edges)


def score_matrix(layers, base, edges, lags):
    """[window, lag]: how alike the tab's and the recording's note starts are, the recording read at the base
    sync + lag. Each layer is a cosine per window; layers with more notes in the window weigh more."""
    n = min(len(a) for a, _ in layers.values())
    t = np.arange(n) * DT
    v0 = base(t)
    idx = np.minimum((edges[:-1] / DT).astype(int), n - 2)
    num = np.zeros((len(idx), len(lags)))
    wsum = np.zeros(len(idx))
    cnt = np.diff(np.r_[idx, n]).astype(float)  # frames per window
    for a, rec in layers.values():
        a = a[:n]
        sa = np.add.reduceat(a, idx)
        va = np.add.reduceat(a * a, idx) - sa * sa / cnt
        rt = np.arange(len(rec)) * DT
        wl = np.sqrt(np.maximum(va, 0))
        wsum += wl
        for gi, g in enumerate(lags):  # Pearson correlation per window (the level of each curve taken out)
            r = np.interp(v0 + g, rt, rec, left=0, right=0)
            sr = np.add.reduceat(r, idx)
            vr = np.add.reduceat(r * r, idx) - sr * sr / cnt
            cov = np.add.reduceat(a * r, idx) - sa * sr / cnt
            num[:, gi] += wl * cov / (np.sqrt(np.maximum(va, 0) * np.maximum(vr, 0)) + 1e-9)
    S = num / np.maximum(wsum, 1e-9)[:, None]
    centre = np.add.reduceat(sum(a[:n] * t for a, _ in layers.values()), idx) / np.maximum(
        np.add.reduceat(sum(a[:n] for a, _ in layers.values()), idx), 1e-9)
    return S, wsum, centre


def zscore(S, wsum):
    Z = np.zeros_like(S)
    for w in range(len(S)):
        if wsum[w] < 1e-6:
            continue  # a rest: no notes in the tab, no vote
        Z[w] = np.minimum((S[w] - S[w].mean()) / max(S[w].std(), 1e-3), 10)
    return Z


def viterbi(Z, lam):
    """The path of lags (one per window) with the most evidence, paying lam per bin the lag moves between windows."""
    W, G = Z.shape
    best, back = np.zeros((W, G)), np.zeros((W, G), int)
    best[0] = Z[0]
    for w in range(1, W):
        f, src = best[w - 1].copy(), np.arange(G)
        for g in range(1, G):
            if f[g - 1] - lam > f[g]:
                f[g], src[g] = f[g - 1] - lam, src[g - 1]
        for g in range(G - 2, -1, -1):
            if f[g + 1] - lam > f[g]:
                f[g], src[g] = f[g + 1] - lam, src[g + 1]
        best[w], back[w] = Z[w] + f, src
    path = [int(np.argmax(best[-1]))]
    for w in range(W - 1, 0, -1):
        path.append(int(back[w][path[-1]]))
    return path[::-1]


def parabola(row, i):
    if 0 < i < len(row) - 1:
        a, b, c = row[i - 1], row[i], row[i + 1]
        d = a - 2 * b + c
        if d < 0:
            return i + float(np.clip(0.5 * (a - c) / d, -1, 1))
    return float(i)


# ---------- the line: one tempo, more only where the data asks ----------

def pw_fit(t, v, w, knots):
    """Continuous piecewise-linear least squares through (t, v), robust: windows far off the line (a part the
    recording doesn't play, an alias of the rhythm) lose their weight over a few passes (Tukey's bisquare)."""
    B = np.stack([np.interp(t, knots, np.eye(len(knots))[k]) for k in range(len(knots))], axis=1)
    ww = w.astype(float)
    for _ in range(6):
        sw = np.sqrt(ww)
        sol = np.linalg.lstsq(B * sw[:, None], v * sw, rcond=None)[0]
        res = v - B @ sol
        spread = max(1.4826 * float(np.median(np.abs(res[w > 0]))), 0.015)  # at least 15 ms
        ww = w * (1 - np.clip(res / (4.685 * spread), -1, 1) ** 2) ** 2 + 1e-9
    return sol, B @ sol


def choose_knots(t, v, w, bars_t):
    """Straight line first; a knot (a tempo change) only where a stretch of windows stays off it, at the nearest bar line."""
    knots = [float(bars_t[0]), float(bars_t[-1])]
    sol, _ = pw_fit(t, v, w, np.array(knots))
    s0 = float((np.diff(sol) / np.diff(knots))[0])
    plausible = lambda kn, sl: bool(np.all(np.abs(np.diff(sl) / np.diff(kn) / s0 - 1) <= TEMPO_PCT / 100))
    for _ in range(12):
        sol, fit = pw_fit(t, v, w, np.array(knots))
        res = np.where(w > 0, v - fit, 0.0)
        sm = np.array([np.median(res[max(0, i - 1):i + 2]) for i in range(len(res))])  # a lone window can't make a knot
        for i in np.argsort(-np.abs(sm)):
            if abs(sm[i]) <= KNOT_TOL:
                return np.array(knots), sol
            k = float(bars_t[int(np.argmin(np.abs(bars_t - t[i])))])
            trial = sorted(knots + [k])
            if not all(abs(k - x) >= KNOT_GAP for x in knots):
                continue
            clear = w >= NEED_Z - FLOOR_Z
            support = [int(np.sum((t >= a) & (t <= b) & clear)) for a, b in zip(trial[:-1], trial[1:])]
            sol_t, _ = pw_fit(t, v, w, np.array(trial))
            if min(support) >= 2 and plausible(np.array(trial), sol_t):  # two clear windows to stand on, and a speed a band could play
                knots = trial
                break
        else:
            break
    sol, _ = pw_fit(t, v, w, np.array(knots))
    return np.array(knots), sol


def refine(layers, knots, vals, reach=REFINE_S):
    """The knots' video times tuned against the whole song at once: the tab's note starts against the recording's,
    every layer, as one correlation over all of it (the windows only found the structure; a window alone is noisy,
    the whole song is not). A pattern search, 20 ms down to 1 ms steps, each knot moving at most `reach` from where
    the windows put it."""
    n = min(len(a) for a, _ in layers.values())
    t = np.arange(n) * DT
    tabs = {k: (a[:n] - a[:n].mean()) / (a[:n].std() + 1e-9) for k, (a, _) in layers.items()}
    rts = {k: np.arange(len(rec)) * DT for k, (_, rec) in layers.items()}

    def score(vv):
        v = Sync(knots, vv)(t)
        total = 0.0
        for k, (_, rec) in layers.items():
            r = np.interp(v, rts[k], rec, left=0, right=0)
            total += float(np.mean(tabs[k] * (r - r.mean()) / (r.std() + 1e-9)))
        return total

    vals = np.asarray(vals, float)
    start, cur = vals.copy(), vals.copy()
    best = score(cur)
    for step in (0.020, 0.008, 0.003, 0.001):
        moved = True
        while moved:
            moved = False
            for k in range(len(cur)):
                for d in (-step, step):
                    trial = cur.copy()
                    trial[k] = float(np.clip(trial[k] + d, start[k] - reach, start[k] + reach))
                    if trial[k] != cur[k] and (sc := score(trial)) > best + 1e-6:
                        cur, best, moved = trial, sc, True
    return cur


# ---------- one song ----------

_CACHE = {}  # (song, video, layers) -> the curves: a fixer that tries many starting points reads the sound once


def get_curves(info, vid, use):
    key = (info["slug"], vid, tuple(sorted(use or ())))
    if key not in _CACHE:
        _CACHE[key] = {k: (curves(ts)[1], curves(rs)[1]) for k, (ts, rs) in load_sounds(info, vid, use).items()}
    return _CACHE[key]


def fit_song(slug, base_file=None, base_points=None, use=None, rng=RANGE_S, say=print):
    """The song's bar times lined up on the recording, starting from the points given (or the file's own)."""
    d = aligner.LISTEN / slug
    info = aligner.read_json(d / "info.json")
    fb = Path(base_file) if base_file else aligner.fretboard_of(d)
    entry = aligner.read_json(fb)["songs"][0]
    vid = recording_id(entry, info)
    bars_t = np.array([b[0] for b in info["bars"]], float)
    pts = base_points or entry["syncPoints"]
    base = Sync([bars_t[p] for p, _ in pts], [ms / 1000 for _, ms in pts])
    t0 = time.time()
    layers = get_curves(info, vid, use)
    say(f"  layers: {', '.join(layers)} (video {vid}); curves {time.time() - t0:.1f} s")
    edges = windows(bars_t)
    lags = np.arange(-rng, rng + 1e-9, DT)
    base0 = base
    for attempt in range(4):
        S, wsum, centre = score_matrix(layers, base, edges, lags)
        Z = zscore(S, wsum)
        path = viterbi(Z, LAMBDA)
        g = np.array([(parabola(S[w], i) - (len(lags) - 1) / 2) * DT for w, i in enumerate(path)])
        z = np.array([Z[w, i] for w, i in enumerate(path)])
        keep = (wsum > 1e-6) & (z >= FLOOR_Z)  # every window with some evidence, each weighed by how clear it is
        if (keep & (z >= NEED_Z)).sum() < 3:
            raise RuntimeError("There are too few clear note starts to line the tab up on.")
        t, v = centre[keep], base(centre[keep]) + g[keep]
        knots, sol = choose_knots(t, v, np.clip(z[keep] - FLOOR_Z, 0.1, 7), bars_t)
        sync = Sync(knots, sol)
        if attempt == 3 or not (np.abs(g[keep]) >= rng - 0.3).any():
            break
        base = sync  # a lag ran towards the edge of the search (the file's sync drifts far): look again round the line just found
    sol = refine(layers, knots, sol)
    sync = Sync(knots, sol)
    return {"slug": slug, "points": _points(sync, bars_t), "base": base0, "sync": sync, "knots": knots,
            "sections": [int(np.argmin(np.abs(bars_t - k))) for k in knots[1:-1]],  # the bars where the tempo changes (0-based)
            "slopes": np.diff(sol) / np.diff(knots), "bars_t": bars_t, "seconds": round(time.time() - t0, 1),
            "edges": [int(i) for i, p in enumerate(path) if keep[i] and (p <= 1 or p >= len(lags) - 2)],
            "windows": [{"from": float(edges[w]), "lag_ms": round(1000 * float(g[w])), "z": round(float(z[w]), 1), "used": bool(keep[w] and z[w] >= NEED_Z)}
                        for w in range(len(g))]}


def _points(sync, bars_t):
    out, last = [], -1
    for p, v in enumerate(sync(bars_t)):
        ms = max(0, int(round(float(v) * 1000)))
        if ms > last:
            out.append([p, ms])
            last = ms
    return out


def show(r, windows=False, say=print):
    if windows:
        say("  window  from   lag     z")
        for i, w in enumerate(r["windows"]):
            say(f"  {i + 1:>4}  {w['from']:6.1f}s {w['lag_ms']:+6d} ms {w['z']:5.1f}{'' if w['used'] else '  (too weak: follows its neighbours)'}")
    used = sum(w["used"] for w in r["windows"])
    say(f"  {used} of {len(r['windows'])} windows clear; {r['seconds']} s")
    for k0, k1, s in zip(r["knots"][:-1], r["knots"][1:], r["slopes"]):
        say(f"  tab {k0:6.1f}-{k1:6.1f} s: the video plays the tab's tempo at {100 / s:.2f}%")
    say(f"  bar 1 at {r['points'][0][1] / 1000:.3f} s in the video (the file had {float(r['base'](r['bars_t'][0])):.3f} s)")


def find(name):
    for s in aligner.songs():
        if name.lower().replace(" ", "_") in s["slug"].lower() or name.lower() in s["name"].lower():
            return s["slug"]
    sys.exit(f"No saved song matches '{name}'. Songs: " + ", ".join(s["name"] for s in aligner.songs()))


# the fake recordings of synctest.py: (video seconds per tab second, start delay s)
CASES = {"copy": (1.0, 0.0), "late3s": (1.0, 3.0), "slow3pct": (1.03, 1.5), "fast3pct": (0.97, 2.0), "noisy": (1.015, 4.2)}
PASS_MS = 20


def selftest(use=None):
    """Each fake recording: the answer is known, so every bar's time is checked against it. Each is started twice:
    from the file's line-up and from a bad start (0.4 s late and 0.5 % too slow)."""
    ok = total = 0
    for case, (factor, delay) in CASES.items():
        slug = f"SYNCTEST_Be_My_Escape_{case}"
        d = aligner.LISTEN / slug
        before = next(d.glob("*.fretboard.before"), None)
        if not before:
            print(f"{case}: no fake song yet (run: python tests/yt2gp5/synctest.py)")
            continue
        for label, worse in (("from the line-up", False), ("from a bad start", True)):
            pts = aligner.read_json(before)["songs"][0]["syncPoints"]
            if worse:
                pts = [[p, int(round(ms * 1.005 + 400))] for p, ms in pts]
            r = fit_song(slug, base_file=before, base_points=pts, use=use, say=lambda *a: None)
            truth = delay + factor * r["bars_t"]
            err = np.array([ms / 1000 - truth[p] for p, ms in r["points"]]) * 1000
            good = bool(np.abs(err).max() <= PASS_MS)
            ok, total = ok + good, total + 1
            print(f"  {'PASS' if good else 'FAIL'} {case:9} {label:16}: median {np.median(err):+.1f} ms, worst {np.abs(err).max():.1f} ms "
                  f"({len(r['knots']) - 2} tempo changes, {r['seconds']} s)")
    print(f"{ok} of {total} right (every bar within {PASS_MS} ms)")
    return ok == total


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", nargs="?", default="")
    ap.add_argument("--check", action="store_true", help="judge and print only; the .fretboard file stays as it is")
    ap.add_argument("--selftest", action="store_true", help="the fake recordings, where the right answer is known")
    ap.add_argument("--layers", default="", help="what to line up: mix (default: all the tab against the whole recording), "
                    "stems (each Demucs stem against the tab's tracks of that kind), all, or some of drums,bass,other,vocals")
    ap.add_argument("--range", type=float, default=RANGE_S, help="seconds of lag searched either side of the file's sync")
    ap.add_argument("-v", "--verbose", action="store_true", help="every window's lag")
    a = ap.parse_args()
    use = {s.strip() for s in a.layers.split(",") if s.strip()} or None
    if a.selftest:
        sys.exit(0 if selftest(use) else 1)
    if not a.name:
        sys.exit(__doc__)
    slug = find(a.name)
    print(slug)
    r = fit_song(slug, use=use, rng=a.range)
    show(r, a.verbose)
    import fixsync  # the gate and the rule for what is better (they need the yt2gp5 Python)
    import qa
    s = qa.load(aligner.read_json(aligner.LISTEN / slug / "info.json")["name"])
    old, new = qa.judge(s), qa.judge({**s, "sections": r["sections"]}, points=r["points"])
    for name, v in (("the file's sync", old), ("wavefit", new)):
        print(f"  {v['verdict']:6} {name}: {len(v['fails'])} fails, {len(v['listen'])} listens, {fixsync.score(v)[2]} bars drift")
        for x in v["fails"] + v["listen"]:
            print(f"           {x[:150]}")
    better = fixsync.score(new) < fixsync.score(old)
    if better and not a.check:
        out = aligner.save(slug, r["points"], f"wavefit: {old['verdict']} -> {new['verdict']}", by="wavefit")
        print(f"better, written: {out['file']} (the first version is {out['backup']}); import it in Fretboard with Replace it")
    else:
        print("not better than the file's sync, so nothing is written" if not better else "better (--check: nothing written)")
    sys.exit(0 if new["verdict"] == "PASS" else 2 if new["verdict"] == "LISTEN" else 3)


if __name__ == "__main__":
    main()
