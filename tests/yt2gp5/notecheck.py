"""The guitar-notes check: how many of the official tab's guitar notes basic-pitch hears in the recording.

    python tests/yt2gp5/notecheck.py                  every song in out/listen, every model, every setting
    python tests/yt2gp5/notecheck.py -k champion      only songs whose name contains this
    python tests/yt2gp5/notecheck.py --models htdemucs,htdemucs_ft
    python tests/yt2gp5/notecheck.py --cpu 0.6       the share of the CPU cores it may use (default 0.6)
    python tests/yt2gp5/notecheck.py --gpu 0.85      the most of the GPU it may use: memory and busy time (default 0.85)

The tab's notes are moved into the recording's time by the song's own sync (its .fretboard file, the one qa.py
checks), so this needs no chord line-up and can score notes to 50 ms. Only real guitar tracks count as the
truth (not the synth or piano parts that Fretboard files under guitar): the guitar track is what the notebook
makes, and guitar comes first.

For each song and Demucs model (the notebook's own separate_stems, cached in cache/real/<song>/notecheck-<model>/),
basic-pitch runs once on the guitar stem ('guitar' with htdemucs_6s, else 'other'); its raw output is cached,
so every note setting (onset threshold, frame threshold, shortest note, quietest note) is cheap to try.
Scores: F1 (1 = every note right, nothing extra), recall (tab notes found), precision (found notes in the tab),
each with the right pitch and a start within TOL after taking out the steady delay (run.lag).
Writes out/notecheck.json and out/notecheck.md (the best settings first, the notebook's current ones marked).
"""
import argparse
import itertools
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import listen  # noqa: E402
import real  # noqa: E402
import run  # noqa: E402
import syncqa  # noqa: E402

TOL = 0.05
MODELS = ["htdemucs", "htdemucs_ft", "htdemucs_6s"]
NOT_GUITAR = re.compile(r"synth|piano|key|organ|pad|string|lead \d|vocal|choir", re.I)
LOW, HIGH = 40, 88   # the notebook's guitar range (MIDI)
# the settings tried; the notebook's are onset 0.6, frame 0.35, 60 ms, any loudness
GRID = {"onset": [0.3, 0.4, 0.5, 0.6], "frame": [0.25, 0.35, 0.45], "min_ms": [60, 120], "min_amp": [0.0, 0.3, 0.4]}
CPU_SHARE = 0.6  # the user's cap on the CPU: this share of the cores
GPU_SHARE = 0.85  # the user's cap on the GPU's memory
NOW = {"onset": 0.6, "frame": 0.35, "min_ms": 60, "min_amp": 0.0}


def songs(k):
    return sorted(p.name for p in listen.OUT.iterdir()
                  if p.is_dir() and not p.name.endswith(".old") and (p / "info.json").exists() and k.lower() in p.name.lower())


def truth(folder):
    """The tab's guitar notes in recording time [(s, pitch)], the other pitched notes, and the recording."""
    info = json.loads((folder / "info.json").read_text(encoding="utf-8"))
    notes = json.loads((folder / "notes.json").read_text(encoding="utf-8"))
    fb = min(folder.glob("*.fretboard"), key=lambda p: ("(" in p.stem, p.name))
    points = json.loads(fb.read_text(encoding="utf-8"))["songs"][0]["syncPoints"]
    bars = syncqa.tab_bars(info, notes)
    sync = syncqa.Sync.from_points([b[0] for b in bars], points)
    guitar = {t["index"] for t in info["tracks"] if t["category"] == "guitar" and not NOT_GUITAR.search(t["name"])}
    pitched = {t["index"] for t in info["tracks"] if t["category"] not in ("drums", "vocals")}
    shift = info.get("shift") or 0
    at = lambda ns: run.merge_unisons([(float(sync(t)), p + shift) for _, t, p in ns])
    g = at([n for n in info["notes"] if n[0] in guitar])
    o = at([n for n in info["notes"] if n[0] in pitched - guitar])
    wav = real.download(info["url"], real.CACHE / folder.name)
    names = [t["name"] for t in info["tracks"] if t["index"] in guitar]
    return g, o, wav, names


def throttle(share):
    """Keeps the GPU busy only `share` of the time: after each piece Demucs works on, it rests for the time
    that piece took × (1/share − 1). The memory cap alone let it run at 100%."""
    import demucs.pretrained
    import torch
    get = demucs.pretrained.get_model
    if getattr(get, "throttled", False):
        return

    def get_model(name, *a, **k):
        m = get(name, *a, **k)
        for sub in getattr(m, "models", [m]):
            fwd = sub.forward

            def slow(*x, _f=fwd, **y):
                t = time.perf_counter()
                out = _f(*x, **y)
                if torch.cuda.is_available():
                    torch.cuda.synchronize()
                time.sleep((time.perf_counter() - t) * (1 / share - 1))
                return out
            sub.forward = slow
        return m
    get_model.throttled = True
    demucs.pretrained.get_model = get_model


