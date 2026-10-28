"""Truth benchmark for wavefit: songs where the right bar times are known exactly. Light CPU (2 processes, 2 threads each).

    python tests/yt2gp5/truthbench.py build [--songs 16]      make the cases (a few minutes once; kept in out/truthbench/)
    python tests/yt2gp5/truthbench.py run [--split all|train|val] [--set LAMBDA=0.03 ...] [--variants a,b] [--by-case]
    python tests/yt2gp5/truthbench.py sweep LAMBDA 0.01,0.02,0.04 [--split train]

The songs are AAM's (CC BY 4.0, already in fretboard-data\\factory\\aam): a real-sounding mix plus the notes and the
bar lines it was made from, so every bar's time in the mix is exact. The "tab" is drawn from the notes with a plain
synth (not the mix's own sounds, so the two differ in timbre like alphaTab's guitar and a real recording do), on its
own steady clock; the "recording" is the mix with a silent lead-in. The right answer for bar k is where the mix
plays it. A case is one (song, how the tab's tempo differs from the recording, what the tab holds) and is fitted from
two starting lines (a good one and a bad one, 0.9 s off, like a late first bar), by each of wavefit's tries.

  clock     steady / slow3 / fast3 (the tab 3 % off) / step (+3 %, then -1.5 %) / hohey (98.2 % to 57 s, then 97 % at the end)
  content   full (every part) / partial (one chord part and the bass, no drums) / wrong (a quarter of the notes wrong
            or missing, extra notes, so the tab and the recording only half agree, which is most real tabs)

Numbers per try: "good" = every bar within 50 ms (the user hears 60 ms as in time), "ok" = within 150 ms, "bad" =
worse, "none" = it declined (the gate would leave the file alone), "within 20 ms" = bars right to the floor.
"""
import argparse
import os
import pickle
import sys
import time
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = Path.home() / ".fretboard" / "yt2gp5-venv" / "Scripts" / "python.exe"
if __name__ == "__main__" and VENV.exists() and Path(sys.executable).resolve() != VENV.resolve():
    import subprocess
    sys.exit(subprocess.call([str(VENV), __file__, *sys.argv[1:]]))
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(_v, "2")

import json  # noqa: E402

import numpy as np  # noqa: E402

sys.path.insert(0, str(HERE))
import wavefit  # noqa: E402

FACTORY = Path.home() / "fretboard-data" / "factory" / "aam"
OUT = HERE / "out" / "truthbench"
RATE = wavefit.RATE
CLOCKS = ("steady", "slow3", "fast3", "step", "hohey")
CASES = [(c, "full") for c in CLOCKS] + [("steady", "partial"), ("step", "partial"), ("steady", "wrong"), ("hohey", "wrong")]
STARTS = {"good": (0.15, 0.002), "bad": (0.9, 0.006), "far": (None, 0.004)}  # (seconds off, speed off): the file's line-up, as the one-tempo fit leaves it
# name: (harmony, ending, bar lines)
VARIANTS = {"wavefit": (False, False, False), "+ending": (False, True, False), "+harmony": (True, False, False), "+harmony+ending": (True, True, False),
            "+bars": (False, False, True), "+bars+harmony": (True, False, True), "+bars+harmony+ending": (True, True, True)}
GOOD_MS, OK_MS = 50, 150
DEFAULTS = {k: getattr(wavefit, k) for k in dir(wavefit) if k.isupper() and isinstance(getattr(wavefit, k), (int, float))}


def rng_of(*key):
    return np.random.default_rng(zlib.crc32("|".join(map(str, key)).encode()))


# ---------- the songs ----------

