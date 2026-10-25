"""How well a song's sync fits its recording, note by note: measured, fixed from the recording's beats, and drawn.

    python tests/yt2gp5/syncqa.py NAME           measure, put the song on one steady tempo, write the report
    python tests/yt2gp5/syncqa.py NAME --fit     fit every bar to the recording instead (only when the user asks)
    python tests/yt2gp5/syncqa.py NAME --check   measure and report only (the .fretboard file stays as it is)
    python tests/yt2gp5/syncqa.py NAME --one     one tempo even when it drifts (no tempo per section)

When one tempo drifts, one tempo per section of the tab is tried (the user asked, 2026-10-24) and kept when it
drifts less and the note starts don't get worse.

listen.py --export runs the fix by itself, so a song comes out lined up with no hands on.

Run listen.py NAME first (it lines the tab up and writes <title>.fretboard). The sync is measured as Fretboard
plays it: each bar starts where the .fretboard file says, with straight lines between. Bar by bar:

  beats   the tab's beats against the beats Beat This! hears in the recording (ms early or late)
  notes   every note start in the tab against the nearest note start heard in the recording (ms)
  tempo   each bar's speed in the video (BPM): a song played to a click is a flat line, so a wobble is a sync error
  pitch   how strongly each note's pitch sounds in the recording, next to how strongly it sounds in the tab itself.
          A note that is clear in the tab but missing from the recording is a wrong note (or a part the band
          doesn't play there)
  chords  how alike the recording's and the tab's harmony are in each bar (1 = the same)

The default (the user's choice, 2026-10-24): one tempo for the whole song and the right start, nothing
stretched. The line starts from the audio line-up and is tuned so the tab's sound (all tracks) lines up best with
the recording over the whole song. "whole song off" checks it: how far the whole tab would have to move to line
up best (0 is right; the bar and note checks can't see a half-beat slip in a strummed song). Bar fitting moved single bars and made the tab speed up and
slow down for no reason (Be My Escape bars 92 and 93).

--fit moves each bar to where the recording's beats say it starts, when its beats agree with each other (to
30 ms); bars without clear beats follow their neighbours. Two passes, so a bar that was a long way off is caught.
Then the bar lines: a bar that sits a beat or more away from the recording's nearest bar line (its downbeat) is
put on it, when the downbeats agree with the bars that are already right. Bars may then differ in length, as
they do in the recording. A bar whose stretch of the recording holds a different number of beats than the tab's
bar (an extra beat, a 3/4 bar in a 4/4 tab) is listed as not matching: no timing can fix that, the tab differs.

Writes out/listen/<song>/sync_report.html (the charts), sync.json (every number), the fixed <title>.fretboard
and the one before it as <title>.fretboard.before. Nothing here is committed: the recordings are not ours.
"""
import html
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import listen  # noqa: E402
import real  # noqa: E402
import run  # noqa: E402
import songdb  # noqa: E402

SR = 22050
HOP = 220      # onset frames: 10 ms
C_HOP = 512    # chroma frames: 23 ms
NOTE_WIN = 0.08   # a note start heard within this of the tab's (s)
UNPITCHED = ("drums",)
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


class Sync:
    """Tab time (s) → video time (s): each bar's start from the .fretboard file, straight lines between,
    and the tab's own tempo before the first and after the last."""

    def __init__(self, tab_x, video_y):
        self.x, self.y = np.asarray(tab_x, float), np.asarray(video_y, float)

    @classmethod
    def from_points(cls, bars_tab, points):
        return cls([bars_tab[p] for p, _ in points], [ms / 1000 for _, ms in points])

    def __call__(self, t):
        t = np.asarray(t, float)
        v = np.interp(t, self.x, self.y)
        v = np.where(t < self.x[0], self.y[0] - (self.x[0] - t), v)
        return np.where(t > self.x[-1], self.y[-1] + (t - self.x[-1]), v)


def recording_beats(wav, out):
    """The recording's beats and bar lines (downbeats), in seconds."""
    f = out / "beats.json"
    if f.exists():
        d = json.loads(f.read_text(encoding="utf-8"))
        return np.array(d["beats"]), np.array(d.get("downbeats", []))
    import torch
    from beat_this.inference import File2Beats
    print("finding the recording's beats (Beat This!)...")
    beats, downbeats = File2Beats(device="cuda" if torch.cuda.is_available() else "cpu", dbn=False)(str(wav))
    f.write_text(json.dumps({"beats": [float(b) for b in beats], "downbeats": [float(b) for b in downbeats]}), encoding="utf-8")
    return np.asarray(beats, float), np.asarray(downbeats, float)


def tab_mix(song, info):
    """The whole tab (every track rendered by Fretboard's synth, as listen.py did), in tab time, mono at SR."""
    import librosa
    folder = real.CACHE / run.slug(song["name"]) / f"gp-{info['gp_sha']}" / "tracks"
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    mix = None
    for t in meta["tracks"]:
        y = np.fromfile(folder / f"track{t['index']}.f32", dtype=np.float32).reshape(-1, 2).mean(axis=1)
        if mix is None:
            mix = y
        else:
            n = max(len(mix), len(y))
            mix = np.pad(mix, (0, n - len(mix))) + np.pad(y, (0, n - len(y)))
    return librosa.resample(mix, orig_sr=meta["rate"], target_sr=SR)


