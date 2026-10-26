"""Proves the sync on songs where the right answer is known: the tab's own sound as the "recording",
moved and slowed by known amounts. If the sync can't get these exactly right, the fault is in the sync,
not in the song.

    python tests/yt2gp5/synctest.py [NAME]        NAME: the song whose tab is used (default Be My Escape)
    python tests/yt2gp5/synctest.py NAME -k CASE  one case only

Each case writes a fake recording, runs the same steps as listen.py --export (line-up, one tempo, the QA
gate) and compares every bar's sync point with where that bar really is. Pass: every bar within 20 ms.
Results: out/synctest.json.
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VENV = Path.home() / ".fretboard" / "yt2gp5-venv" / "Scripts" / "python.exe"
if VENV.exists() and Path(sys.executable).resolve() != VENV.resolve():
    import subprocess
    sys.exit(subprocess.call([str(VENV), __file__, *sys.argv[1:]]))

import numpy as np  # noqa: E402

sys.path.insert(0, str(HERE))
import listen  # noqa: E402
import real  # noqa: E402
import run  # noqa: E402
import songdb  # noqa: E402

PASS_MS = 20
# name: (rec seconds per tab second, start delay s, what else)
CASES = {
    "copy": (1.0, 0.0, ""),
    "late3s": (1.0, 3.0, ""),
    "slow3pct": (1.03, 1.5, ""),
    "fast3pct": (0.97, 2.0, ""),
    "noisy": (1.015, 4.2, "noise+eq"),
}


def fake_recording(mix, sr, factor, delay, extra):
    import librosa
    y = mix.mean(axis=1)
    if factor != 1.0:
        y = librosa.effects.time_stretch(y, rate=1 / factor)
    rng = np.random.default_rng(1)
    if "eq" in extra:  # another sound: dull it (a one-pole low-pass), so it isn't the tab's exact timbre
        from scipy.signal import lfilter
        y = lfilter([0.15], [1, -0.85], y).astype(np.float32)
    y = np.concatenate([np.zeros(int(delay * sr), np.float32), y, np.zeros(int(3 * sr), np.float32)])
    if "noise" in extra:
        y = y + rng.normal(0, 0.02 * float(np.abs(y).max()), len(y)).astype(np.float32)
    y = 0.9 * y / float(np.abs(y).max())
    return np.stack([y, y], axis=1)


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    os.chdir(ROOT)
    a = sys.argv[1:]
    only = a[a.index("-k") + 1] if "-k" in a else None
    name = next((x for x in a if not x.startswith("-") and x != only), "Be My Escape")
    db = songdb.load()
    src = songdb.find_one(db, name)
    import soundfile as sf
    import hashlib
    folder = real.CACHE / run.slug(src["name"])
    mix_wav = folder / f"gp-{hashlib.sha1(Path(src['gp']).read_bytes()).hexdigest()[:12]}" / "mix.wav"
    if not mix_wav.exists():
        sys.exit(f"run listen.py \"{src['name']}\" --export first (it renders the tab)")
    mix, sr = sf.read(str(mix_wav), dtype="float32", always_2d=True)
    results = []
    fake = []
    songdb.load = lambda *_: {**db, "songs": db["songs"] + fake}  # the test songs exist only in this run
    import qa
    import syncqa
    for case, (factor, delay, extra) in CASES.items():
        if only and case != only:
            continue
        song = {**src, "name": f"SYNCTEST {src['title']} {case}", "youtube": f"https://www.youtube.com/watch?v=synctest-{case}"}
        fake.append(song)
        f = real.CACHE / run.slug(song["name"])
        f.mkdir(parents=True, exist_ok=True)
        wav = f / f"recording-synctest-{case}.wav"
        if not wav.exists():
            sf.write(str(wav), fake_recording(mix, sr, factor, delay, extra), sr)
        print(f"\n=== {case}: tempo x{factor}, starts {delay} s late {extra}")
        out = listen.OUT / run.slug(song["name"])
        if not (out / "info.json").exists():
            listen.build(song, song["youtube"])
        info = json.loads((out / "info.json").read_text(encoding="utf-8"))
        fb = listen.fretboard_file(song, info, out)
        fb.with_suffix(".fretboard.before").unlink(missing_ok=True)
        syncqa.improve(song, quiet=True)
        verdict = qa.judge(qa.load(song["name"]))
        pts = json.loads(fb.read_text(encoding="utf-8"))["songs"][0]["syncPoints"]
        bar_t = np.array([b[0] for b in info["bars"]])
        truth = delay + factor * bar_t
        err = np.array([p[1] / 1000 - truth[p[0]] for p in pts]) * 1000
        r = {"case": case, "factor": factor, "delay": delay, "extra": extra, "verdict": verdict["verdict"],
             "fails": verdict.get("fails"), "median_ms": round(float(np.median(err)), 1),
             "worst_ms": round(float(np.abs(err).max()), 1), "bars": len(pts),
             "pass": bool(np.abs(err).max() <= PASS_MS)}
        results.append(r)
        print(f"  {'PASS' if r['pass'] else 'FAIL'}: bars off by median {r['median_ms']} ms, worst {r['worst_ms']} ms; gate {r['verdict']} {r['fails'] or ''}")
    (listen.OUT.parent / "synctest.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"\n{sum(r['pass'] for r in results)} of {len(results)} cases right")
    sys.exit(0 if all(r["pass"] for r in results) else 1)


if __name__ == "__main__":
    main()