def load_song(song):
    import soundfile as sf
    d = FACTORY / song
    L = json.loads((d / "labels.json").read_text(encoding="utf-8"))
    y, sr = sf.read(str(d / "mix.flac"), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    assert sr == RATE, sr
    return L, y


def pick_songs(n):
    """Songs with one steady tempo and several parts, spread over the data set (a fixed stride, so the same every time)."""
    ok = []
    for d in sorted(FACTORY.iterdir()):
        f = d / "labels.json"
        if d.name.endswith(".tmp") or not f.exists():
            continue
        L = json.loads(f.read_text(encoding="utf-8"))
        bars = [b[0] for b in L["beats"] if b[2] == 1]
        notes = L["stems"]["mix"]["notes"]
        if len(bars) < 24 or L["duration"] > 260 or len(L["instruments"]) < 4 or len(notes) < 300:
            continue
        gaps = np.diff(bars)
        if gaps.std() / gaps.mean() > 0.01 or not any(v["group"] == "drums" for v in L["instruments"].values()):
            continue
        ok.append(d.name)
    stride = max(1, len(ok) // n)
    return ok[::stride][:n]


# ---------- the tab: a plain synth ----------

def tone(pitch, seconds):
    n = int((min(seconds, 1.4) + 0.05) * RATE)
    t = np.arange(n) / RATE
    f = 440 * 2 ** ((pitch - 69) / 12)
    y = sum(a * np.sin(2 * np.pi * f * h * t) for h, a in ((1, 1), (2, .6), (3, .35), (4, .2)) if f * h < 5000)
    env = (1 - np.exp(-t / 0.004)) * np.exp(-t / 0.5)
    env *= np.clip((seconds + 0.03 - t) / 0.03, 0, 1)
    return (0.25 * y * env).astype(np.float32)


def drum(pitch, rng):
    kind = ("kick" if pitch in (35, 36) else "snare" if pitch in (37, 38, 39, 40) else "tom" if pitch in (41, 43, 45, 47, 48, 50)
            else "cymbal" if pitch in (49, 51, 52, 53, 55, 57, 59) else "hat")
    n = int({"kick": .2, "snare": .2, "tom": .3, "cymbal": .5, "hat": .08}[kind] * RATE)
    t = np.arange(n) / RATE
    noise = rng.standard_normal(n)
    if kind == "kick":
        y = np.sin(2 * np.pi * (45 + 80 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.07)
    elif kind == "snare":
        y = 0.6 * np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05) + 0.5 * noise * np.exp(-t / 0.06)
    elif kind == "tom":
        y = np.sin(2 * np.pi * (110 + 60 * np.exp(-t / 0.04)) * t) * np.exp(-t / 0.12)
    elif kind == "cymbal":
        y = 0.35 * np.diff(noise, prepend=0) * np.exp(-t / 0.2)
    else:
        y = 0.35 * np.diff(noise, prepend=0) * np.exp(-t / 0.02)
    return (0.4 * y).astype(np.float32)


def render(notes, groups, seconds, rng):
    y = np.zeros(int(seconds * RATE) + 2 * RATE, np.float32)
    cache = {}
    for (on, off, pitch, inst) in notes:
        i = int(on * RATE)
        if i >= len(y) - RATE:
            continue
        if groups[inst] == "drums":
            seg = drum(int(pitch), rng)
        else:
            key = (int(pitch), int(round((off - on) * 20)))
            if key not in cache:
                cache[key] = tone(int(pitch), (off - on))
            seg = cache[key]
        y[i:i + len(seg)] += seg[:len(y) - i]
    return y[:int(seconds * RATE)]


def tab_notes(L, content, rng):
    """[onset, offset, pitch, instrument] in the song's own time: what the tab holds."""
    groups = {k: v["group"] for k, v in L["instruments"].items()}
    notes = [(n[0], n[1], n[2], n[4]) for n in L["stems"]["mix"]["notes"]]
    if content == "partial":
        count = {k: sum(1 for n in notes if n[3] == k) for k in groups}
        chord = max((k for k in groups if groups[k] in ("chords", "melody")), key=lambda k: count[k])
        bass = [k for k in groups if groups[k] == "bass"]
        keep = {chord, *bass[:1]}
        return [n for n in notes if n[3] in keep]
    if content == "wrong":
        out = []
        for on, off, p, inst in notes:
            if groups[inst] == "drums":
                if rng.random() > 0.1:
                    out.append((on, off, p, inst))
                continue
            r = rng.random()
            if r < 0.10:
                continue  # missing
            if r < 0.35:
                p = p + int(rng.choice([-7, -5, -3, -2, -1, 1, 2, 3, 5, 7]))  # wrong
            out.append((on, off, p, inst))
        pitched = [n for n in notes if groups[n[3]] != "drums"]
        for _ in range(len(pitched) // 10):  # notes the band never played
            on = float(rng.uniform(0, notes[-1][0]))
            out.append((on, on + float(rng.choice([0.2, 0.4, 0.8])), int(rng.integers(40, 80)), pitched[0][3]))
        return out
    return notes


def clock(name, bars, ends):
    """Tab seconds per recording second, for each bar."""
    n = len(bars)
    r = np.ones(n)
    third = n // 3
    if name == "slow3":
        r[:] = 1.03
    elif name == "fast3":
        r[:] = 0.97
    elif name == "step":
        r[third:2 * third], r[2 * third:] = 1.03, 0.985
    elif name == "hohey":
        r[bars < 57] = 0.982
        r[bars >= ends - 9] = 0.97
    return r


def chroma(y):
    import librosa
    c = librosa.feature.chroma_cqt(y=y, sr=RATE, hop_length=wavefit.CHROMA_HOP)
    return (c / (np.linalg.norm(c, axis=0) + 1e-9)).astype(np.float32)


# ---------- building the cases ----------

def build_song(song, say=print):
    t0 = time.time()
    L, mix = load_song(song)
    groups = {k: v["group"] for k, v in L["instruments"].items()}
    bars = np.array([b[0] for b in L["beats"] if b[2] == 1], float)
    ends = float(bars[-1] + np.median(np.diff(bars)))
    delay = float(rng_of(song, "delay").uniform(0.5, 3.5))
    rec = np.concatenate([np.zeros(int(delay * RATE), np.float32), mix])
    rec_curve = wavefit.curves(rec)[1]
    rec_c = chroma(rec)
    cases = []
    for clk, content in CASES:
        rng = rng_of(song, clk, content)
        ratio = clock(clk, bars, ends)
        lens = np.diff(np.r_[bars, ends]) * ratio  # the tab's bar lengths
        bars_t = np.r_[0, np.cumsum(lens)][:-1]
        tab_end = float(bars_t[-1] + lens[-1])
        edges_true, edges_tab = np.r_[bars, ends], np.r_[bars_t, tab_end]

        def to_tab(t):
            t = np.asarray(t, float)
            v = np.interp(t, edges_true, edges_tab)
            return np.where(t < edges_true[0], t - edges_true[0], np.where(t > ends, tab_end + (t - ends), v))

        notes = tab_notes(L, content, rng)
        moved = [(float(to_tab(on)), float(to_tab(off)), p, inst) for on, off, p, inst in notes]
        tab = render(moved, groups, tab_end + 1, rng)
        cases.append({"clock": clk, "content": content, "bars_t": bars_t, "truth": bars + delay, "notes": len(notes),
                      "tab_curve": wavefit.curves(tab)[1], "tab_c": chroma(tab)})
    data = {"song": song, "title": L["id"], "delay": delay, "seconds": float(L["duration"]), "rec_curve": rec_curve, "rec_c": rec_c, "cases": cases}
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / f"{song}.pkl", "wb") as f:
        pickle.dump(data, f)
    say(f"  {song}: {len(bars)} bars, {len(cases)} cases, {time.time() - t0:.0f} s")
    return song


def beats_song(song, say=print):
    """Beat This! on the recording (once; kept beside the case)."""
    f = OUT / f"{song}.beats.json"
    if f.exists():
        return song
    t0 = time.time()
    import torch
    from beat_this.inference import Audio2Beats
    torch.set_num_threads(2)
    L, mix = load_song(song)
    rec = np.concatenate([np.zeros(int(song_data(song)["delay"] * RATE), np.float32), mix])
    beats, downs = Audio2Beats(device="cpu", dbn=False)(rec, RATE)
    f.write_text(json.dumps({"beats": [float(b) for b in beats], "downbeats": [float(b) for b in downs]}), encoding="utf-8")
    say(f"  {song}: {len(beats)} beats, {len(downs)} bar lines, {time.time() - t0:.0f} s")
    return song


_BEATS = {}


def pulse_of(song, n):
    key = (song, n, wavefit.BEAT_SIGMA, wavefit.BEAT_OTHER)
    if key not in _BEATS:
        d = json.loads((OUT / f"{song}.beats.json").read_text(encoding="utf-8"))
        _BEATS[key] = wavefit.beat_pulse(d["beats"], d["downbeats"], n)
    return _BEATS[key]


# ---------- running ----------

_SONG = {}


def song_data(song):
    if song not in _SONG:
        with open(OUT / f"{song}.pkl", "rb") as f:
            _SONG[song] = pickle.load(f)
    return _SONG[song]


def start_line(bars_t, truth, name, rng):
    """The file's line-up: one straight line through the truth (the one-tempo fit), then moved and slanted."""
    off, eps = STARTS[name]
    sign = 1 if rng.random() < 0.5 else -1
    if off is None:  # an intro the one-tempo fit didn't know about: the start is several bars off
        off = float(rng.uniform(6, 24))
    a, b = np.polyfit(bars_t, truth, 1)
    mid = bars_t.mean()
    return wavefit.Sync(bars_t, truth.mean() + (a * (1 + sign * eps)) * (bars_t - mid) + sign * off)


def task(args):
    song, idx, over, only = args
    for k, v in {**DEFAULTS, **over}.items():
        setattr(wavefit, k, v)
    d = song_data(song)
    c = d["cases"][idx]
    layers = {"mix": (c["tab_curve"], d["rec_curve"])}
    harm = (c["tab_c"], d["rec_c"])
    out = []
    for start in STARTS:
        base = start_line(c["bars_t"], c["truth"], start, rng_of(song, c["clock"], c["content"], start))
        err0 = (base(c["bars_t"]) - c["truth"]) * 1000
        for name, (h, e, b) in VARIANTS.items():
            if only and name not in only:
                continue
            if b and not (OUT / f"{song}.beats.json").exists():
                continue  # `beats` makes them
            try:
                pulse = pulse_of(song, len(d["rec_curve"])) if b else None
                r = wavefit.fit_core(layers, c["bars_t"], base, harm if h else None, wavefit.RANGE_S, e, pulse)
                err = (r["sync"](c["bars_t"]) - c["truth"]) * 1000
                out.append({"song": song, "clock": c["clock"], "content": c["content"], "start": start, "variant": name,
                            "worst": float(np.abs(err).max()), "median": float(np.median(err)), "w20": float((np.abs(err) <= 20).mean()),
                            "start_worst": float(np.abs(err0).max()), "knots": len(r["knots"]) - 2, "end_gain": r.get("ending_gain"), "moved": r.get("start_moved")})
            except RuntimeError:
                out.append({"song": song, "clock": c["clock"], "content": c["content"], "start": start, "variant": name,
                            "worst": None, "start_worst": float(np.abs(err0).max())})
    return out


def split_of(songs, split):
    return [s for i, s in enumerate(songs) if split == "all" or (split == "train") == (i % 2 == 0)]


def have_songs():
    return sorted(p.stem for p in OUT.glob("[0-9][0-9][0-9][0-9].pkl"))


def run_all(songs, over, jobs=2, only=None):
    tasks = [(s, i, over, only) for s in songs for i in range(len(song_data(s)["cases"]))]
    if jobs <= 1:
        res = [task(t) for t in tasks]
    else:
        import concurrent.futures as cf
        with cf.ProcessPoolExecutor(jobs) as ex:
            res = list(ex.map(task, tasks, chunksize=2))
    return [r for part in res for r in part]


def summarise(rows, variants=None, by=None):
    """{key: {n, good, ok, bad, none, w20, median worst}} per variant (and per `by` field when given)."""
    out = {}
    for r in rows:
        if variants and r["variant"] not in variants:
            continue
        key = (r["variant"], r[by]) if by else (r["variant"],)
        o = out.setdefault(key, {"n": 0, "good": 0, "ok": 0, "bad": 0, "none": 0, "w20": [], "worst": []})
        o["n"] += 1
        if r["worst"] is None:
            o["none"] += 1
            continue
        o["good" if r["worst"] <= GOOD_MS else "ok" if r["worst"] <= OK_MS else "bad"] += 1
        o["w20"].append(r["w20"])
        o["worst"].append(r["worst"])
    return out


def score(rows, variants=None):
    """One number to tune on: good fits count 1, ok 0.4, none 0.25 (the gate leaves the file alone), bad costs 1."""
    o = summarise(rows, variants)
    n = sum(v["n"] for v in o.values())
    return sum(v["good"] + 0.4 * v["ok"] + 0.25 * v["none"] - v["bad"] for v in o.values()) / max(1, n)


def show(rows, variants=None, by=None, say=print):
    o = summarise(rows, variants, by)
    say(f"  {'':24}{'n':>4} {'good':>5} {'ok':>4} {'bad':>4} {'none':>5}  {'<=20ms':>7}  {'worst med':>9}")
    for key in sorted(o):
        v = o[key]
        label = " ".join(str(k) for k in key)
        say(f"  {label:24}{v['n']:>4} {v['good']:>5} {v['ok']:>4} {v['bad']:>4} {v['none']:>5}  "
            f"{100 * np.mean(v['w20']) if v['w20'] else 0:6.1f}%  {np.median(v['worst']) if v['worst'] else 0:7.0f} ms")


def parse_over(items):
    over = {}
    for s in items or []:
        k, v = s.split("=")
        if not hasattr(wavefit, k):
            sys.exit(f"wavefit has no constant {k}")
        over[k] = type(getattr(wavefit, k))(float(v)) if not isinstance(getattr(wavefit, k), bool) else v == "1"
    return over


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["build", "beats", "run", "sweep"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("values", nargs="?")
    ap.add_argument("--songs", type=int, default=16)
    ap.add_argument("--split", default="all", choices=["all", "train", "val"])
    ap.add_argument("--set", action="append")
    ap.add_argument("--variants")
    ap.add_argument("--by", choices=["clock", "content", "start", "song"])
    ap.add_argument("--jobs", type=int, default=2)
    a = ap.parse_args()
    variants = a.variants.split(",") if a.variants else None
    if a.cmd == "build":
        songs = pick_songs(a.songs)
        print(f"{len(songs)} songs: {', '.join(songs)}")
        done = have_songs()
        todo = [s for s in songs if s not in done]
        if a.jobs > 1 and len(todo) > 1:
            import concurrent.futures as cf
            with cf.ProcessPoolExecutor(a.jobs) as ex:
                list(ex.map(build_song, todo))
        else:
            for s in todo:
                build_song(s)
        (OUT / "songs.json").write_text(json.dumps(songs), encoding="utf-8")
        return
    songs = json.loads((OUT / "songs.json").read_text(encoding="utf-8"))
    if a.cmd == "beats":
        for s in songs:
            beats_song(s)
        return
    songs = split_of(songs, a.split)
    over = parse_over(a.set)
    if a.cmd == "run":
        t0 = time.time()
        rows = run_all(songs, over, a.jobs, variants)
        print(f"{len(songs)} songs ({a.split}), {len(rows)} fits, {time.time() - t0:.0f} s{', ' + str(over) if over else ''}")
        show(rows, variants, a.by)
        print(f"  score {score(rows, variants):+.3f}")
        (OUT / "last.json").write_text(json.dumps(rows), encoding="utf-8")
    else:
        for v in a.values.split(","):
            o = {**over, a.name: type(getattr(wavefit, a.name))(float(v))}
            rows = run_all(songs, o, a.jobs, variants)
            s = summarise(rows, variants)
            tot = {k: sum(x[k] for x in s.values()) for k in ("n", "good", "ok", "bad", "none")}
            print(f"  {a.name}={v:<8} good {tot['good']:>4}  ok {tot['ok']:>3}  bad {tot['bad']:>3}  none {tot['none']:>3}  score {score(rows, variants):+.3f}", flush=True)


if __name__ == "__main__":
    main()