def chroma(y):
    import librosa
    return librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=C_HOP)


def tab_bars(info, notes):
    """Every played bar: tab start, tab end, beats."""
    starts = [b[0] for b in info["bars"]]
    out = []
    for p, b in enumerate(info["bars"]):
        beat = 60 / notes["bars"][p].get("bpm", 120) * 4 / notes["bars"][p].get("den", 4)
        end = starts[p + 1] if p + 1 < len(starts) else b[0] + b[2] * beat
        out.append((b[0], end, b[2]))
    return out


def measure(sync, bars, beats, env, rec_c, tab_c, notes_tab, tracks, shift):
    """Everything per bar and per note for one sync."""
    env_t = np.arange(len(env)) * HOP / SR
    per_bar = []
    for p, (s, e, n) in enumerate(bars):
        vs, ve = float(sync(s)), float(sync(e))
        bd = (ve - vs) / max(1, n)
        errs = []
        for k in range(n):
            v = vs + k * bd
            j = np.searchsorted(beats, v)
            near = [beats[i] for i in (j - 1, j) if 0 <= i < len(beats)]
            if near:
                d = min(near, key=lambda b: abs(b - v)) - v
                if abs(d) < 0.4 * bd:
                    errs.append(d)
        heard = int(np.sum((beats >= vs) & (beats < ve)))
        per_bar.append({"bar": p, "video": round(vs, 3), "recording_beats": heard, "bpm": round(60 * n / max(1e-3, ve - vs), 1),  # as heard: its beats over its length in the video
                        "beat_ms": round(1000 * float(np.median(errs)), 1) if errs else None,
                        "beat_spread_ms": round(1000 * float(np.median(np.abs(np.array(errs) - np.median(errs)))), 1) if len(errs) > 1 else None,
                        "beats_heard": len(errs), "beats": n})
    # notes: start time error and pitch
    starts = sorted({round(x["start"], 2) for x in notes_tab})
    bar_of = lambda t: max(0, int(np.searchsorted([b[0] for b in bars], t, side="right")) - 1)
    note_err = []
    for t in starts:
        v = float(sync(t))
        a, z = np.searchsorted(env_t, [v - NOTE_WIN, v + NOTE_WIN])
        if z - a < 3:
            continue
        i = a + int(np.argmax(env[a:z]))
        local = np.median(env[max(0, i - 100):i + 100]) + 1e-6
        if env[i] / local < 2 or i in (a, z - 1):
            continue  # no clear note start there
        note_err.append((t, v, env_t[i] - v, bar_of(t)))
    for b in per_bar:
        e = [x[2] for x in note_err if x[3] == b["bar"]]
        b["note_ms"] = round(1000 * float(np.median(e)), 1) if e else None
        b["notes_heard"] = len(e)
    pitch = []
    cat = {t["index"]: t["category"] for t in tracks}
    for x in notes_tab:
        if cat.get(x["track"], "other") in UNPITCHED:
            continue
        t0, t1 = x["start"] + 0.02, x["start"] + min(0.25, max(0.05, x["end"] - x["start"]))
        fr = lambda c, a, z: c[:, int(a * SR / C_HOP):max(int(a * SR / C_HOP) + 1, int(z * SR / C_HOP))]
        r = fr(rec_c, float(sync(t0)), float(sync(t1)))
        tb = fr(tab_c, t0, t1)
        if r.size == 0 or tb.size == 0:
            continue
        pc = (x["pitch"] + shift) % 12
        rs = float(r[pc].mean() / (r.max(axis=0).mean() + 1e-6))
        ts = float(tb[x["pitch"] % 12].mean() / (tb.max(axis=0).mean() + 1e-6))
        pitch.append({"bar": bar_of(x["start"]), "track": x["track"], "pitch": x["pitch"], "tab": round(x["start"], 3),
                      "video": round(float(sync(x["start"])), 3), "rec": round(rs, 2), "in_tab": round(ts, 2)})
    for b, (s, e, n) in zip(per_bar, bars):
        ps = [q for q in pitch if q["bar"] == b["bar"] and q["in_tab"] >= 0.6]
        b["notes_missing"] = sum(q["rec"] < 0.35 for q in ps)
        b["notes_checked"] = len(ps)
        r = rec_c[:, int(float(sync(s)) * SR / C_HOP):int(float(sync(e)) * SR / C_HOP)].mean(axis=1)
        tb = np.roll(tab_c[:, int(s * SR / C_HOP):int(e * SR / C_HOP)].mean(axis=1), shift)
        b["chords"] = round(float(r @ tb / (np.linalg.norm(r) * np.linalg.norm(tb) + 1e-9)), 3) if np.isfinite(r).all() and np.isfinite(tb).all() else None
    return per_bar, note_err, pitch


