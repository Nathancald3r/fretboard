"""Calibrate wavefit's wide start search on the truth benchmark: for each case and starting line, the shift it finds and its
gain next to the true shift. Not part of the pipeline.   python tests/yt2gp5/startcal.py [--jobs 2]"""
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import numpy as np  # noqa: E402

import truthbench as tb  # noqa: E402
import wavefit as wf  # noqa: E402

PICK = (("steady", "full"), ("hohey", "full"), ("step", "partial"), ("steady", "wrong"))


def one(args):
    song, clk, content, start = args
    wf.START_GAIN, wf.START_MIN = -99, 0.0
    d = tb.song_data(song)
    c = next(c for c in d["cases"] if (c["clock"], c["content"]) == (clk, content))
    layers = {"mix": (c["tab_curve"], d["rec_curve"])}
    base = tb.start_line(c["bars_t"], c["truth"], start, tb.rng_of(song, c["clock"], c["content"], start))
    true_shift = float(np.median(c["truth"] - base(c["bars_t"])))
    out = {"song": song, "clock": clk, "content": content, "start": start, "true": true_shift}
    for name, harm, pulse in (("harm", (c["tab_c"], d["rec_c"]), None), ("full", (c["tab_c"], d["rec_c"]), tb.pulse_of(song, len(d["rec_curve"])))):
        nb, shift, gain = wf.wide_start(layers, c["bars_t"], base, harm, pulse)
        got = float(np.median(nb(c["bars_t"]) - base(c["bars_t"])))
        out[name] = {"shift": shift, "gain": gain, "err": float(np.median(nb(c["bars_t"]) - c["truth"]))}
    return out


if __name__ == "__main__":
    songs = json.loads((tb.OUT / "songs.json").read_text(encoding="utf-8"))
    jobs = int(sys.argv[sys.argv.index("--jobs") + 1]) if "--jobs" in sys.argv else 2
    tasks = [(s, k, ct, st) for s in songs for k, ct in PICK for st in tb.STARTS]
    with ProcessPoolExecutor(jobs) as ex:
        rows = list(ex.map(one, tasks, chunksize=2))
    (tb.OUT / "startcal2.json").write_text(json.dumps(rows), encoding="utf-8")
    for name in ("harm", "full"):
        print(name)
        for grp, sel in (("true shift < 0.8 s", lambda r: abs(r["true"]) < 0.8), ("true shift 0.8-3 s", lambda r: 0.8 <= abs(r["true"]) < 3), ("true shift > 3 s", lambda r: abs(r["true"]) >= 3)):
            g = [r for r in rows if sel(r)]
            if not g:
                continue
            gains = np.array([r[name]["gain"] for r in g]); err = np.array([abs(r[name]["err"]) for r in g])
            print(f"  {grp:20} n={len(g):3}  gain min/med/max {gains.min():5.2f} {np.median(gains):5.2f} {gains.max():5.2f}  right (|err|<0.15 s) {int((err < 0.15).sum())} of {len(g)}")