def pin_cores(n):
    """This process and its workers (they inherit it) run only on the first n cores (Windows)."""
    if sys.platform == "win32":
        import ctypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = ctypes.c_void_p
        k.SetProcessAffinityMask(ctypes.c_void_p(k.GetCurrentProcess()), ctypes.c_size_t((1 << n) - 1))


def raw_output(ns, wav, model, cache):
    """basic-pitch's raw output on the model's guitar stem (cached)."""
    f = cache / "basic_pitch.npz"
    if f.exists():
        return dict(np.load(f))
    import torch
    stems = ns["separate_stems"](wav, cache, model)
    for k in [s for s in stems if s not in ("guitar", "other")]:
        Path(stems[k]).unlink()  # only the guitar stem is kept: stems are big
    torch.cuda.empty_cache() if torch.cuda.is_available() else None
    from basic_pitch.inference import run_inference
    out = run_inference(str(ns["guitar_stem"](stems)), ns["BASIC_PITCH_MODEL"])
    np.savez_compressed(f, **out)
    return out


def events(out, s):
    """basic-pitch's notes for one setting (min_amp aside, which only filters): [(start, pitch, amplitude)]."""
    from basic_pitch import note_creation
    from basic_pitch.constants import AUDIO_SAMPLE_RATE, FFT_HOP
    hz = lambda n: 440.0 * 2 ** ((n - 69) / 12)
    _, ev = note_creation.model_output_to_notes(
        out, onset_thresh=s["onset"], frame_thresh=s["frame"],
        min_note_len=int(round(s["min_ms"] / 1000 * AUDIO_SAMPLE_RATE / FFT_HOP)),
        min_freq=hz(LOW - 0.5), max_freq=hz(HIGH + 0.5), include_pitch_bends=False, melodia_trick=True)
    return sorted((float(a), int(p), float(amp)) for a, b, p, amp, _ in ev if LOW <= p <= HIGH and b > a)


_OUT = {}


def _job(args):
    """One worker's setting (basic-pitch's note making is slow Python: ~20 s a song, so the grid runs in parallel)."""
    path, s = args
    if path not in _OUT:
        _OUT.clear()
        _OUT[path] = dict(np.load(path))
    return s, events(_OUT[path], s)


def by_pitch(notes):
    d = {}
    for t, p in notes:
        d.setdefault(p, []).append(t)
    return {p: np.sort(v) for p, v in d.items()}


def pairs(ref, est):
    """One-to-one matches (same pitch, starts within TOL), greedy in time order per pitch: fast enough for
    the whole grid on whole songs (mir_eval's matching took minutes)."""
    n = 0
    for p, a in ref.items():
        b = est.get(p)
        if b is None:
            continue
        i = j = 0
        while i < len(a) and j < len(b):
            if abs(a[i] - b[j]) <= TOL:
                n, i, j = n + 1, i + 1, j + 1
            elif a[i] < b[j]:
                i += 1
            else:
                j += 1
    return n


def near(notes, other):
    """How many of notes have a same-pitch note in other within TOL."""
    n = 0
    for p, a in notes.items():
        b = other.get(p)
        if b is None:
            continue
        k = np.searchsorted(b, a)
        lo, hi = np.abs(a - b[np.clip(k - 1, 0, len(b) - 1)]), np.abs(b[np.clip(k, 0, len(b) - 1)] - a)
        n += int(np.sum(np.minimum(lo, hi) <= TOL))
    return n


def score(ref, est, others):
    if not est or not ref:
        return {"f1": 0.0, "recall": 0.0, "precision": 0.0, "lag_ms": 0, "n": len(est), "leak": 0.0}
    R = by_pitch(ref)
    # the steady delay, as run.lag: the median offset to the nearest same-pitch tab note within 0.25 s
    d = []
    for p, a in by_pitch(est).items():
        b = R.get(p)
        if b is not None:
            k = np.clip(np.searchsorted(b, a), 1, max(1, len(b) - 1))
            off = np.where(np.abs(a - b[k - 1]) < np.abs(a - b[np.minimum(k, len(b) - 1)]), a - b[k - 1], a - b[np.minimum(k, len(b) - 1)])
            d += list(off[np.abs(off) <= 0.25])
    lg = float(np.clip(np.median(d), -0.12, 0.12)) if len(d) >= 5 else 0.0
    E, O = by_pitch([(t - lg, p) for t, p in est]), by_pitch(others)
    m = pairs(R, E)
    # wrong instrument: found notes that are no tab guitar note but another instrument's
    wrong = {p: a[[not (len(R.get(p, [])) and np.min(np.abs(R[p] - x)) <= TOL) for x in a]] for p, a in E.items()}
    leak = near(wrong, O)
    r, p = m / len(ref), m / len(est)
    return {"f1": round(2 * m / (len(ref) + len(est)), 4), "recall": round(r, 3), "precision": round(p, 3),
            "lag_ms": round(lg * 1000), "n": len(est), "leak": round(leak / len(est), 3)}