def summary(per_bar, note_err, pitch):
    ne = np.abs([x[2] for x in note_err]) * 1000
    be = np.abs([b["beat_ms"] for b in per_bar if b["beat_ms"] is not None])
    bpm = np.array([b["bpm"] for b in per_bar])
    jump = np.abs(np.diff(bpm)) / bpm[:-1] * 100
    checked = [q for q in pitch if q["in_tab"] >= 0.6]
    return {"notes_checked": len(ne), "notes_within_30ms": round(100 * float(np.mean(ne <= 30)), 1) if len(ne) else None,
            "notes_within_50ms": round(100 * float(np.mean(ne <= 50)), 1) if len(ne) else None,
            "note_median_ms": round(float(np.median(ne)), 1) if len(ne) else None,
            "bar_beat_median_ms": round(float(np.median(be)), 1) if len(be) else None,
            "bars_off_over_50ms": int(np.sum(be > 50)),
            "tempo_jumps_over_2pct": int(np.sum(jump > 2)), "tempo_jump_median_pct": round(float(np.median(jump)), 2),
            "pitch_missing_pct": round(100 * float(np.mean([q["rec"] < 0.35 for q in checked])), 1) if checked else None,
            "chords_median": round(float(np.median([b["chords"] for b in per_bar if b["chords"] is not None])), 3)}


def raw_line(info, bars):
    """Where the audio line-up (listen.py: the tab's sound matched to the recording) puts each bar."""
    A = np.array(info["tabAt"])
    keep = np.r_[True, np.diff(A) > 0]
    return np.interp([b[0] for b in bars], A[keep], np.arange(len(A))[keep] * info["step"])


def lag_curve(sync, tab_env, env, most=0.6, part=None):
    """How well the tab's sound lines up with the recording's when the whole song is moved by each lag
    (s): the recording's note starts against the tab's own, over the whole song (or the tab-time span
    part = (from, to)). The peak should be at 0."""
    t = np.arange(len(tab_env)) * HOP / SR
    env_t = np.arange(len(env)) * HOP / SR
    lags = np.arange(-most, most + 1e-9, HOP / SR)
    if part:
        keep = (t >= part[0]) & (t < part[1])
        t, tab_env = t[keep], tab_env[keep]
    a = (tab_env - tab_env.mean()) / (tab_env.std() + 1e-9)
    out = []
    for g in lags:
        r = np.interp(sync(t) + g, env_t, env, left=0, right=0)
        out.append(float(np.mean(a * (r - r.mean()) / (r.std() + 1e-9))))
    return lags, np.array(out)


class Look:
    """What the line-up is judged on: the note starts (onset strength) of the tab and the recording, and
    their harmony (chroma, each frame made length 1; the tab's moved into the recording's key)."""

    def __init__(self, tab_env, env, tab_c, rec_c, shift):
        unit = lambda c: c / (np.linalg.norm(c, axis=0) + 1e-9)
        self.tab_env, self.env = tab_env, env
        self.tab_c, self.rec_c = np.roll(unit(tab_c), shift, axis=0), unit(rec_c)
        self.tt = np.arange(tab_c.shape[1]) * C_HOP / SR


CHROMA_CLEAR = 0.01  # the harmony must line up this much better to pick a line-up further from 0


def harmony(sync, look, lags, part=None):
    """How alike the tab's and the recording's harmony are with the whole tab moved by each lag (s)."""
    keep = (look.tt >= part[0]) & (look.tt < part[1]) if part else np.ones(len(look.tt), bool)
    tc, v = look.tab_c[:, keep], sync(look.tt[keep])
    n = look.rec_c.shape[1]
    return np.array([float(np.mean(np.sum(tc * look.rec_c[:, np.clip(((v + g) * SR / C_HOP).astype(int), 0, n - 1)], axis=0)))
                     for g in lags])


def locate(sync, look, part=None, most=0.6, wide=None):
    """How far (s) the tab would have to move to line up best, and how much better that lines up than 0.
    The note starts give the exact place, but in a strummed song they line up as well an eighth note
    either way (Champion locked half a beat out, 2026-10-24). The harmony has one peak: of the note starts'
    peaks, the one whose harmony fits best is taken, the one nearest 0 when the harmony can't tell
    (wide: a longer span for the harmony)."""
    lags, c = lag_curve(sync, look.tab_env, look.env, most=most, part=part)
    z = int(np.argmin(np.abs(lags)))
    top = float(c.max())
    peaks = [i for i in range(1, len(c) - 1) if c[i] >= c[i - 1] and c[i] >= c[i + 1] and c[i] >= 0.5 * top > 0]
    if not peaks:
        return 0.0, 0.0
    ch = harmony(sync, look, lags[peaks], wide or part)
    near = int(np.argmin(np.abs(lags[peaks])))
    pick = peaks[int(np.argmax(ch))] if ch.max() - ch[near] >= CHROMA_CLEAR else peaks[near]
    return float(lags[pick]), float(c[pick] - c[z])


STEADY_MS = 40  # a stretch within this of 0: it lines up (a song played to a click stays there all through)
STRETCH = 4     # bars per stretch
CLEAR = 0.05    # a stretch counts as off only when its best lag lines up this much better than 0


