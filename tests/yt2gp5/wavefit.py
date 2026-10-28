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
     song, not by one window; the lag may move at most 6% of the time between two windows (a band's tempo, not half
     a beat in one step). A parabola on the peak gives the lag to about 2 ms. A short last window is joined to the
     one before it (a lone last bar voted -225 ms on Ho Hey).
  4. One straight line (one steady tempo and the start) through the confident windows (robust fit). A tempo change
     is added only where a stretch of windows sits more than 40 ms off the line, only at a bar line, only with two
     clear windows on each side, and only within 4% of the line's speed.
     The ending is a second try, "wavefit + ending": bands slow down in the last bars (Ho Hey: 3%, the user heard
     it) where there are few clear windows. The last stretch takes one more knot, on the line, with its own end
     value; the steady middle is left exactly as it was. A few windows can't tell a real slow-down from a chance
     peak (the self-test's noisy case shows it), so this try is only kept when the gate likes it better.
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
import json
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
LAG_STEP_PCT = 6           # the lag moves at most this % of the time between two windows (a tempo change a band could make)
LAMBDA = 0.02              # cost (in z) per 5 ms the lag moves between windows
KNOT_TOL = 0.040           # s: a stretch this far off the line gets its own tempo (the gate's STEADY_MS)
KNOT_GAP = 8.0             # s: tempo changes at least this far apart
KNOT_GAIN = 0.010          # a tempo change must cut the weighted squared misfit by this much (s^2); a free knot on pure noise buys ~0.003
TEMPO_PCT = 4              # a segment's tempo stays within this of the song's one line (%)
NEED_Z = 3.0               # a window is "clear" when its peak stands this far above its other lags (z)
LAG_COST = 0.4             # z per second of lag away from the file's sync (a one-beat alias, 0.67 s, costs 0.27)
POOLED_Z = 6.0             # a lag every window agrees on (chance gives ~3)
FLOOR_Z = 1.5              # below this a window has no say in the line
REFINE_S = 0.10            # s: the whole-song tuning moves a knot at most this far from where the windows put it
HARM = 0.8                 # weight of the harmony's z next to the note starts' z in each window (harmony try only)
CHROMA_HOP = 512           # the harmony's frames (qa.py's cache): 23 ms
POLISH_S = 8.0              # s: each tempo change is tried at every bar line this near where the windows put it (0 = off)
POLISH_DY = 0.25           # s: and with its video time this far either side of the line
END_GAIN = 0.0              # the ending try keeps a slow-down only if the whole song's note starts agree this much more (correlation)
END_REACH_S = 16.0         # s: the slow-down may start this far from the last bar line (and at least 4 s)
START_RANGE_S = 40.0       # s: the start is searched this far either side of the file's (an intro the tab lacks, or the reverse)
START_STEP = 5             # lag grid of that search, in 5 ms frames
START_COST = 0.02          # z per second of lag away from the file's start (ties go to the nearer)
START_MIN = 0.8            # s: a shift smaller than this is left to the main fit
START_SLOPE = 0.06         # the start line's tempo may be this much (fraction) off the tab's
START_GAIN = 0.75          # mean z per window the best line must win by over the best line within 1.5 s (benchmark: 57 far starts fixed, 0 made worse, with the chords; the note starts alone can't tell)
BEAT_W = 0.6               # weight of the bar-line evidence (the recording's downbeats) next to the note starts' z (bar-line try only)
BEAT_SIGMA = 0.04          # s: how far from a bar line still counts
BEAT_OTHER = 0.4           # a beat that is not a bar line counts this much next to a bar line's 1
GRID_IRREGULAR = 0.05      # a recording's beat is "steady" when at most this share of its beat gaps is off the median gap
GRID_UNMATCHED = 0.5       # cost, in similarity per tab bar, of each tab bar or recording bar the grid leaves without a partner
GRID_MAX_UNMATCHED = 8     # bars: more than this unmatched and the grid isn't trusted
GRID_TOL = 0.03            # s: the grid's bar times may be this far from the smooth line through them (a few bars off = a knot)
GRID_SLIP_COST = 0.03     # a stretch of bars may sit whole beats off the grid (the recording has a short bar the tab doesn't) when that gains this much of the song's similarity
GRID_SHIFT_S = 0.10        # s: the whole grid is nudged this far either side to sit on the note starts


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


def recording_wav(info, vid):
    folder = aligner.CACHE / info["slug"]
    wav = folder / f"recording-{vid}.wav"
    if not wav.exists():  # the fake recordings of synctest.py keep a longer name than the file's 11-character id
        wav = next(iter(sorted(folder.glob(f"recording-{vid}*.wav"))), wav)
    return wav


def load_beats(info, vid):
    """(beats, bar lines) of the recording in seconds from Beat This! (CPU, about 10 s; kept in wavefit_beats.json beside
    the song and keyed by the recording, so a new video is read again)."""
    wav = recording_wav(info, vid)
    f = aligner.LISTEN / info["slug"] / "wavefit_beats.json"
    key = {"vid": vid, "bytes": wav.stat().st_size}
    saved = aligner.read_json(f) if f.exists() else None
    if saved and saved.get("key") == key:
        return np.array(saved["beats"], float), np.array(saved["downbeats"], float)
    import torch
    from beat_this.inference import Audio2Beats
    torch.set_num_threads(2)
    beats, downs = Audio2Beats(device="cpu", dbn=False)(read_wav(wav), RATE)
    f.write_text(json.dumps({"key": key, "beats": [float(b) for b in beats], "downbeats": [float(b) for b in downs]}), encoding="utf-8")
    return np.asarray(beats, float), np.asarray(downs, float)


def load_sounds(info, vid, use):
    """{layer: (tab_sound, recording_sound)} for each stem (the tab's tracks of that kind), or one "mix" layer without stems."""
    folder = aligner.CACHE / info["slug"]
    sub = folder / f"gp-{info['gp_sha']}" / "tracks"
    meta = aligner.read_json(sub / "meta.json")
    if not meta:
        raise FileNotFoundError("The tab's rendered tracks are not saved. Run listen.py again.")
    wav = recording_wav(info, vid)
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


# ---------- harmony: what chord is playing, to tell look-alike note starts apart ----------

def load_harmony(info, seconds):
    """(tab, recording): 12 pitch classes per 23 ms frame, each frame of length 1, the tab moved into the recording's
    key. qa.py keeps them beside the song (qa_env.npz); None when they are missing or are of another tab or video."""
    f = aligner.LISTEN / info["slug"] / "qa_env.npz"
    if not f.exists():
        return None
    d = np.load(f)
    if "rec_c" not in d or str(d["sha"]) != info["gp_sha"] or abs(float(d["length"]) - seconds) > 0.5:
        return None
    unit = lambda c: (c / (np.linalg.norm(c, axis=0) + 1e-9)).astype(np.float32)
    return np.roll(unit(d["tab_c"]), int(info.get("shift") or 0), axis=0), unit(d["rec_c"])


def harmony_matrix(harm, base, edges, lags):
    """[window, lag]: how alike the tab's and the recording's chords are (mean cosine over the window's frames that
    have notes), the recording read at the base sync + lag. Broad where the note starts are sharp: it says which
    of the look-alike peaks (the 8th notes of a strum, a beat away) is the right one."""
    tab, rec = harm
    tt = np.arange(tab.shape[1]) * CHROMA_HOP / RATE
    v0 = base(tt)
    idx = np.minimum(np.searchsorted(tt, edges[:-1]), len(tt) - 1)
    notes = (np.linalg.norm(tab, axis=0) > 0.5).astype(float)
    count = np.maximum(np.add.reduceat(notes, idx), 1)
    H = np.zeros((len(idx), len(lags)))
    for gi, g in enumerate(lags):
        r = rec[:, np.clip(np.rint((v0 + g) * RATE / CHROMA_HOP).astype(int), 0, rec.shape[1] - 1)]
        H[:, gi] = np.add.reduceat(np.sum(tab * r, axis=0) * notes, idx) / count
    return H


# ---------- windows, scores, the path ----------

def beat_pulse(beats, downs, n):
    """The recording's beats (BEAT_OTHER) and bar lines (1) as a soft pulse train on the recording's 5 ms clock."""
    p = np.zeros(n, np.float32)
    for t, w in [(t, BEAT_OTHER) for t in beats] + [(t, 1.0) for t in downs]:
        i = int(round(t / DT))
        if 0 <= i < n:
            p[i] = max(p[i], w)
    s = BEAT_SIGMA / DT
    return np.convolve(p, np.exp(-0.5 * (np.arange(-int(4 * s), int(4 * s) + 1) / s) ** 2).astype(np.float32), "same")


def beat_matrix(pulse, base, bars_t, edges, lags):
    """[window, lag]: how near the tab's bar starts (the recording read at the base sync + lag) fall to the recording's
    bar lines. A strummed song looks the same a beat away in note starts and chords; its bar lines don't."""
    rt = np.arange(len(pulse)) * DT
    v0 = base(bars_t)
    M = np.stack([np.interp(v0 + g, rt, pulse, left=0, right=0) for g in lags], axis=1)  # [bar, lag]
    idx = np.searchsorted(bars_t, edges[:-1] - 1e-6)
    return np.add.reduceat(M, idx, axis=0) / np.diff(np.r_[idx, len(bars_t)])[:, None]


def regular_beats(beats):
    """The recording's beats with the odd missing one put back (a gap of 2 or 3 beats), or None when its beat isn't
    steady (a tempo change, or a tracker that heard half and double time)."""
    b = np.asarray(beats, float)
    if len(b) < 16:
        return None
    g = float(np.median(np.diff(b)))
    out, bad = [float(b[0])], 0
    for t in b[1:]:
        r = (t - out[-1]) / g
        n = int(round(r))
        if n in (1, 2, 3) and abs(r - n) <= 0.2 * n:
            out.extend(out[-1] + (t - out[-1]) * m / n for m in range(1, n))
        else:
            bad += 1
        out.append(float(t))
    return np.array(out) if bad <= GRID_IRREGULAR * len(b) else None


def _beat_times(B, gb, idx):
    """The recording's time at beat number idx (whole numbers; beyond either end the beat goes on at the median gap gb)."""
    nB = len(B)
    return np.where(idx < 0, B[0] + idx * gb, np.where(idx > nB - 1, B[-1] + (idx - (nB - 1)) * gb, B[np.clip(idx, 0, nB - 1)]))


def grid_slips(layers, bars_t, harm, B, gb, pb, b0):
    """How many beats off the one-for-one grid each bar sits (0 mostly). A band may play a short bar the tab writes as a full
    one (Stressed Out, a 2-beat bar at 96 s), and every bar after it is then half a bar off. Per bar and per offset
    (-(pb-1) to pb-1 beats) the notes and chords are compared; the best path pays GRID_SLIP_COST for every change, so only
    a stretch that clearly fits better another way is moved. Bar 1 stays on the grid (b0 chose it)."""
    nb = len(bars_t)
    states = np.arange(-(pb - 1), pb)
    zero = np.zeros(1)
    bar_edges = np.r_[bars_t, bars_t[-1] + np.median(np.diff(bars_t))]
    P, w = np.zeros((nb, len(states))), None
    for si, o in enumerate(states):
        sync = Sync(bars_t, _beat_times(B, gb, b0 + o + pb * np.arange(nb)))
        S, wsum, _ = score_matrix(layers, sync, bar_edges, zero)
        if w is None:
            w = wsum / max(wsum.sum(), 1e-9)
        sim = S[:, 0]
        if harm is not None:
            sim = (sim + HARM * harmony_matrix(harm, sync, bar_edges, zero)[:, 0]) / (1 + HARM)
        P[:, si] = w * sim
    z = int(np.flatnonzero(states == 0)[0])
    best = np.full((nb, len(states)), -np.inf)
    back = np.zeros((nb, len(states)), int)
    best[0, z] = P[0, z]
    for b in range(1, nb):
        top = int(np.argmax(best[b - 1]))
        for si in range(len(states)):
            stay, move = best[b - 1, si], best[b - 1, top] - GRID_SLIP_COST
            best[b, si], back[b, si] = (stay, si) if stay >= move else (move, top)
            best[b, si] += P[b, si]
    path = [int(np.argmax(best[-1]))]
    for b in range(nb - 1, 0, -1):
        path.append(int(back[b, path[-1]]))
    return states[np.array(path[::-1])]


def grid_base(layers, bars_t, per_bar, harm, beats, downs=None):
    """The tab's bars laid one for one on the recording's beat grid: bar i starts on beat b0 + per_bar * i. An official
    tab is the whole song in order, so a steady recording has as many bars as the tab (plus maybe a lead-in or a tail);
    b0 is the one the notes and chords agree with most, less a cost for each bar left without a partner. Only the beats
    the recording's bar lines sit on can start a bar (the first bars decide, else most of them), and bar 1 can't start before the
    recording does or the last bar after it ends. Where the
    windows see too few clear note starts, or the song loops every few bars, this still knows where bar 1 is.
    Returns (Sync, {b0, bar1, runner_up_bars, unmatched, steady}); raises RuntimeError when the grid doesn't apply."""
    if len(set(per_bar)) != 1 or per_bar[0] < 1:
        raise RuntimeError("The tab's bars don't all have the same number of beats, so they can't sit on a beat grid.")
    pb, nb = int(per_bar[0]), len(bars_t)
    B = regular_beats(beats)
    if B is None:
        raise RuntimeError("The recording's beat isn't steady, so its beats can't be the tab's bars.")
    nB, gb = len(B), float(np.median(np.diff(B)))
    if not (0.8 * nb * pb <= nB <= 1.25 * nb * pb + 8 * pb):
        raise RuntimeError(f"The recording has {nB / pb:.0f} bars and the tab {nb}: no one-for-one grid.")
    edges = windows(bars_t)
    zero = np.zeros(1)
    rec_len = len(next(iter(layers.values()))[1]) * DT
    phase = None
    if downs is not None and len(downs) >= 4:  # which beat of the recording's grid its bar lines sit on (mod beats per bar)
        at = (np.abs(B[None, :] - np.asarray(downs)[:, None]).argmin(1)) % pb
        votes = np.bincount(at, minlength=pb)
        if len(set(at[:6])) == 1:  # the first bars decide: a band may drop or add a beat later (Stressed Out has a 2-beat bar at 96 s), the beats go on
            phase = int(at[0])
        elif votes.max() >= 0.7 * votes.sum():
            phase = int(votes.argmax())
    results = []
    for b0 in range(min(-2 * pb, nB - nb * pb - 2 * pb), max(2 * pb, nB - nb * pb + 2 * pb) + 1):
        if phase is not None and b0 % pb != phase:
            continue
        idx = b0 + pb * np.arange(nb)
        v = _beat_times(B, gb, idx)
        if v[0] < -0.3 or v[-1] > rec_len - 0.3:
            continue
        sync = Sync(bars_t, v)
        S, wsum, _ = score_matrix(layers, sync, edges, zero)
        w = wsum / max(wsum.sum(), 1e-9)
        sim = float(np.sum(w * S[:, 0]))
        if harm is not None:
            sim = (sim + HARM * float(np.sum(w * harmony_matrix(harm, sync, edges, zero)[:, 0]))) / (1 + HARM)
        out_of_range = int(np.sum((idx < 0) | (idx > nB - 1)))
        unmatched = out_of_range + (max(0, b0) + max(0, nB - (b0 + nb * pb))) / pb
        results.append((sim - GRID_UNMATCHED * unmatched / nb, b0, v, unmatched))
    if not results:
        raise RuntimeError("No place for the tab on the recording's beat grid.")
    results.sort(key=lambda r: -r[0])
    best = results[0]
    if best[3] > GRID_MAX_UNMATCHED:
        raise RuntimeError(f"The best place leaves {best[3]:.0f} bars without a partner: the tab and the recording aren't the same length.")
    other = next((r for r in results[1:] if abs(r[1] - best[1]) >= pb), None)
    offs = grid_slips(layers, bars_t, harm, B, gb, pb, best[1])
    v = _beat_times(B, gb, best[1] + offs + pb * np.arange(nb))
    score = _scorer(layers)
    shifts = np.arange(-GRID_SHIFT_S, GRID_SHIFT_S + 1e-9, 0.005)
    d = float(shifts[int(np.argmax([score(bars_t, v + dd) for dd in shifts]))])
    slips = [(int(b), int(offs[b] - offs[b - 1])) for b in range(1, nb) if offs[b] != offs[b - 1]]
    return Sync(bars_t, v + d), {"b0": best[1], "bar1": float(v[0] + d), "shift": d, "unmatched": best[3], "score": best[0],
                                 "runner_up": None if other is None else {"b0": other[1], "score": other[0]},
                                 "slips": slips, "plain": best[2] + d}


def grid_result(bars_t, grid, info, file_sync):
    """The grid as a sync: the beat tracker's bar times, smoothed by a piecewise-linear line over the bar number (a few
    knots, where a stretch of bars stays off the line by more than GRID_TOL; the tab's own tempo is no part of it). The
    windows don't get to bend it: where the tab differs from the recording they see nothing, and the grid is the structure."""
    t0 = time.time()
    v_all = np.asarray(grid(bars_t), float)
    v = np.asarray(info.get("plain", v_all), float)  # the smooth line is drawn through the bars as if none were short or long
    n = len(v)
    i, w = np.arange(n, dtype=float), np.ones(n)
    knots = [0.0, float(n - 1)]
    for _ in range(20):
        sol, fit = pw_fit(i, v, w, np.array(knots))
        res = v - fit
        sm = np.array([np.median(res[max(0, j - 1):j + 2]) for j in range(n)])
        pick = next((int(j) for j in np.argsort(-np.abs(sm)) if abs(sm[j]) > GRID_TOL and all(abs(j - k) >= 4 for k in knots)), None)
        if pick is None:
            break
        knots = sorted(knots + [float(pick)])
    sol, fit = pw_fit(i, v, w, np.array(knots))
    slips = info.get("slips") or []
    delta = v_all - v  # what the slips move each bar by: one level per stretch between slips (the beats' own jitter is not a tempo change)
    for lo, hi in zip([0] + [c for c, _ in slips], [c for c, _ in slips] + [n]):
        delta[lo:hi] = np.median(delta[lo:hi])
    sync = Sync(bars_t, fit + delta)
    ks = [int(k) for k in knots]
    dur = np.diff(bars_t)
    tab_changes = [j + 1 for j in range(len(dur) - 1) if abs(dur[j + 1] / dur[j] - 1) > 0.03]  # the tab's own tempo changes: the video's per-bar tempo doesn't
    at_slip = {b for c, _ in slips for b in (c - 1, c)}  # the short bar and the bar after it: the video's speed changes there because the recording's bar has other beats than the tab's
    return {"start_moved": float(sync(bars_t[0]) - float(file_sync(bars_t[0]))), "ending_gain": None, "points": _points(sync, bars_t), "base": file_sync, "sync": sync,
            "knots": np.array([bars_t[k] for k in ks]), "sections": sorted(set(ks[1:-1]) | set(tab_changes) | at_slip),
            "slopes": np.diff(fit[ks]) / np.diff(bars_t[ks]), "bars_t": bars_t, "seconds": round(time.time() - t0, 1), "edges": [], "windows": [], "grid": info}


def wide_start(layers, bars_t, base, harm, pulse):
    """Where the tab starts, searched over +-START_RANGE_S instead of 1.5 s: an intro the file's start didn't know about
    (a recording with 10 s of pad before the band, a tab without it) puts every window the same few bars off. The same
    evidence as the main fit, on a coarse lag grid; then the straight line (offset and slope, the recording's tempo up to
    START_SLOPE off the tab's) that collects the most of it over the whole song. A line, not a path: many windows of a
    real song have no clear place, and a path wanders onto whatever dense stretch of the recording looks like anything.
    Adopted only when it beats the best line that stays within 1.5 s of the file's start by START_GAIN (mean z per window)
    and is off by at least START_MIN s. Returns (base, median shift s, gain)."""
    edges = windows(bars_t)
    step = START_STEP * DT
    lags = np.arange(-START_RANGE_S, START_RANGE_S + 1e-9, step)
    S, wsum, centre = score_matrix(layers, base, edges, lags)
    Z = zscore(S, wsum)
    if harm is not None:
        Z = Z + HARM * zscore(harmony_matrix(harm, base, edges, lags), wsum)
    if pulse is not None:
        Z = Z + BEAT_W * zscore(beat_matrix(pulse, base, bars_t, edges, lags), wsum)
    live = wsum > 1e-6
    if live.sum() < 4:
        return base, 0.0, 0.0
    Zl, c0 = Z[live], centre[live][0]
    c = centre[live] - c0
    rows = np.arange(len(c))[None, :]
    best = near = (-1e9, 0.0, 0.0)  # (score, offset at the first window, slope)
    for slope in np.arange(-START_SLOPE, START_SLOPE + 1e-9, 0.005):
        lag = lags[:, None] + slope * c[None, :]  # [offset, window]
        idx = np.rint((lag - lags[0]) / step).astype(int)
        inside = (idx >= 0) & (idx < len(lags))
        score = np.where(inside, Zl[rows, np.clip(idx, 0, len(lags) - 1)], -2.0).sum(1) - START_COST * np.abs(lag).sum(1)
        i = int(np.argmax(score))
        if score[i] > best[0]:
            best = (float(score[i]), float(lags[i]), float(slope))
        ok = (np.abs(lags) <= RANGE_S) & (np.abs(lags + slope * c[-1]) <= RANGE_S)
        if ok.any():
            j = int(np.argmax(np.where(ok, score, -1e18)))
            if score[j] > near[0]:
                near = (float(score[j]), float(lags[j]), float(slope))
    gain = (best[0] - near[0]) / len(c)
    shift = float(np.median(best[1] + best[2] * c))
    if abs(shift) < START_MIN or gain < START_GAIN:
        return base, 0.0, gain
    t = np.r_[edges[0], centre[live], edges[-1]]
    return Sync(t, base(t) + best[1] + best[2] * (t - c0)), shift, gain


def windows(bars_t):
    edges = [float(bars_t[0])]
    for t in bars_t[1:]:
        if t - edges[-1] >= WINDOW_S:
            edges.append(float(t))
    end = float(bars_t[-1] + np.median(np.diff(bars_t)))
    if end - edges[-1] < WINDOW_S and len(edges) > 1:  # a short last window is noise (Ho Hey's last bar voted -225 ms): join it to the one before
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


def viterbi(Z, lam, reach):
    """The path of lags (one per window) with the most evidence, paying lam per bin the lag moves between windows, and
    never moving more than reach[w] bins into window w (a band's tempo changes by a few %, not by half a beat in one step)."""
    W, G = Z.shape
    best, back = np.zeros((W, G)), np.zeros((W, G), int)
    best[0] = Z[0]
    for w in range(1, W):
        L = min(int(reach[w]), G - 1)
        f, src = np.full(G, -np.inf), np.zeros(G, int)
        for s in range(-L, L + 1):  # from lag g - s in the window before to lag g in this one
            lo, hi = max(0, s), min(G, G + s)
            cand = best[w - 1][lo - s:hi - s] - lam * abs(s)
            better = cand > f[lo:hi]
            f[lo:hi] = np.where(better, cand, f[lo:hi])
            src[lo:hi] = np.where(better, np.arange(lo, hi) - s, src[lo:hi])
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


def choose_knots(t, v, w, bars_t, ending=False):
    """Straight line first; a knot (a tempo change) only where a stretch of windows stays off it, at the nearest bar line."""
    knots = [float(bars_t[0]), float(bars_t[-1])]
    sol, _ = pw_fit(t, v, w, np.array(knots))
    s0 = float((np.diff(sol) / np.diff(knots))[0])
    plausible = lambda kn, sl: bool(np.all(np.abs(np.diff(sl) / np.diff(kn) / s0 - 1) <= TEMPO_PCT / 100))
    clear = w >= NEED_Z - FLOOR_Z
    for _ in range(12):  # 1. the strict pass: each stretch needs two clear windows of its own
        sol, fit = pw_fit(t, v, w, np.array(knots))
        res = np.where(w > 0, v - fit, 0.0)
        sm = np.array([np.median(res[max(0, i - 1):i + 2]) for i in range(len(res))])  # a lone window can't make a knot
        for i in np.argsort(-np.abs(sm)):
            if abs(sm[i]) <= KNOT_TOL:
                break
            k = float(bars_t[int(np.argmin(np.abs(bars_t - t[i])))])
            trial = sorted(knots + [k])
            if not all(abs(k - x) >= KNOT_GAP for x in knots):
                continue
            support = [int(np.sum((t >= a) & (t <= b) & clear)) for a, b in zip(trial[:-1], trial[1:])]
            sol_t, _ = pw_fit(t, v, w, np.array(trial))
            if min(support) >= 2 and plausible(np.array(trial), sol_t):  # two clear windows to stand on, and a speed a band could play
                knots = trial
                break
        else:
            break
        if abs(sm[i]) <= KNOT_TOL:
            break
    sol, fit = pw_fit(t, v, w, np.array(knots))
    # 2. the ending: a band slows down in the last bars, where there are few clear windows and the long steady middle
    # before them has none of its own. The middle stays exactly as it is; the last stretch gets one more knot, on the
    # line, and its own end value from the windows after it. Only the bar line that fits them best, and only if it buys a lot.
    res = np.where(w > 0, v - fit, 0.0)
    sm = np.array([np.median(res[max(0, i - 1):i + 2]) for i in range(len(res))])
    last = knots[-1]
    if ending and np.abs(sm[t >= knots[-2]]).max() > KNOT_TOL:
        best = None
        for k in map(float, bars_t):
            if not (knots[-2] + KNOT_GAP <= k <= last - KNOT_GAP):
                continue
            m = (t >= k) & (t <= last)
            if clear[m].sum() < 2:
                continue
            yk = float(np.interp(k, knots, sol))
            x = (t[m] - k) / (last - k)
            y = yk + float(np.sum(w[m] * x * (v[m] - yk)) / np.sum(w[m] * x * x))
            after = v[m] - (yk + (y - yk) * x)
            gain = float(np.sum(w[m] * ((v[m] - fit[m]) ** 2 - after ** 2)))
            coherent = bool(np.all(np.abs(after[clear[m]]) <= KNOT_TOL))  # every clear window after the knot agrees with the one new line (a lone alias doesn't)
            if gain >= KNOT_GAIN and coherent and plausible(np.array([k, last]), np.array([yk, y])) and (best is None or gain > best[0]):
                best = (gain, k, yk, y)
        if best:
            knots, sol = knots[:-1] + [best[1], last], np.r_[sol[:-1], best[2], best[3]]
    return np.array(knots), np.asarray(sol)


def _scorer(layers):
    """score(knots, video times): the tab's note starts against the recording's over the whole song, every layer."""
    n = min(len(a) for a, _ in layers.values())
    t = np.arange(n) * DT
    tabs = {k: (a[:n] - a[:n].mean()) / (a[:n].std() + 1e-9) for k, (a, _) in layers.items()}
    rts = {k: np.arange(len(rec)) * DT for k, (_, rec) in layers.items()}

    def score(knots, vv):
        v = Sync(knots, vv)(t)
        total = 0.0
        for k, (_, rec) in layers.items():
            r = np.interp(v, rts[k], rec, left=0, right=0)
            total += float(np.mean(tabs[k] * (r - r.mean()) / (r.std() + 1e-9)))
        return total
    return score


def refine(layers, knots, vals, reach=REFINE_S):
    """The knots' video times tuned against the whole song at once: the tab's note starts against the recording's,
    every layer, as one correlation over all of it (the windows only found the structure; a window alone is noisy,
    the whole song is not). A pattern search, 20 ms down to 1 ms steps, each knot moving at most `reach` from where
    the windows put it."""
    score = _scorer(layers)
    vals = np.asarray(vals, float)
    start, cur = vals.copy(), vals.copy()
    best = score(knots, cur)
    for step in (0.020, 0.008, 0.003, 0.001):
        moved = True
        while moved:
            moved = False
            for k in range(len(cur)):
                for d in (-step, step):
                    trial = cur.copy()
                    trial[k] = float(np.clip(trial[k] + d, start[k] - reach, start[k] + reach))
                    if trial[k] != cur[k] and (sc := score(knots, trial)) > best + 1e-6:
                        cur, best, moved = trial, sc, True
    return cur


def polish_ending(layers, knots, vals, bars_t):
    """A band slows down (or rushes) in the last bars, where the windows are too few to see it. Tried against the whole
    song: a new knot at each bar line in the last END_REACH_S, on the line, with the last bar line's video time searched
    from 150 ms early to 400 ms late; kept when the song's note starts agree END_GAIN more. Returns (knots, vals, gain)."""
    score = _scorer(layers)
    knots, vals = np.array(knots, float), np.array(vals, float)
    s0 = (vals[-1] - vals[0]) / (knots[-1] - knots[0])
    base = score(knots, vals)
    best = (0.0, None)
    last = knots[-1]
    for k in map(float, bars_t):
        if not (last - END_REACH_S <= k <= last - 4) or k <= knots[-2] + 4:
            continue
        if np.any(np.isclose(knots, k, atol=1e-6)):
            continue
        yk = float(np.interp(k, knots, vals))
        for dy in np.arange(-0.15, 0.40 + 1e-9, 0.010):
            kn = np.r_[knots[:-1], k, last]
            vv = np.r_[vals[:-1], yk, vals[-1] + dy]
            sl = np.diff(vv) / np.diff(kn)
            if np.any(np.abs(sl / s0 - 1) > TEMPO_PCT / 100) or dy == 0:
                continue
            g = score(kn, vv) - base
            if g > best[0]:
                best = (g, (kn, vv))
    if best[1] is not None and best[0] >= END_GAIN:
        return best[1][0], best[1][1], best[0]
    return knots, vals, best[0]


def polish(layers, knots, vals, bars_t, reach=POLISH_S):
    """The tempo changes where the whole song puts them. A window is 5 s wide, so a knot lands on the bar line nearest
    the windows' middle, which can be a few bars off the real change: the line is right on both sides and wrong in
    between (the benchmark's +3 % stretch ended 3 s late, 99 ms off). Each inner knot is tried at every bar line
    within `reach`, with its video time searched +-POLISH_DY, and kept where the whole song's note starts agree most."""
    if reach <= 0 or len(knots) < 3:
        return np.asarray(knots, float), np.asarray(vals, float)
    score = _scorer(layers)
    knots, vals = np.array(knots, float), np.array(vals, float)
    s0 = (vals[-1] - vals[0]) / (knots[-1] - knots[0])
    best = score(knots, vals)
    dys = np.arange(-POLISH_DY, POLISH_DY + 1e-9, 0.010)
    for _ in range(2):
        moved = False
        for i in range(1, len(knots) - 1):
            for k in map(float, bars_t):
                if abs(k - knots[i]) > reach or not (knots[i - 1] + 2 < k < knots[i + 1] - 2):
                    continue
                y0 = float(np.interp(k, knots, vals))
                for dy in dys:
                    kn, vv = knots.copy(), vals.copy()
                    kn[i], vv[i] = k, y0 + dy
                    sl = np.diff(vv) / np.diff(kn)
                    if np.any(np.abs(sl / s0 - 1) > TEMPO_PCT / 100) or (k == knots[i] and dy == 0):
                        continue
                    if (sc := score(kn, vv)) > best + 1e-6:
                        knots, vals, best, moved = kn, vv, sc, True
        if not moved:
            break
    return knots, vals


# ---------- one song ----------

_CACHE = {}  # (song, video, layers) -> the curves: a fixer that tries many starting points reads the sound once


def get_curves(info, vid, use):
    key = (info["slug"], vid, tuple(sorted(use or ())))
    if key not in _CACHE:
        _CACHE[key] = {k: (curves(ts)[1], curves(rs)[1]) for k, (ts, rs) in load_sounds(info, vid, use).items()}
    return _CACHE[key]


def fit_core(layers, bars_t, base, harm=None, rng=RANGE_S, ending=False, beats=None):
    """The fit on arrays: curves per layer {name: (tab, recording)}, the tab's bar start times, the starting sync, and the
    harmony (or None), and the recording's bar lines as a beat_pulse (or None). fit_song reads them from a saved song;
    the truth benchmark builds them."""
    t0 = time.time()
    edges = windows(bars_t)
    lags = np.arange(-rng, rng + 1e-9, DT)
    base0 = base
    base, start_moved, _ = wide_start(layers, bars_t, base, harm, beats) if START_RANGE_S > 0 and harm is not None else (base, 0.0, 0.0)  # note starts alone find dense stretches of the recording that look like anything
    for attempt in range(4):
        S, wsum, centre = score_matrix(layers, base, edges, lags)
        Z = zscore(S, wsum)
        if harm is not None:  # the chords too: a window whose note starts have look-alike peaks, or too few, still has a clear place
            Z = Z + HARM * zscore(harmony_matrix(harm, base, edges, lags), wsum)
        if beats is not None:  # and the recording's bar lines: the tab's bar starts should sit on them
            Z = Z + BEAT_W * zscore(beat_matrix(beats, base, bars_t, edges, lags), wsum)
        mid = (edges[:-1] + edges[1:]) / 2
        reach = np.r_[0, np.ceil(LAG_STEP_PCT / 100 * np.diff(mid) / DT)]  # bins the lag may move from one window to the next
        Zp = Z - LAG_COST * np.abs(lags)[None, :] * (wsum > 1e-6)[:, None]  # a strummed song looks the same one beat away: when two lags score alike, the one nearer the file's sync wins
        path = viterbi(Zp, LAMBDA, reach)
        g = np.array([(parabola(S[w], i) - (len(lags) - 1) / 2) * DT for w, i in enumerate(path)])
        z = np.array([Z[w, i] for w, i in enumerate(path)])
        keep = (wsum > 1e-6) & (z >= FLOOR_Z)  # every window with some evidence, each weighed by how clear it is
        pooled = Z.sum(0) / np.sqrt(max(1, int((wsum > 1e-6).sum())))  # every window's score at one lag, added: a song whose windows each see a weak peak at the same lag shows up here
        if (keep & (z >= NEED_Z)).sum() < 3 and pooled.max() < POOLED_Z:
            raise RuntimeError("There are too few clear note starts to line the tab up on.")
        t, v = centre[keep], base(centre[keep]) + g[keep]
        knots, sol = choose_knots(t, v, np.clip(z[keep] - FLOOR_Z, 0.1, 7), bars_t, ending)
        sync = Sync(knots, sol)
        if attempt == 3 or not (np.abs(g[keep]) >= rng - 0.3).any():
            break
        base = sync  # a lag ran towards the edge of the search (the file's sync drifts far): look again round the line just found
    sol = refine(layers, knots, sol)
    knots, sol = polish(layers, knots, sol, bars_t)
    end_gain = None
    if ending:
        knots, sol, end_gain = polish_ending(layers, knots, sol, bars_t)
        knots, sol = polish(layers, knots, sol, bars_t)
    sol = refine(layers, knots, sol, reach=0.02)
    sync = Sync(knots, sol)
    return {"start_moved": start_moved, "ending_gain": end_gain, "points": _points(sync, bars_t), "base": base0, "sync": sync, "knots": knots,
            "sections": [int(np.argmin(np.abs(bars_t - k))) for k in knots[1:-1]],  # the bars where the tempo changes (0-based)
            "slopes": np.diff(sol) / np.diff(knots), "bars_t": bars_t, "seconds": round(time.time() - t0, 1),
            "edges": [int(i) for i, p in enumerate(path) if keep[i] and (p <= 1 or p >= len(lags) - 2)],
            "windows": [{"from": float(edges[w]), "lag_ms": round(1000 * float(g[w])), "z": round(float(z[w]), 1), "used": bool(keep[w] and z[w] >= NEED_Z)}
                        for w in range(len(g))]}


def fit_song(slug, base_file=None, base_points=None, use=None, rng=RANGE_S, say=print, ending=False, harmony=False, bars=False, grid=False):
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
    harm = load_harmony(info, len(next(iter(layers.values()))[1]) * DT) if harmony else None
    if harmony and harm is None:
        raise RuntimeError("The harmony isn't saved for this song (qa.py makes it).")
    grid_info = None
    if grid:  # the tab's bars on the recording's beat grid: where bar 1 is, however few clear note starts there are
        try:
            beats, gdowns = load_beats(info, vid)
        except Exception as e:
            raise RuntimeError(f"The recording's beats can't be found ({e}).")
        gh = harm or load_harmony(info, len(next(iter(layers.values()))[1]) * DT)
        file_sync = base
        base, grid_info = grid_base(layers, bars_t, [b[2] for b in info["bars"]], gh, beats, gdowns)
        r = grid_result(bars_t, base, grid_info, file_sync)
        r["slug"], r["seconds"] = slug, round(time.time() - t0, 1)
        return r
    pulse = downs = None
    if bars:  # the recording's bar lines: evidence for each window, and a search for the start over the whole song
        try:
            beats, downs = load_beats(info, vid)
        except Exception as e:  # no Beat This!, or the recording can't be read: the other tries still run
            raise RuntimeError(f"The recording's bar lines can't be found ({e}).")
        slope = (float(base(bars_t[-1])) - float(base(bars_t[0]))) / (bars_t[-1] - bars_t[0])
        per = float(np.median(np.diff(downs)) / (np.median(np.diff(bars_t)) * slope)) if len(downs) > 3 else 0.0
        if abs(np.log(max(per, 1e-3))) > 0.10:  # How Great Is Our God's tab is in 2/4 and the band in 4/4: half the tab's bars start mid-bar
            raise RuntimeError(f"The tab's bars aren't the recording's bars (the recording's bar is {per:.2f} of the tab's), so its bar lines can't vote.")
        pulse = beat_pulse(beats, downs, len(next(iter(layers.values()))[1]))
    r = fit_core(layers, bars_t, base, harm, rng, ending, pulse)
    r["slug"], r["seconds"] = slug, round(time.time() - t0, 1)
    return r


def entry_base0(entry, bars_t, base_points=None):
    pts = base_points or entry["syncPoints"]
    return Sync([bars_t[p] for p, _ in pts], [ms / 1000 for _, ms in pts])


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
        for label, worse, harmony in (("from the line-up", False, False), ("from a bad start", True, False),
                                      ("from the line-up + harmony", False, True), ("from a bad start + harmony", True, True)):
            pts = aligner.read_json(before)["songs"][0]["syncPoints"]
            if worse:
                pts = [[p, int(round(ms * 1.005 + 400))] for p, ms in pts]
            try:
                r = fit_song(slug, base_file=before, base_points=pts, use=use, harmony=harmony, say=lambda *a: None)
            except RuntimeError as e:
                print(f"  skipped {case:9} {label}: {e}")
                continue
            truth = delay + factor * r["bars_t"]
            err = np.array([ms / 1000 - truth[p] for p, ms in r["points"]]) * 1000
            good = bool(np.abs(err).max() <= PASS_MS)
            ok, total = ok + good, total + 1
            print(f"  {'PASS' if good else 'FAIL'} {case:9} {label:27}: median {np.median(err):+.1f} ms, worst {np.abs(err).max():.1f} ms "
                  f"({len(r['knots']) - 2} tempo changes, {r['seconds']} s)")
    print(f"{ok} of {total} right (every bar within {PASS_MS} ms)")
    return ok == total


def run(slug, use=None, rng=RANGE_S, check=False, verbose=False, accept_start=False):
    """Line the song up, judge it, and write the bar times when they are better than the file's (never worse).
    The verdict of the sync the song has afterwards. Used by main() and by listen.py (every new song)."""
    import fixsync  # the gate and the rule for what is better (they need the yt2gp5 Python)
    import qa
    s = qa.load(aligner.read_json(aligner.LISTEN / slug / "info.json")["name"])
    old = qa.judge(s)
    print(f"  {old['verdict']:6} the file's sync: {len(old['fails'])} fails, {len(old['listen'])} listens, {fixsync.score(old)[2]} bars drift")
    fb = aligner.fretboard_of(aligner.LISTEN / slug)
    first = fb.with_name(fb.name + ".before-wavefit")  # a second run starts from the file as it was before wavefit first wrote it, so it gives the same answer
    start = first if first.exists() else None
    tried = []
    results = []
    best = None  # the steady fit first; the one with an ending knot only if the gate likes it better (an ending is too few windows to trust alone)
    for name, ending, harmony, bars, grid in (("wavefit", False, False, False, False), ("wavefit + ending", True, False, False, False),
                                              ("wavefit + harmony", False, True, False, False), ("wavefit + harmony + ending", True, True, False, False),
                                              ("wavefit + bars + harmony", False, True, True, False), ("wavefit + bars + harmony + ending", True, True, True, False),
                                              ("wavefit + grid", False, True, False, True)):
        try:
            r = fit_song(slug, base_file=start, use=use, rng=rng, ending=ending, harmony=harmony, bars=bars, grid=grid, say=print if not (ending or harmony or bars or grid) else (lambda *x: None))
        except RuntimeError as e:  # too few note starts to go on: the file's own sync stays (the harmony tries may still find a place)
            print(f"  {name} left out: {e}")
            continue
        if ending and best and any(list(r["knots"]) == list(b["knots"]) for b in tried if (b["harmony"], b["bars"], b["grid"]) == (harmony, bars, grid)):
            continue
        tried.append({"knots": r["knots"], "harmony": harmony, "bars": bars, "grid": grid})
        if not (ending or harmony or bars or grid):
            show(r, verbose)
        else:
            if r.get("grid"):
                g = r["grid"]
                print(f"  {name}: the tab's bars on the recording's beats: bar 1 on beat {g['b0']:+d} = {g['bar1']:.2f} s, {g['unmatched']:.1f} bars without a partner")
            elif r.get("start_moved"):
                print(f"  {name}: the start moved {r['start_moved']:+.1f} s")
            print("  with an ending knot: " + ", ".join(f"{k0:.0f}-{k1:.0f}s {100 / sl:.2f}%" for k0, k1, sl in zip(r["knots"][:-1], r["knots"][1:], r["slopes"])))
        v = qa.judge({**s, "sections": r["sections"]}, points=r["points"])
        print(f"  {v['verdict']:6} {name}: {len(v['fails'])} fails, {len(v['listen'])} listens, {fixsync.score(v)[2]} bars drift")
        for x in v["fails"] + v["listen"]:
            print(f"           {x[:150]}")
        results.append((name, r, v))
        if best is None or fixsync.score(v) < fixsync.score(best[2]):
            best = (name, r, v)
    if best is None:
        return old
    hard_of = lambda v: [f for f in v["fails"] if not f.startswith(("steady:", "match:"))]  # a drifting stretch or "this tab differs" is the same whatever the clock; a bad lock, a jump or a backwards sync is not
    on_grid = [t for t in results if t[1].get("grid") and not hard_of(t[2])]
    if on_grid:  # the beat grid knows where bar 1 is when the tries that start from the file's start don't (the gate counts stretches, it can't see a bar 1 two bars late)
        g = min(on_grid, key=lambda t: fixsync.score(t[2]))
        if abs(g[1]["points"][0][1] - best[1]["points"][0][1]) > 1000 and fixsync.RANK[g[2]["verdict"]] <= fixsync.RANK[best[2]["verdict"]]:
            print(f"  the beat grid puts bar 1 at {g[1]['points'][0][1] / 1000:.2f} s, {best[0]} at {best[1]['points'][0][1] / 1000:.2f} s: the grid is kept")
            best = g
    name, r, new = best
    better = fixsync.score(new) < fixsync.score(old)
    moved = r.get("start_moved")
    hard = hard_of(new)
    if moved and abs(moved) >= START_MIN and not better and not hard and (accept_start or fixsync.score(new)[2] <= fixsync.score(old)[2]):  # the file started seconds from where the sound says: its verdict is no fair yardstick (the gate can't tell a wrong start from an intro it lists), so a fit with no hard fail replaces it
        print(f"  the file started {abs(moved):.1f} s from where the sound puts the tab, so its verdict isn't a fair yardstick; {name} has no hard fail")
        better = True
    if better and not check:
        out = aligner.save(slug, r["points"], f"{name}: {old['verdict']} -> {new['verdict']}", by="wavefit", sections=r["sections"])
        print(f"{name} is better, written: {out['file']} (the first version is {out['backup']}); import it in Fretboard with Replace it")
        return new
    print("not better than the file's sync, so nothing is written" if not better else f"{name} is better (--check: nothing written)")
    return old


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", nargs="?", default="")
    ap.add_argument("--check", action="store_true", help="judge and print only; the .fretboard file stays as it is")
    ap.add_argument("--accept-start", action="store_true", help="write a fit that moves the start by seconds even when the gate counts more drifting bars than for the file (the file's start is wrong, "
                    "so its verdict says little); the backup .before-wavefit is kept, and a person should listen")
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
    v = run(slug, use=use, rng=a.range, check=a.check, verbose=a.verbose, accept_start=a.accept_start)
    sys.exit(0 if v["verdict"] == "PASS" else 2 if v["verdict"] == "LISTEN" else 3)


if __name__ == "__main__":
    main()
