"""One song two ways, to compare by ear: one steady tempo, and gently stretched section by section.

    python tests/yt2gp5/compare.py NAME

Writes beside the song in out/listen/<song>/:
  <title> (steady).fretboard      the song's sync as it is (one tempo and a start)
  <title> (stretched).fretboard   the same, eased section by section onto the recording
and prints the gate's verdict and the note timing for both. Import both into Fretboard (they have different
titles, so both stay) and play them with 🎸 Mine on.

The stretch is not the old per-bar beat fit (--fit, which made Be My Escape jump at bars 92-93). Each 4-bar
stretch is moved to where the tab's own sound lines up best with the recording, at most 0.4 beat a round so
it can't slip onto the off-beat, only when that lines up clearly better, and the moves are smoothed over the
stretches round it so the tempo bends slowly instead of jumping.
"""
import copy
import json
import sys
from pathlib import Path

import numpy as np
from scipy.interpolate import PchipInterpolator

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import qa  # noqa: E402
import syncqa  # noqa: E402
from syncqa import Sync  # noqa: E402

ROUNDS = 4
MOST_BEAT = 0.4   # the most a stretch moves each round, in beats
CLEAR = 0.03      # it moves only when its best shift lines up this much better than no shift


def bend(sync, bars, tab_env, env):
    x = np.array([b[0] for b in bars])
    y = sync(x)
    for _ in range(ROUNDS):
        cur = Sync(x, y)
        mids, moves = [], []
        for p in range(0, len(bars), syncqa.STRETCH):
            q = min(len(bars), p + syncqa.STRETCH)
            beat = (bars[q - 1][1] - bars[p][0]) / max(1, sum(b[2] for b in bars[p:q]))
            lags, c = syncqa.lag_curve(cur, tab_env, env, most=MOST_BEAT * beat, part=(bars[p][0], bars[q - 1][1]))
            i, z = int(np.argmax(c)), int(np.argmin(np.abs(lags)))
            mids.append((bars[p][0] + bars[q - 1][1]) / 2)
            moves.append(float(lags[i]) if c[i] - c[z] >= CLEAR else 0.0)
        m = np.array(moves)
        sm = np.convolve(np.pad(m, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")  # with the stretches round it
        y = y + PchipInterpolator(mids, sm, extrapolate=False)(np.clip(x, mids[0], mids[-1]))  # a smooth bend
        y = np.maximum.accumulate(y + np.arange(len(y)) * 1e-4)  # never backwards
    # Then the whole song back onto its best spot, like the steady one, so only the bending differs. (Without
    # it the stretch sat 10 ms later, which the note count below likes for the wrong reason: a recording's
    # note-start peak comes ~10 ms after the note's written time, so moving a steady sync 10 ms later also
    # takes Be My Escape from 66 % to 81 %. The whole-song line-up compares like with like: no such lean.)
    lags, c = syncqa.lag_curve(Sync(x, y), tab_env, env, most=0.1)
    return Sync(x, y + float(lags[np.argmax(c)]))


def note_timing(s, sync):
    """Share of the tab's note starts heard within 30 ms in the recording. It leans ~10 ms late (see bend):
    compare two syncs only at the same whole-song spot."""
    env_t = np.arange(len(s["env"])) * syncqa.HOP / syncqa.SR
    notes = json.loads((s["out"] / "notes.json").read_text(encoding="utf-8"))
    keep = {t["index"] for t in s["info"]["tracks"]}
    starts = sorted({round(n["start"], 2) for n in notes["notes"] if n["track"] in keep})
    errs = []
    for t in starts:
        v = float(sync(t))
        a, z = np.searchsorted(env_t, [v - syncqa.NOTE_WIN, v + syncqa.NOTE_WIN])
        if z - a < 3:
            continue
        i = a + int(np.argmax(s["env"][a:z]))
        local = np.median(s["env"][max(0, i - 100):i + 100]) + 1e-6
        if s["env"][i] / local < 2 or i in (a, z - 1):
            continue
        errs.append(abs(env_t[i] - v) * 1000)
    e = np.array(errs)
    return round(100 * float(np.mean(e <= 30)), 1), round(float(np.median(e)), 1)


def points_of(sync, bars):
    out, last = [], -1
    for p, v in enumerate(sync(np.array([b[0] for b in bars]))):
        ms = max(0, int(round(float(v) * 1000)))
        if ms > last:
            out.append([p, ms])
            last = ms
    return out


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        sys.exit(__doc__)
    s = qa.load(sys.argv[1])
    bars = s["bars"]
    steady = Sync.from_points([b[0] for b in bars], s["points"])
    stretched = bend(steady, bars, s["tab_env"], s["env"])
    fb = next(p for p in s["out"].glob("*.fretboard") if "(" not in p.stem)
    shared = json.loads(fb.read_text(encoding="utf-8"))
    title = shared["songs"][0]["title"]
    for name, sync in (("steady", steady), ("stretched", stretched)):
        pts = points_of(sync, bars)
        v = qa.judge(s, points=pts)
        within, typical = note_timing(s, sync)
        x = np.array([b[0] for b in bars])
        bpm = 60 * np.array([b[2] for b in bars[:-1]]) / np.diff(sync(x))
        swing = round(100 * float((np.percentile(bpm, 95) - np.percentile(bpm, 5)) / np.median(bpm)), 1)
        print(f"{name:9} {v['verdict']:6} notes within 30 ms {within}%, typical {typical} ms, whole song off {v.get('off_ms')} ms, "
              f"tempo moves {swing}% over the song")
        for f in v["fails"]:
            print(f"          {f}")
        out = copy.deepcopy(shared)
        e = out["songs"][0]
        e["title"] = f"{title} ({name})"
        e["syncPoints"] = pts
        path = s["out"] / f"{fb.stem} ({name}).fretboard"
        path.write_text(json.dumps(out), encoding="utf-8")
        print(f"          {path}")


if __name__ == "__main__":
    main()