def key(s):
    return f"onset {s['onset']} · frame {s['frame']} · {s['min_ms']} ms · amp {s['min_amp']}"


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-k", default="")
    ap.add_argument("--models", default=",".join(MODELS))
    ap.add_argument("--cpu", type=float, default=CPU_SHARE, help="share of the CPU cores to use (0-1)")
    ap.add_argument("--gpu", type=float, default=GPU_SHARE, help="most of the GPU to use (0-1): its memory, and the share of the time it works")
    args = ap.parse_args()
    models = args.models.split(",")
    import os
    cores = max(1, int((os.cpu_count() or 2) * args.cpu))
    for v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ[v] = "1"  # one thread per worker, so the workers together use only the cores given
    pin_cores(cores)
    import torch
    torch.set_num_threads(1)  # Demucs runs on the GPU; one core feeds it
    if torch.cuda.is_available():
        torch.cuda.set_per_process_memory_fraction(args.gpu)  # Demucs falls back to shorter pieces when it runs short
        throttle(args.gpu)
    ns = run.load_notebook()
    settings = [dict(zip(GRID, v)) for v in itertools.product(*GRID.values())]
    makes = [dict(zip(("onset", "frame", "min_ms"), v)) for v in itertools.product(GRID["onset"], GRID["frame"], GRID["min_ms"])]
    results = {}  # song → model → setting key → score
    import multiprocessing
    from concurrent.futures import ThreadPoolExecutor
    pool = multiprocessing.Pool(max(1, cores - 1))
    # the GPU splits the next song's stems while the CPU reads the notes of this one
    jobs = []
    for name in songs(args.k):
        folder = listen.OUT / name
        ref, others, wav, gnames = truth(folder)
        print(f"{name}: {len(ref)} guitar notes in the tab ({', '.join(gnames)})", flush=True)
        if ref:
            jobs += [(name, m, ref, others, wav) for m in models]
    gpu = ThreadPoolExecutor(1)
    split = [gpu.submit(raw_output, ns, wav, m, real.CACHE / name / f"notecheck-{m}") for name, m, _, _, wav in jobs]
    sig = json.dumps(GRID, sort_keys=True) + f" {TOL}"
    for (name, m, ref, others, wav), fut in zip(jobs, split):
        t0 = time.time()
        cache = real.CACHE / name / f"notecheck-{m}"
        done = cache / "grid.json"
        if done.exists() and json.loads(done.read_text(encoding="utf-8")).get("sig") == sig:
            res = json.loads(done.read_text(encoding="utf-8"))["res"]
        else:
            fut.result()
            res = {}
            for base, ev in pool.imap_unordered(_job, [(str(cache / "basic_pitch.npz"), b) for b in makes]):
                for amp in GRID["min_amp"]:
                    st = {**base, "min_amp": amp}
                    res[key(st)] = score(ref, [(t, p) for t, p, a in ev if a >= amp], others)
            done.write_text(json.dumps({"sig": sig, "res": res}), encoding="utf-8")
        results.setdefault(name, {})[m] = res
        now = res[key(NOW)]
        best = max(res, key=lambda k: res[k]["f1"])
        print(f"{name} · {m:12s} now F1 {now['f1']:.3f} (recall {now['recall']:.2f}, precision {now['precision']:.2f}) · "
              f"best {res[best]['f1']:.3f} at {best}  ({time.time() - t0:.0f} s)", flush=True)
    gpu.shutdown()
    (run.OUT / "notecheck.json").write_text(json.dumps(results, indent=1), encoding="utf-8")

    # the mean over songs, per model and setting
    names = list(results)
    rows = []
    for m in models:
        for s in settings:
            k = key(s)
            got = [results[n][m][k] for n in names if m in results[n]]
            if len(got) == len(names) and got:
                rows.append((float(np.mean([g["f1"] for g in got])), m, k,
                             float(np.mean([g["recall"] for g in got])), float(np.mean([g["precision"] for g in got])),
                             [g["f1"] for g in got]))
    rows.sort(reverse=True)
    lines = ["# Guitar notes vs the official tab", "",
             f"{len(names)} songs: " + ", ".join(names), "",
             f"F1 / recall / precision of the tab's guitar notes (right pitch, start within {TOL * 1000:.0f} ms), mean over the songs. "
             "**now** = the notebook's current settings.", "",
             "| Model | Setting | F1 | Recall | Precision | Per song |", "|---|---|---|---|---|---|"]
    shown = rows[:15] + [r for r in rows[15:] if r[2] == key(NOW)]
    for f1, m, k, rc, pr, per in shown:
        mark = " **now**" if k == key(NOW) else ""
        lines.append(f"| {m} | {k}{mark} | {f1:.3f} | {rc:.2f} | {pr:.2f} | {' '.join(f'{x:.2f}' for x in per)} |")
    (run.OUT / "notecheck.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n" + "\n".join(lines[6:6 + 2 + min(10, len(shown))]))
    for m in models:
        now = next((r for r in rows if r[1] == m and r[2] == key(NOW)), None)
        if now:
            print(f"{m} with the current settings: F1 {now[0]:.3f}")


if __name__ == "__main__":
    main()
