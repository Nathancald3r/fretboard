"""The sync fixer: try every way of syncing a song, judge each with the gate (qa.py), keep the best.

    python tests/yt2gp5/fixsync.py NAME      one song from out/listen (part of its name is enough)
    python tests/yt2gp5/fixsync.py --all     every song there
    python tests/yt2gp5/fixsync.py --selftest  breaks each song that passes (qa.breaks: moved, too fast, a jump...)
                                               and the fixer must bring each back to its verdict
    add --dry to only print what it would keep

The tries, all from the recording itself:
  as made      the song's own .fretboard as it is
  files        the variants beside it ("(steady)", "(stretched)", "(key points)"...)
  one tempo    syncqa.one_tempo: one steady tempo and the start
  sections     syncqa.section_tempo: one tempo per section of the tab
  drums        each of the above moved by the drum clock: every clear 4-bar stretch's offset, eased between
               stretches (so no bar changes speed by more than the gate allows), and the song's own level
Each is judged by qa.judge; the best verdict wins (PASS, then LISTEN, then FAIL), then the fewest problems,
then the fewest drifting bars. Only a better verdict is written into the song's own .fretboard (the old one kept as
"<song> (before fix).fretboard") with what it was. Nothing here needs a person to listen; the gate's own
self-test (qa.py --selftest) is what makes its verdicts worth trusting.
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import drumclock  # noqa: E402
import qa  # noqa: E402
import syncqa  # noqa: E402

RANK = {"PASS": 0, "LISTEN": 1, "FAIL": 2}


def points_of(sync, bars):
    """A Sync as the song's sync points: every bar's start in the video (ms), always moving on."""
    out, last = [], -1
    for p, b in enumerate(bars):
        ms = max(0, int(round(float(sync(b[0])) * 1000)))
        if ms > last:
            out.append([p, ms])
            last = ms
    return out


def drum_moved(s, points):
    """The points moved onto the drums: each clear stretch by its offset, eased in between, or None."""
    c = drumclock.clock(s, points)
    if not c["sure"]:
        return None
    rows = [r for r in c["stretches"] if r["ms"] is not None]
    if len(rows) < 2:
        return None
    mid = np.array([(r["bars"][0] - 1 + r["bars"][1]) / 2 for r in rows])  # stretch centres, 0-based bars
    off = np.array([r["ms"] for r in rows])
    # sign: a recording beat earlier than the sync (negative) moves the sync earlier
    move = np.interp([p for p, _ in points], mid, off)
    return [[p, int(round(ms + d))] for (p, ms), d in zip(points, move)]


def tries(s, files=True):
    """(name, points, sections) for every way of syncing song `s`."""
    bars, info = s["bars"], s["info"]
    look = syncqa.Look(s["tab_env"], s["env"], s["tab_c"], s["rec_c"], info["shift"])
    out = [("as made", sorted(s["points"]), s["sections"])]
    for f in sorted(s["out"].glob("*.fretboard")) if files else []:
        if "(" in f.stem and "before fix" not in f.stem:
            e = json.loads(f.read_text(encoding="utf-8"))["songs"][0]
            secs = ((e.get("autoSync") or {}).get("beats") or {}).get("tempo_sections") or []
            out.append((f.stem.split("(")[-1].rstrip(")"), sorted(e["syncPoints"]), [p - 1 for p in secs]))
    one = syncqa.one_tempo(syncqa.raw_line(info, bars), bars, s["tab_env"], s["env"], look)
    out.append(("one tempo", points_of(one, bars), []))
    notes = json.loads((s["out"] / "notes.json").read_text(encoding="utf-8"))
    starts = syncqa.section_starts(notes, len(bars))
    if len(starts) > 1:
        out.append(("sections", points_of(syncqa.section_tempo(one, bars, starts, look), bars), starts))
    try:  # the note starts of the tab against the recording's, window by window (wavefit.py)
        import wavefit
        w = wavefit.fit_song(info["slug"], base_points=sorted(s["points"]), say=lambda *a: None)
        out.append(("wavefit", w["points"], w["sections"]))
        e = wavefit.fit_song(info["slug"], base_points=sorted(s["points"]), say=lambda *a: None, ending=True)  # the band slowing down at the end
        if list(e["knots"]) != list(w["knots"]):
            out.append(("wavefit + ending", e["points"], e["sections"]))
    except Exception as e:  # no stems or saved tracks, or too few clear note starts: this try is left out
        print(f"  (wavefit left out: {e})")
    for name, pts, secs in list(out):
        moved = drum_moved(s, pts)
        if moved:
            out.append((f"{name} + drums", moved, secs))
    return out


def score(v):
    drift = sum(b - a + 1 for a, b in v.get("drift_bars", []))
    return RANK[v["verdict"]], len(v["fails"]) + len(v["listen"]), drift


def fix(name, dry=False):
    s = qa.load(name)
    rows = []
    for t, pts, secs in tries(s):
        v = qa.judge({**s, "sections": secs}, points=pts)
        rows.append((score(v), t, pts, secs, v))
        print(f"  {v['verdict']:6} {t:28} {len(v['fails'])} fails, {len(v['listen'])} listens, "
              f"{score(v)[2]} bars drift" + (f": {v['fails'][0][:70]}" if v["fails"] else ""))
    best = min(rows, key=lambda r: r[0])
    (_, t, pts, secs, v), base = best, rows[0]
    print(f"{s['song']['name']}: best is {t} ({v['verdict']}, was {base[4]['verdict']})")
    if dry or best[0][0] >= base[0][0]:  # written only when the verdict itself gets better
        return v
    fb = min(s["out"].glob("*.fretboard"), key=lambda p: ("(" in p.stem, p.name))
    keep = fb.with_name(f"{fb.stem} (before fix).fretboard")
    if not keep.exists():
        shutil.copyfile(fb, keep)
    doc = json.loads(fb.read_text(encoding="utf-8"))
    e = doc["songs"][0]
    e["syncPoints"] = pts
    e.setdefault("autoSync", {})["fixed"] = {"by": t, "verdict": v["verdict"], "was": base[4]["verdict"]}
    beats = e["autoSync"].setdefault("beats", {})
    beats["tempo_sections"] = [p + 1 for p in secs]  # 1-based in the file, as syncqa.improve writes them
    fb.write_text(json.dumps(doc), encoding="utf-8")
    print(f"  written into {fb.name} (the old one is {keep.name})")
    return v


def best(s, files=True):
    """(verdict, try name) of the best try, quietly."""
    rows = [(score(v), t, v) for t, pts, secs in tries(s, files) for v in [qa.judge({**s, "sections": secs}, points=pts)]]
    sc, t, v = min(rows, key=lambda r: r[0])
    return v["verdict"], t


def selftest(names):
    right = total = 0
    for n in names:
        s = qa.load(n)
        want = qa.judge(s)["verdict"]
        if want == "FAIL":
            continue
        for case, pts in qa.breaks(s, None).items():
            if isinstance(pts, tuple):  # the wrong recording, the tab a bar short: no sync can fix those
                continue
            # the broken points are the song's own; the variant files beside it would give the answer away
            got, t = best({**s, "points": pts}, files=False)
            good = RANK[got] <= RANK[want]
            right += good
            total += 1
            print(f"  {'ok ' if good else 'BAD'} {n[:30]:30} {case:26} back to {got:6} by {t}")
    print(f"THE FIXER {'WORKS' if right == total else 'MISSES'}: {right} of {total} broken syncs fixed")
    return right == total


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
    if a[0] == "--selftest":
        sys.exit(0 if selftest(qa.ready()) else 1)
    dry = "--dry" in a
    names = qa.ready() if "--all" in a else [" ".join(x for x in a if not x.startswith("--"))]
    for n in names:
        print(n)
        fix(n, dry)


if __name__ == "__main__":
    main()