def steadiness(sync, bars, tab_env, env, look=None):
    """The simple check: the song in stretches of STRETCH bars, and how far each would have to move to
    line up best (ms). Each stretch is one of:
      ok     within STEADY_MS of 0, or no clearly better lag (a quiet stretch has nothing to line up)
      half   half a beat out while the stretches round it are right: the tab's rhythm differs from the
             recording there (Be My Escape bars 35-50), not the sync. Listen to those bars.
      drift  any other lag: the band changes speed, a free intro, or a bar more or less in the tab.
    One steady tempo fits when no stretch drifts."""
    x = [b[0] for b in bars]
    out = []
    for p in range(0, len(bars), STRETCH):
        q = min(len(bars), p + STRETCH)
        half = 500 * (bars[q - 1][1] - bars[p][0]) / max(1, sum(b[2] for b in bars[p:q]))  # half a beat, ms (tab time)
        most, part = max(0.3, 1.2 * half / 1000), (bars[p][0], bars[q - 1][1])
        if look:  # the harmony over the 4 bars either side too
            g, gain = locate(sync, look, part, most, wide=(bars[max(0, p - STRETCH)][0], bars[min(len(bars), q + STRETCH) - 1][1]))
        else:
            lags, c = lag_curve(sync, tab_env, env, most=most, part=part)
            i, z = int(np.argmax(c)), int(np.argmin(np.abs(lags)))
            g, gain = float(lags[i]), float(c[i] - c[z])
        off = 1000 * g
        kind = ("ok" if abs(off) <= STEADY_MS or gain < CLEAR else
                "half" if abs(abs(off) - half) <= STEADY_MS else "drift")
        out.append({"bars": [p + 1, q], "video": round(float(sync(x[p])), 1), "off_ms": round(off), "kind": kind})
    return {"stretches": out, "steady": not any(s["kind"] == "drift" for s in out),
            "half_beat_bars": [s["bars"] for s in out if s["kind"] == "half"],
            "drift_bars": [s["bars"] for s in out if s["kind"] == "drift"]}


def one_tempo(raw_y, bars, tab_env, env, look=None):
    """One tempo and a start for the whole song. The line starts from the audio line-up (bars far apart,
    medians, so a bad stretch can't tilt it), then the tempo and the start are tuned so the tab's sound
    lines up best with the recording's over the whole song. Not the beat tracker: it can sit on the
    off-beats, and in a strummed song that looks just as good bar by bar (Be My Escape came out 0.3 s
    late, Stupid Deep 0.44 s early, 2026-10-24)."""
    x = np.array([b[0] for b in bars])
    y = np.asarray(raw_y, float)
    k = max(1, len(x) // 4)
    slope = float(np.median([(y[j + k] - y[j]) / (x[j + k] - x[j]) for j in range(len(x) - k) if x[j + k] > x[j]] or [1.0]))
    start = float(np.median(y - slope * x))
    t = np.arange(len(tab_env)) * HOP / SR
    env_t = np.arange(len(env)) * HOP / SR
    a = (tab_env - tab_env.mean()) / (tab_env.std() + 1e-9)

    def score(sl, st):
        r = np.interp(st + sl * t, env_t, env, left=0, right=0)
        return float(np.mean(a * (r - r.mean()) / (r.std() + 1e-9)))
    for span, steps in ((0.01, 21), (0.002, 21)):  # tempo within ±1 %, then ±0.2 %
        best = None
        for sl in slope * (1 + np.linspace(-span, span, steps)):
            mid = start + (slope - sl) * float(np.median(x))  # keep the middle of the song in place
            for st in mid + np.arange(-0.15, 0.15 + 1e-9, 0.005):
                c = score(sl, st)
                if best is None or c > best[0]:
                    best = (c, sl, st)
        _, slope, start = best
    if look:  # on the eighth note the harmony says (the note starts alone can lock half a beat out)
        start += locate(Sync(x, start + slope * x), look)[0]
    return Sync(x, start + slope * x)


SECTION_MAX = 16   # bars: a longer section of the tab is cut into equal parts this long or less
SECTION_PCT = 6    # a section's tempo stays within this of the one steady tempo (%)


def section_starts(notes, n, most=SECTION_MAX):
    """The bars where the tab's sections start (its Intro, Verse, Chorus marks), long sections cut up."""
    marks = [p for p, b in enumerate(notes["bars"][:n]) if b.get("section")] or [0]
    if marks[0] != 0:
        marks.insert(0, 0)
    out = []
    for a, z in zip(marks, marks[1:] + [n]):
        k = -(-(z - a) // most)
        out += [a + round(i * (z - a) / k) for i in range(k)]
    return out


def section_tempo(base, bars, starts, look):
    """One tempo per section, for a band that changes speed (asked for by the user, 2026-10-24). A straight
    line through each section, joined at the section starts, from the one steady tempo. Each join is moved
    to where the two sections either side line up best (locate: the harmony picks the eighth note, the note
    starts the place), a few passes, then fine-tuned on the note starts alone (within 20 ms nothing else
    lines up)."""
    tab_env, env = look.tab_env, look.env
    x = np.array([bars[p][0] for p in starts] + [bars[-1][1]])
    y = base(x).astype(float)
    slope = float((y[-1] - y[0]) / (x[-1] - x[0]))
    t = np.arange(len(tab_env)) * HOP / SR
    env_t = np.arange(len(env)) * HOP / SR
    a = (tab_env - tab_env.mean()) / (tab_env.std() + 1e-9)
    e = (env - env.mean()) / (env.std() + 1e-9)
    beat = float(np.median([(b[1] - b[0]) / max(1, b[2]) for b in bars])) * slope
    span = [(t >= x[max(0, k - 1)]) & (t < x[min(len(x) - 1, k + 1)]) for k in range(len(x))]

    def score(k, yy):
        m = span[k]
        return float(np.sum(a[m] * np.interp(np.interp(t[m], x, yy), env_t, e, left=0, right=0)))

    def fits(k, yy):  # each section's tempo within SECTION_PCT of the steady one, never backwards
        r = [(yy[j + 1] - yy[j]) / (x[j + 1] - x[j]) / slope for j in (k - 1, k) if 0 <= j < len(x) - 1]
        return all(abs(q - 1) <= SECTION_PCT / 100 for q in r)
    for _ in range(4):
        for k in range(len(x)):
            g, _ = locate(Sync(x, y), look, part=(x[max(0, k - 1)], x[min(len(x) - 1, k + 1)]), most=max(0.3, 0.6 * beat))
            yy = y.copy()
            yy[k] += g
            if fits(k, yy):
                y = yy
    for most, step in ((0.05, 0.005), (0.02, 0.002), (0.02, 0.002)):
        for k in range(len(x)):
            best, at = score(k, y), y[k]
            for d in np.arange(-most, most + 1e-9, step):
                yy = y.copy()
                yy[k] = at + d
                if fits(k, yy):
                    c = score(k, yy)
                    if c > best:
                        best, y[k] = c, at + d
    return Sync(x, y)


def fix(sync, bars, per_bar, downs=()):
    """Each bar moved by what its beats say (when they agree), the rest following their neighbours, then
    eased onto a steady tempo where that is within 40 ms (a click-track song)."""
    x = np.array([b[0] for b in bars])
    off = np.array([b["beat_ms"] / 1000 if b["beat_ms"] is not None and b["beats_heard"] >= 2
                    and (b["beat_spread_ms"] or 0) <= 30 else np.nan for b in per_bar])
    ok = ~np.isnan(off)
    if ok.sum() < 3:
        return sync
    off = np.interp(np.arange(len(off)), np.flatnonzero(ok), off[ok])
    y = on_downbeats(sync(x) + off, ok, bars, downs)
    y = listen.steady(x, y, w=4, most=0.04)
    y = np.maximum.accumulate(y + np.arange(len(y)) * 1e-4)  # never backwards
    return Sync(x, y)


def on_downbeats(y, ok, bars, downs):
    """Bars a beat or more from the recording's nearest bar line are put on it. The beat fit can't see a
    whole beat out (every beat still lands on a beat), the bar lines can. Used only when they agree with
    the bars whose beats are clear (to 40 ms): Beat This! can put every bar line on the wrong beat."""
    downs = np.asarray(downs, float)
    if len(downs) < 4:
        return y
    i = np.clip(np.searchsorted(downs, y), 1, len(downs) - 1)
    d = np.where(np.abs(downs[i - 1] - y) < np.abs(downs[i] - y), downs[i - 1], downs[i])
    if ok.sum() < 4 or np.median(np.abs(d[ok] - y[ok])) > 0.04:
        return y
    out = y.copy()
    length = lambda p: bars[p][1] - bars[p][0]  # tab seconds: near enough for a threshold
    for p in range(len(y)):
        beat = length(p) / max(1, bars[p][2])
        if not 0.6 * beat < abs(d[p] - y[p]) < 0.6 * beat * bars[p][2]:  # a beat or more out, but not a whole bar
            continue
        # every bar keeps at least half its length, so two bars never share one bar line
        if p and d[p] - out[p - 1] < 0.5 * length(p - 1) or p + 1 < len(y) and y[p + 1] - d[p] < 0.5 * length(p):
            continue
        out[p] = d[p]
    return out


def mismatches(per_bar):
    """Bars where the recording plays a steady beat but the tab's beats don't land on it (an extra beat, a 3/4
    bar in a 4/4 tab, a part the band plays differently): no timing can fix those, the tab differs there.
    Beat This! may hear the beat twice as fast in places; a tab beat on every other beat still lands."""
    return [{"bar": b["bar"], "tab_beats": b["beats"], "landed": b["beats_heard"], "beat_ms": b["beat_ms"]} for b in per_bar
            if b["recording_beats"] >= 2 and (b["beats_heard"] < b["beats"] - 1 or abs(b["beat_ms"] or 0) > 60)]


def ranges(ps):
    """[0, 1, 2, 5] -> '1–3, 6' (bar numbers from 1)."""
    out, cur = [], []
    for p in ps:
        if cur and p != cur[-1] + 1:
            out.append(cur)
            cur = []
        cur.append(p)
    if cur:
        out.append(cur)
    return ", ".join(f"{r[0] + 1}" if len(r) == 1 else f"{r[0] + 1}–{r[-1] + 1}" for r in out)


# ---------- the report ----------

def svg_lines(series, n, lo, hi, h=180, band=None, label="", fmt="{:g}"):
    """A line per series over the bars (None = a gap)."""
    W, L, R, T, B = 1000, 48, 10, 10, 22
    X = lambda i: L + (W - L - R) * i / max(1, n - 1)
    Y = lambda v: T + (h - T - B) * (1 - (min(hi, max(lo, v)) - lo) / (hi - lo))
    out = [f'<svg viewBox="0 0 {W} {h}" class="chart" role="img" aria-label="{html.escape(label)}">']
    if band:
        out.append(f'<rect x="{L}" y="{Y(band[1]):.1f}" width="{W - L - R}" height="{Y(band[0]) - Y(band[1]):.1f}" class="band"/>')
    for v in np.linspace(lo, hi, 5):
        out.append(f'<line x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="grid"/><text x="{L - 6}" y="{Y(v) + 4:.1f}" class="ax" text-anchor="end">{fmt.format(round(v, 1))}</text>')
    for i in range(0, n, 10):
        out.append(f'<text x="{X(i):.1f}" y="{h - 6}" class="ax" text-anchor="middle">{i + 1}</text>')
    for name, vals, cls in series:
        d, pen = [], "M"
        for i, v in enumerate(vals):
            if v is None:
                pen = "M"
                continue
            d.append(f"{pen}{X(i):.1f},{Y(v):.1f}")
            pen = "L"
        out.append(f'<path d="{" ".join(d)}" class="line {cls}"><title>{html.escape(name)}</title></path>')
    out.append("</svg>")
    return "".join(out)


def svg_notes(note_err, total, h=200):
    W, L, R, T, B = 1000, 48, 10, 10, 22
    X = lambda t: L + (W - L - R) * t / max(1, total)
    Y = lambda ms: T + (h - T - B) * (1 - (max(-80, min(80, ms)) + 80) / 160)
    out = [f'<svg viewBox="0 0 {W} {h}" class="chart" role="img" aria-label="Every note start, early or late">',
           f'<rect x="{L}" y="{Y(30):.1f}" width="{W - L - R}" height="{Y(-30) - Y(30):.1f}" class="band"/>']
    for v in (-80, -40, 0, 40, 80):
        out.append(f'<line x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="grid"/><text x="{L - 6}" y="{Y(v) + 4:.1f}" class="ax" text-anchor="end">{v}</text>')
    for m in range(0, int(total) + 1, 30):
        out.append(f'<text x="{X(m):.1f}" y="{h - 6}" class="ax" text-anchor="middle">{m // 60}:{m % 60:02d}</text>')
    for _, v, e, _ in note_err:
        ms = e * 1000
        out.append(f'<circle cx="{X(v):.1f}" cy="{Y(ms):.1f}" r="1.8" class="{"dot" if abs(ms) <= 30 else "dot bad"}"/>')
    out.append("</svg>")
    return "".join(out)


def report(path, song, info, before, after, tracks):
    pb0, ne0, _, s0 = before
    pb1, ne1, pitch1, s1 = after
    n = len(pb1)
    vid = listen.youtube_id(info["url"])
    tname = {t["index"]: t["name"] for t in tracks}
    tile = lambda k, label, unit="": (
        f'<div class="tile"><div class="k">{label}</div><div class="v">{s1[k] if s1[k] is not None else "–"}{unit}</div>'
        f'<div class="was">was {s0[k] if s0[k] is not None else "–"}{unit}</div></div>')
    worst = sorted([b for b in pb1 if b["beat_ms"] is not None], key=lambda b: -abs(b["beat_ms"]))[:12]
    yt = lambda t: f'https://www.youtube.com/watch?v={vid}&t={max(0, int(t) - 2)}s'
    rows = "".join(f'<tr><td>{b["bar"] + 1}</td><td><a href="{yt(b["video"])}" target="_blank">{int(b["video"] // 60)}:{b["video"] % 60:04.1f}</a></td>'
                   f'<td>{b["beat_ms"]:+.0f}</td><td>{b["note_ms"] if b["note_ms"] is not None else "–"}</td><td>{b["bpm"]}</td><td>{b["chords"]}</td></tr>' for b in worst)
    missing = sorted([q for q in pitch1 if q["in_tab"] >= 0.6 and q["rec"] < 0.35], key=lambda q: q["rec"])
    by_track = {}
    for q in missing:
        by_track.setdefault(q["track"], []).append(q)
    miss_rows = "".join(
        f'<tr><td>{html.escape(tname.get(t, str(t)))}</td><td>{len(qs)}</td><td>{", ".join(sorted({str(q["bar"] + 1) for q in qs}, key=int)[:24])}</td>'
        f'<td>{", ".join(sorted({NAMES[q["pitch"] % 12] for q in qs}))}</td></tr>' for t, qs in sorted(by_track.items(), key=lambda kv: -len(kv[1])))
    total = max(x[1] for x in ne1) if ne1 else 1
    col = lambda pb, k: [b[k] for b in pb]
    bpm = [b["bpm"] for b in pb0 + pb1]
    mid = float(np.median(bpm))
    css = """
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mute:#6b6a66;--grid:#e4e2dc;--band:#e3f1e3;--before:#b9b6ae;--after:#2f6fd0;--bad:#d0453a;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--mute:#9b9a95;--grid:#2c2c2a;--band:#1d3220;--before:#5d5b56;--after:#6ea3f0;--bad:#f07167;--card:#1f1f1d}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1040px;margin:auto}
h1{font-size:22px;margin:4px 0}h2{font-size:17px;margin:26px 0 4px}p{margin:4px 0 8px;color:var(--mute)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}
.tile{background:var(--card);border:1px solid var(--grid);border-radius:8px;padding:8px 10px}.k{font-size:12px;color:var(--mute)}.v{font-size:22px;font-weight:600}.was{font-size:12px;color:var(--mute)}
.chart{width:100%;height:auto;background:var(--card);border:1px solid var(--grid);border-radius:8px}
.grid{stroke:var(--grid)}.band{fill:var(--band)}.ax{font-size:11px;fill:var(--mute)}
.line{fill:none;stroke-width:1.6}.before{stroke:var(--before)}.after{stroke:var(--after);stroke-width:2}.bad{stroke:var(--bad)}
.dot{fill:var(--after);opacity:.55}.dot.bad{fill:var(--bad);opacity:.8}
.key span{display:inline-block;width:14px;height:3px;vertical-align:middle;margin:0 4px 0 10px}
table{border-collapse:collapse;width:100%;background:var(--card);font-size:14px}td,th{border-bottom:1px solid var(--grid);padding:4px 8px;text-align:left}
a{color:var(--after)}
"""
    key = '<div class="key"><span style="background:var(--before)"></span>before the fix<span style="background:var(--after)"></span>now</div>'
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sync check</title><style>{css}</style></head><body>
<h1>Sync check: {html.escape(song.get("title") or song["name"])}</h1>
<p>The tab against <a href="https://www.youtube.com/watch?v={vid}" target="_blank">the recording</a>, bar by bar, as Fretboard plays it. Green band = good.</p>
<div class="tiles">{tile("notes_within_30ms", "Note starts within 30 ms", "%")}{tile("note_median_ms", "Typical note error", " ms")}
{tile("bars_off_over_50ms", "Bars off by over 50 ms")}{tile("tempo_jumps_over_2pct", "Speed jumps over 2%")}
{tile("pitch_missing_pct", "Notes not heard in the recording", "%")}{tile("chords_median", "Harmony match (1 = same)")}</div>
<h2>1 · How early or late each bar is</h2><p>The tab's beats against the recording's beats (ms; above 0 = the tab is early). Within ±30 ms sounds together.</p>
{key}{svg_lines([("before", col(pb0, "beat_ms"), "before"), ("now", col(pb1, "beat_ms"), "after")], n, -150, 150, band=(-30, 30), label="Beat error per bar")}
<h2>2 · Speed, bar by bar</h2><p>Each bar's tempo in the video. A band playing to a click is a flat line: every bump is the tab speeding up or slowing down.</p>
{key}{svg_lines([("before", col(pb0, "bpm"), "before"), ("now", col(pb1, "bpm"), "after")], n, mid * 0.9, mid * 1.1, band=(mid * 0.99, mid * 1.01), label="Tempo per bar", fmt="{:g}")}
<h2>3 · Every note start</h2><p>Each dot is a note start in the tab against the nearest note start in the recording, now (ms, ±80). Red = more than 30 ms off.</p>
{svg_notes(ne1, total)}
<h2>4 · Harmony per bar</h2><p>How alike the recording's and the tab's notes are in each bar (1 = the same). A dip is a bar with wrong chords or notes, or a part the recording plays differently.</p>
{svg_lines([("harmony", col(pb1, "chords"), "after")], n, 0.5, 1.0, band=(0.85, 1.0), label="Harmony match per bar", fmt="{:g}")}
<h2>Bars furthest off now</h2><table><tr><th>Bar</th><th>Video</th><th>Beats (ms)</th><th>Notes (ms)</th><th>BPM</th><th>Harmony</th></tr>{rows}</table>
<h2>Notes the recording doesn't seem to have</h2><p>Clear in the tab, weak or missing in the recording at that moment: a wrong note, or a part the band doesn't play there. Listen before changing anything.</p>
<table><tr><th>Track</th><th>Notes</th><th>Bars</th><th>Pitches</th></tr>{miss_rows or '<tr><td colspan="4">None</td></tr>'}</table>
</body></html>"""
    path.write_text(page, encoding="utf-8")


def improve(song, check=False, quiet=False, fit=False, one=False):
    """Measure the song's sync against its recording, fix it (unless check) and write the report."""
    import librosa
    say = (lambda *a: None) if quiet else print
    out = listen.OUT / run.slug(song["name"])
    info = json.loads((out / "info.json").read_text(encoding="utf-8"))
    notes = json.loads((out / "notes.json").read_text(encoding="utf-8"))
    fb = next(out.glob("*.fretboard"), None)
    if not fb:
        sys.exit("run listen.py first: there is no .fretboard file yet")
    shared = json.loads(fb.read_text(encoding="utf-8"))
    entry = shared["songs"][0]
    bars = tab_bars(info, notes)
    sync0 = Sync.from_points([b[0] for b in bars], entry["syncPoints"])
    wav = real.download(info["url"], real.CACHE / run.slug(song["name"]))
    # the beat tracker only for --fit: it can sit on the off-beats, and the simple sync doesn't need it
    beats, downs = recording_beats(wav, out) if fit else (np.array([]), np.array([]))
    say("reading the recording and the tab...")
    rec, _ = librosa.load(str(wav), sr=SR, mono=True)
    env = librosa.onset.onset_strength(y=rec, sr=SR, hop_length=HOP)
    rec_c = chroma(rec)
    mix = tab_mix(song, info)
    tab_c = chroma(mix)
    tab_env = librosa.onset.onset_strength(y=mix, sr=SR, hop_length=HOP)
    look = Look(tab_env, env, tab_c, rec_c, info["shift"])
    keep = {t["index"] for t in info["tracks"]}
    notes_tab = [x for x in notes["notes"] if x["track"] in keep]
    m = lambda s: measure(s, bars, beats, env, rec_c, tab_c, notes_tab, info["tracks"], info["shift"])
    pb0, ne0, p0 = m(sync0)
    before = (pb0, ne0, p0, summary(pb0, ne0, p0))
    sync, sections = sync0, None
    if not check and fit:
        for _ in range(2):
            pb, *_ = m(sync)
            sync = fix(sync, bars, pb, downs)
    elif not check:
        sync = one_tempo(raw_line(info, bars), bars, tab_env, env, look)
        say(f"  one tempo: the tab at {round(100 * float(np.median(np.diff(sync.x)) / np.median(np.diff(sync.y))), 2)}% of its own speed, "
            f"bar 1 at {float(sync.y[0]):.3f} s")
        st1 = steadiness(sync, bars, tab_env, env, look)
        if not st1["steady"] and not one:  # the band changes speed: one tempo per section of the tab
            starts = section_starts(notes, len(bars))
            sec = section_tempo(sync, bars, starts, look)
            st2 = steadiness(sec, bars, tab_env, env, look)
            drift = lambda s: sum(b - a + 1 for a, b in s["drift_bars"])
            # the drift check uses the same line-up the fit chases, so the note starts must agree too
            n1, n2 = (summary(*m(s))["notes_within_30ms"] or 0 for s in (sync, sec))
            say(f"  one tempo drifts in {drift(st1)} bars, notes within 30 ms {n1}%; "
                f"one tempo per section ({len(starts)} sections): {drift(st2)} bars, {n2}%")
            if drift(st2) < drift(st1) and n2 >= n1 - 1:
                sync, sections = sec, starts
                speed = 100 * np.diff(sec.y) / np.diff(sec.x) / (float(sec.y[-1] - sec.y[0]) / float(sec.x[-1] - sec.x[0]))
                say("  section tempos (% of the average): " + ", ".join(f"bar {p + 1} {v:.1f}" for p, v in zip(starts, speed)))
    pb1, ne1, p1 = m(sync)
    after = (pb1, ne1, p1, summary(pb1, ne1, p1))
    odd = mismatches(pb1)
    for name, sy, st in (("before", sync0, before[3]), ("now", sync, after[3])):  # the whole song a little early or late?
        g, _ = locate(sy, look)
        st["whole_song_off_ms"] = round(1000 * g)
    after[3]["bars_not_matching"] = [b["bar"] + 1 for b in odd]
    st = steadiness(sync, bars, tab_env, env, look)
    after[3].update(steady=st["steady"], half_beat_bars=st["half_beat_bars"], drift_bars=st["drift_bars"])
    for name, s in (("before", before[3]), ("now", after[3])):
        say(f"  {name:6} notes within 30 ms {s['notes_within_30ms']}%, typical {s['note_median_ms']} ms, "
            f"bars over 50 ms off {s['bars_off_over_50ms']}, speed jumps over 2% {s['tempo_jumps_over_2pct']}, "
            f"not heard {s['pitch_missing_pct']}%, harmony {s['chords_median']}, whole song off {s['whole_song_off_ms']} ms")
    span = lambda bs: ", ".join(f"{a}-{b}" for a, b in bs)
    good = st["steady"] and abs(after[3]["whole_song_off_ms"]) <= 15
    if good:
        say("OK: one steady tempo fits the whole song")
    elif not st["steady"]:
        say(f"NOT SIMPLE: bars {span(st['drift_bars'])} drift off the steady tempo (the band changes speed, a free intro, or a bar more or less in the tab)")
    else:
        say(f"NOT OK: the whole song is {after[3]['whole_song_off_ms']} ms off")
    if st["half_beat_bars"]:
        say(f"  listen to bars {span(st['half_beat_bars'])}: the tab's rhythm is half a beat out from the recording there (the sync is right round them)")
    after[3]["ok"] = bool(good)
    after[3]["tempo_sections"] = [p + 1 for p in sections] if sections else None
    if odd:
        say(f"  bars where the tab differs from the recording (its beats don't land on the recording's): {ranges([b['bar'] for b in odd])}")
    if not check:
        backup = fb.with_suffix(".fretboard.before")
        if not backup.exists():
            backup.write_text(fb.read_text(encoding="utf-8"), encoding="utf-8")
        points, last = [], -1
        for p, v in enumerate(sync(np.array([b[0] for b in bars]))):
            ms = max(0, int(round(float(v) * 1000)))
            if ms > last:
                points.append([p, ms])
                last = ms
        entry["syncPoints"] = points
        entry["autoSync"]["beats"] = after[3]
        fb.write_text(json.dumps(shared), encoding="utf-8")
        say(f"fixed: {fb}")
    (out / "sync.json").write_text(json.dumps({"before": before[3], "now": after[3], "bars": pb1, "pitch": p1, "not_matching": odd}), encoding="utf-8")
    report(out / "sync_report.html", song, info, before, after, info["tracks"])
    say(f"report: {out / 'sync_report.html'}")
    return after[3]


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
    improve(songdb.find_one(songdb.load(), a[0]), check="--check" in a, fit="--fit" in a, one="--one" in a)


if __name__ == "__main__":
    main()
