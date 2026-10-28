"""The quality gate: one verdict per exported song, so the workflow can run on its own.

    python tests/yt2gp5/qa.py NAME              the verdict for one song (PASS, LISTEN or FAIL, and why)
    python tests/yt2gp5/qa.py --all             every song in out/listen
    python tests/yt2gp5/qa.py --selftest        proves the gate works: each good song must pass, and each of
                                                its syncs broken on purpose must fail

PASS    the tab is the recording, all the way through, on one steady tempo (or one per section, for a band
        that changes speed), within 15 ms. Ship it.
LISTEN  it passes, but a person should hear some bars (the tab's rhythm half a beat out there, parts left out).
FAIL    don't ship: the wrong recording, a sync that is off, drifts, jumps, or runs past the recording.
TIMING ONLY (a LISTEN with "deliver": true, 2026-10-28, asked by the user: "timing is the goal, not notes"): the match check
        says the tab isn't the band's version (other chords, an extra intro), but every timing check below passes and
        the mean chord distance is at most TIMING_DIST_MAX. The sync is right, so the worker delivers it. Any other
        fail, or a listen about a step or a half beat, keeps it from being delivered.

The checks (all from the recording itself; Beat This! only checks an ending's slow-down, see "ending" below, since it can sit on the off-beats):
  match    real.whole_match said the recording is this tab all the way through (listen.py's info "ok"). A
           free intro is a LISTEN: only stretches in the first FREE_INTRO_S of the tab fail (other chords, or the
           band taking longer), by at most FREE_INTRO_LONGER_S, and the rest matches
  points   the sync has a point for every bar, always moving on, starting at 0 or later and ending inside the
           recording
  speed    no bar faster or slower than the bar before by over 1 % (one steady tempo has none), except where
           a section of the tab starts, in a sync with one tempo per section (up to SECTION_JUMP_PCT)
  lock     the tab's sound lines up with the recording's at 0 (syncqa.locate: the harmony picks the eighth note) (the best of every shift of the whole song is
           within 15 ms), and clearly (LOCK_MIN over the average shift: the wrong recording barely lines up)
  steady   every 4-bar stretch lines up at 0 or half a beat out (syncqa.steadiness); a drifting stretch means
           a bar lost or gained, the wrong tempo, or a band that changes speed. One inside a free intro, the
           ending, a single spot or a step (syncqa.differences) is a LISTEN; a bar more or less is a FAIL
  ending   a band that slows at the ending while the tab keeps its tempo makes the sync bend there (speed jumps, a
           drifting last stretch). That is excused (a note, not a fail) when it starts in the last END_ZONE bars,
           every bar line from one bar before it to the end sits within BEAT_TOL_MS of one Beat This! finds in this
           recording (wavefit_beats.json) and those bars last END_SLOW times the median bar (followed_ending).
           Without that, or with the sync off the tracker's bar lines, it is judged as before
  drums    the drum clock (drumclock.py: the Demucs drums stem folded onto the tab's drum notes, every 4 bars,
           to a few ms) settles each step: on time there (within drumclock.STEP_MS) drops the LISTEN, clearly
           off is a FAIL, no clear drums keeps the LISTEN. A step the clock finds by itself is a FAIL. Drums
           that sit off the sync everywhere are a LISTEN (the clock can't be read there)

The self-test breaks each good song's sync nine ways (moved 30 ms and 60 ms, half a beat, 1 % too fast,
a bar lost in the middle, a stray jump in one bar, a slow-down at the ending the band didn't play, the wrong
recording, and the tab a bar short with a steady sync, so no jump gives it away). The gate works when every good song
passes and every broken one fails. Writes out/qa.json (every verdict) and out/qa_selftest.json.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import listen  # noqa: E402
import real  # noqa: E402
import run  # noqa: E402
import syncqa  # noqa: E402
import drumclock  # noqa: E402
from syncqa import HOP, SR, Sync  # noqa: E402

OFF_MS = 15       # the whole song may be this far off
LOCK_MIN = 0.08   # how much better the line-up at 0 must be than the average shift (Be My Escape 0.3+)
JUMP_PCT = 1.0    # a bar this much faster or slower than the bar before is a jump
END_S = 1.0       # the last bar may start at most this far past the recording's end
SECTION_JUMP_PCT = 2 * syncqa.SECTION_PCT  # a tempo change where a section starts (one tempo per section)
FREE_INTRO_S = 20.0         # a free intro: the match may fail only in this much of the tab's start
FREE_INTRO_LONGER_S = 10.0  # and the band may take this much longer over it
TIMING_DIST_MAX = 0.2       # timing-only: the tab's chords may differ from the recording's by at most this (mean chord distance; real songs 0.09-0.16)
END_ZONE = 10               # a slow-down at the ending is excused only when it starts in the last this many bars
BEAT_TOL_MS = 100           # ...and every bar line from one bar before it to the end sits this close to a bar line Beat This! finds in the recording
END_SLOW = (1.0, 1.6)       # ...and those bars last this many times the song's median bar (a slow-down, not a bar lost or a speed-up)


def followed_ending(ps, nbars, jumps, drift, downbeats):
    """The first bar (1-based) of an ending's slow-down that the sync follows, or None. A band slows at the ending and the tab
    keeps its tempo, so a sync that follows it bends there, and the checks that want a steady tempo (speed, steady) would fail
    it. Excused only with an independent read of the same recording: Beat This!'s bar lines. Here I Am's first file sat 0.6-0.95 s
    off them in its last four bars and sounded wrong; the file that follows them sounds right (the user, 2026-10-28)."""
    if downbeats is None or not len(downbeats):
        return None
    late = [b for b in list(jumps) + [r[0] for r in drift] if b > nbars - END_ZONE]
    if not late:
        return None
    first = min(late) - 1
    tail = [ms / 1000 for b, ms in ps if b + 1 >= first]
    if len(tail) < 3 or any(np.abs(downbeats - t).min() > BEAT_TOL_MS / 1000 for t in tail):
        return None
    median = float(np.median(np.diff([ms / 1000 for _, ms in ps])))
    ratio = (tail[-1] - tail[0]) / (len(tail) - 1) / max(1e-9, median)
    return first if END_SLOW[0] <= ratio <= END_SLOW[1] else None


def free_intro(info):
    """The match failed only on a free intro: every stretch that failed lies in the tab's first FREE_INTRO_S,
    none is shorter in the recording or more than FREE_INTRO_LONGER_S longer, the key is the same and nothing
    is left over at the ends. Returns the seconds of the tab it covers, else None."""
    parts = info.get("parts") or []
    bad = [p for p in parts if p.get("why")]
    if not bad or info.get("shift") or abs(info.get("head_s", 99)) > 6 or abs(info.get("tail_s", 99)) > 6:
        return None
    t0 = parts[0]["tab"][0]
    for p in bad:
        if p["tab"][1] - t0 > FREE_INTRO_S + 1 or "shorter" in p["why"]:
            return None
        if "longer" in p["why"] and float(p["why"].split("recording ")[1].split(" s")[0]) > FREE_INTRO_LONGER_S:
            return None
    return max(p["tab"][1] for p in bad) - t0


def features(out, song, info):
    """The recording's and the tab's note-start strength (cached beside the song)."""
    import librosa
    f = out / "qa_env.npz"
    wav = real.CACHE / run.slug(song["name"]) / f"recording-{info['url'].split('v=')[-1].split('&')[0]}.wav"
    if f.exists() and wav.exists():
        import wave
        with wave.open(str(wav)) as w:
            seconds = w.getnframes() / w.getframerate()
        d = np.load(f)
        # the same tab and the same recording: a new link gives another length (Ho Hey was judged on its old video, 2026-10-27)
        if str(d["sha"]) == info["gp_sha"] and "rec_c" in d and abs(float(d["length"]) - seconds) < 0.2:
            return d["env"], d["tab_env"], d["rec_c"], d["tab_c"], float(d["length"])
    wav = real.download(info["url"], real.CACHE / run.slug(song["name"]))
    rec, _ = librosa.load(str(wav), sr=SR, mono=True)
    mix = syncqa.tab_mix(song, info)
    env = librosa.onset.onset_strength(y=rec, sr=SR, hop_length=HOP)
    tab_env = librosa.onset.onset_strength(y=mix, sr=SR, hop_length=HOP)
    rec_c, tab_c = syncqa.chroma(rec), syncqa.chroma(mix)
    np.savez(f, env=env, tab_env=tab_env, rec_c=rec_c, tab_c=tab_c, length=len(rec) / SR, sha=info["gp_sha"])
    return env, tab_env, rec_c, tab_c, len(rec) / SR


def load(name):
    """Everything the gate needs for one song in out/listen."""
    import songdb
    db = songdb.load()
    song = next((x for x in db["songs"] if x["name"] == name), None) or songdb.find_one(db, name)
    out = listen.OUT / run.slug(song["name"])
    info = json.loads((out / "info.json").read_text(encoding="utf-8"))
    notes = json.loads((out / "notes.json").read_text(encoding="utf-8"))
    # the song's own file, not the variants beside it ("(steady)", "(key points)"...)
    fb = min(out.glob("*.fretboard"), key=lambda p: ("(" in p.stem, p.name))
    entry = json.loads(fb.read_text(encoding="utf-8"))["songs"][0]
    bars = syncqa.tab_bars(info, notes)
    env, tab_env, rec_c, tab_c, length = features(out, song, info)
    sections = ((entry.get("autoSync") or {}).get("beats") or {}).get("tempo_sections") or []
    # Beat This!'s bar lines for this very recording (wavefit's cache), the check on an ending's slow-down
    rid = (entry.get("recording") or {}).get("id") or (re.search(r"v=([\w-]+)", info.get("url") or "") or [None, None])[1]
    saved = (out / "wavefit_beats.json")
    saved = json.loads(saved.read_text(encoding="utf-8")) if saved.exists() else {}
    downs = np.array(saved["downbeats"], float) if rid and (saved.get("key") or {}).get("vid") == rid and saved.get("downbeats") else None
    return {"song": song, "out": out, "info": info, "bars": bars, "points": entry["syncPoints"], "downbeats": downs,
            "env": env, "tab_env": tab_env, "rec_c": rec_c, "tab_c": tab_c, "length": length,
            "sections": [p - 1 for p in sections]}


def judge(s, points=None, env=None, rec_c=None):
    """The verdict for a song's sync points (its own, unless others are given to test)."""
    bars, info = s["bars"], s["info"]
    points = s["points"] if points is None else points
    env = s["env"] if env is None else env
    look = syncqa.Look(s["tab_env"], env, s["tab_c"], s["rec_c"] if rec_c is None else rec_c, info["shift"])
    length = len(env) * HOP / SR
    fails, listens = [], []
    intro = None if info.get("ok") else free_intro(info)
    differs = None  # the tab isn't the recording all the way through: judged last, once the timing checks are in
    if intro:
        listens.append(f"match: a free intro, listen to the first {intro:.0f} s (the rest is this tab all the way through)")
    elif not info.get("ok"):
        differs = f"the recording isn't this tab all the way through (chord distance {info.get('dist')}, worst {info.get('worst')})"
    ps = sorted(points)
    have = {p for p, _ in ps}
    if len(have) < len(bars):
        fails.append(f"points: {len(bars) - len(have)} of {len(bars)} bars have no sync point")
    if any(b[1] <= a[1] for a, b in zip(ps, ps[1:])):
        fails.append("points: the sync goes backwards")
    if ps and ps[-1][1] / 1000 > length + END_S:
        fails.append(f"points: the last bar starts {ps[-1][1] / 1000 - length:.1f} s after the recording ends")
    if len(ps) < 2:
        return {"verdict": "FAIL", "fails": ([f"match: {differs}"] if differs else []) + (fails or ["points: no sync"]), "listen": [], "deliver": False}
    sync = Sync.from_points([b[0] for b in bars], ps)
    # speed: each bar's tempo in the video (bars with a point at both ends)
    x = np.array([bars[p][0] for p, _ in ps])
    y = np.array([ms / 1000 for _, ms in ps])
    rate = np.diff(y) / np.maximum(1e-6, np.diff(x))
    jump = 100 * np.abs(np.diff(rate)) / rate[:-1]
    # a sync with one tempo per section changes speed where a section of the tab starts, and only there
    at_section = np.array([ps[i + 1][0] in s["sections"] for i in range(len(jump))], bool)
    jump = np.where(at_section & (jump <= SECTION_JUMP_PCT), 0, jump)
    # where the tab's own tempo changes and the recording keeps its beat (Stressed Out: 85 BPM all through, the tab 74 later),
    # the video's time per beat stays level; that is the tab's tempo map, not a jump in the sync
    beats = np.array([sum(b[2] for b in bars[ps[i][0]:ps[i + 1][0]]) for i in range(len(ps) - 1)], float)
    per_beat = np.diff(y) / np.maximum(1e-6, beats)
    level = 100 * np.abs(np.diff(per_beat)) / np.maximum(1e-9, per_beat[:-1]) <= JUMP_PCT
    # or the recording plays a short or long bar the tab writes as a full one: that bar lasts a whole number of the song's beats, not the tab's
    bar_beats = np.diff(y) / max(1e-9, float(np.median(per_beat)))
    odd = (np.abs(bar_beats - np.rint(bar_beats)) <= 0.15) & (np.rint(bar_beats) >= 1) & (np.rint(bar_beats) != beats)
    jump = np.where(at_section & (level | odd[:-1] | odd[1:]), 0, jump)
    where = [ps[i + 1][0] + 1 for i in np.flatnonzero(jump > JUMP_PCT)]
    st = syncqa.steadiness(sync, bars, s["tab_env"], env, look)
    # the band slows at the ending and the sync follows it (every bar line there is one Beat This! finds in this recording):
    # no jump and no drift, a note instead. The real recording only, like the drum clock.
    notes = []
    tail = followed_ending(ps, len(bars), where, st["drift_bars"], s.get("downbeats")) if env is s["env"] else None
    if tail:
        where = [b for b in where if b <= tail]
        notes.append(f"bars {tail}-{len(bars)}: the band slows at the ending and the sync follows its bar lines (Beat This!, within {BEAT_TOL_MS} ms)")
    drift = [r for r in st["drift_bars"] if not tail or r[0] <= tail]
    if where:
        fails.append(f"speed: the tempo jumps at bar{'s' if len(where) > 1 else ''} {', '.join(map(str, where[:6]))}{'…' if len(where) > 6 else ''}")
    # lock: the whole song at 0, and clearly
    lags, c = syncqa.lag_curve(sync, s["tab_env"], env)
    z = int(np.argmin(np.abs(lags)))
    off = round(1000 * syncqa.locate(sync, look)[0])
    lock = float(c[z] - np.mean(c))
    if abs(off) > OFF_MS:
        fails.append(f"lock: the whole song is {off:+d} ms off (it lines up best moved that far)")
    if lock < LOCK_MIN:
        fails.append(f"lock: the tab barely lines up with this recording ({lock:.2f}, needs {LOCK_MIN})")
    span = lambda bs: ", ".join(f"{a}-{b}" for a, b in bs)
    # a drifting stretch is explained (listen, not fail) where the tab and the recording are known to differ:
    # a free intro, the ending, one spot, or a step the note starts don't back (syncqa.differences)
    diffs = syncqa.differences(sync, bars, look) if drift else []
    if any(d["kind"] == "bar" for d in diffs):
        fails += [f"bar: {d['what']}" for d in diffs if d["kind"] == "bar"]
    seen = lambda r: any(d["kind"] != "bar" and d["bars"][0] <= r[1] and r[0] <= d["bars"][1] for d in diffs)
    left = [r for r in drift if not seen(r)]
    if left:
        fails.append(f"steady: bars {span(left)} drift off the tempo")
    clock = drums(s, points) if env is s["env"] else None  # the clock reads the real recording only
    if clock and not clock["sure"]:
        listens.append(f"drums: they sit {clock['level_ms']:+.0f} ms off the sync everywhere (the whole song off, or a drum part"
                       " the drummer doesn't play), so the drum clock can't check the steps")
    for d in diffs:
        if d["kind"] == "bar":
            continue
        where = f"bars {d['bars'][0]}-{d['bars'][1]}"
        r = drumclock.at(clock, *d["bars"]) if clock and clock["sure"] and d["kind"] == "step" else None
        if r and abs(r[0]) <= drumclock.STEP_MS:
            notes.append(f"{where}: {d['what']}, but the drums are on time there ({r[0]:+.0f} ± {r[1]:.0f} ms)")
        elif r:
            fails.append(f"drums: {where} sit {r[0]:+.0f} ± {r[1]:.0f} ms off the recording's drums")
        else:
            no = " (no clear drums there to check)" if clock and clock["sure"] and d["kind"] == "step" else ""
            listens.append(f"{where}: {d['what']}{no}")
    if clock and clock["sure"]:
        for x in clock["steps"]:
            if not any(d["kind"] == "step" and d["bars"][0] <= x["bars"][1] and x["bars"][0] <= d["bars"][1] for d in diffs):
                fails.append(f"drums: bars {x['bars'][0]}-{x['bars'][1]} sit {x['ms']:+.0f} ± {x['pm']:.0f} ms off the recording's drums")
    if st["half_beat_bars"]:
        listens.append(f"bars {span(st['half_beat_bars'])}: the tab's rhythm is half a beat out from the recording")
    out_parts = info.get("left_out") or []
    if out_parts:
        listens.append(f"parts left out (wrong bar count): {', '.join(out_parts)}")
    # Timing is the goal, not notes (the user, 2026-10-28; Stressed Out sounds synced, its tab has other chords): a tab that
    # differs from the recording is no sync failure when every timing check above passed and the recording is still plainly
    # this song. Then it is a LISTEN that the worker delivers; any other fail keeps it a FAIL, as before.
    timing_only = bool(differs) and not fails and (info.get("dist") or 0) <= TIMING_DIST_MAX
    if differs and timing_only:
        listens.insert(0, f"match: the tab's chords differ from the recording, but every timing check passes {differs[differs.index('(') :]}")
    elif differs:
        fails.insert(0, f"match: {differs}")
    verdict = "FAIL" if fails else "LISTEN" if listens else "PASS"
    # delivered: a PASS, or a timing-only LISTEN whose other listens only say a check can't tell (the drum clock), never a step or a half beat out
    deliver = verdict == "PASS" or (timing_only and all(l.startswith(("match:", "drums:")) for l in listens))
    return {"verdict": verdict, "deliver": deliver, "timing_only": timing_only, "fails": fails, "listen": listens, "notes": notes, "off_ms": off, "lock": round(lock, 3),
            "drum_level_ms": clock and clock["level_ms"], "drum_clear": clock and clock["clear"],
            "half_beat_bars": st["half_beat_bars"], "drift_bars": drift, "differences": diffs}


def drums(s, points):
    """The drum clock for these points, or None when the recording can't be split (no Demucs)."""
    try:
        return drumclock.clock(s, points)
    except ImportError as e:
        print(f"  (no drum clock: {e})")
        return None


def breaks(s, other):
    """The song's sync broken on purpose, each a way a sync goes wrong."""
    bars, ps = s["bars"], sorted(s["points"])
    ms = np.array([t for _, t in ps], float)
    beat = 1000 * float(np.median([(b[1] - b[0]) / max(1, b[2]) for b in bars]))
    mid = len(ps) // 2
    bar_ms = float(np.median(np.diff(ms)))
    as_points = lambda v: [[p, int(round(t))] for (p, _), t in zip(ps, v)]
    out = {
        "moved 30 ms": as_points(ms + 30),
        "moved 60 ms": as_points(ms - 60),
        "half a beat out": as_points(ms + beat / 2),
        "1 % too fast": as_points(ms[0] + (ms - ms[0]) / 1.01),
        "a bar lost in the middle": as_points(np.where(np.arange(len(ms)) >= mid, ms + bar_ms, ms)),
        "one bar jumps": as_points(np.where(np.arange(len(ms)) == mid, ms + 0.25 * bar_ms, ms)),
        # a slow-down the band didn't play: the last bars drift later, so no bar line sits on Beat This!'s (the ending's excuse must not apply)
        "an ending slow-down the band didn't play": as_points(ms + 0.06 * bar_ms * np.clip(np.arange(len(ms)) - (len(ms) - 7), 0, None)),
    }
    if other is not None:
        out["the wrong recording"] = ("env", other["env"], other["rec_c"])
    # The tab a bar short: the recording plays a bar the tab doesn't have (one bar copied in the middle),
    # and the sync is one steady line through where the bars really are, so no jump gives it away.
    a, b = (int(ms[i] / 1000 * SR / HOP) for i in (mid, mid + 1))
    env = np.concatenate([s["env"][:b], s["env"][a:b], s["env"][b:]])
    ca, cb = (int(round(f * HOP / syncqa.C_HOP)) for f in (a, b))
    rec_c = np.concatenate([s["rec_c"][:, :cb], s["rec_c"][:, ca:cb], s["rec_c"][:, cb:]], axis=1)
    true = np.where(np.arange(len(ms)) > mid, ms + (b - a) * HOP / SR * 1000, ms)
    line = np.polyval(np.polyfit(np.arange(len(ms)), true, 1), np.arange(len(ms)))
    out["the tab a bar short"] = ("both", as_points(line), env, rec_c)
    return out


def selftest(names):
    songs = {n: load(n) for n in names}
    rows, ok = [], True
    for n, s in songs.items():
        good = judge(s)
        passed = good["verdict"] != "FAIL"
        ok &= passed
        rows.append({"song": n, "case": "as made", "want": "pass", "got": good["verdict"], "right": passed, "why": good["fails"] + good["listen"]})
        other = next((load(m) for m in ready() if m != n), None)
        # the timing-only verdict: the same song, told its tab's chords differ. Right sync: a LISTEN the worker delivers (or a PASS
        # for a song that matches anyway); the wrong recording with those chords must still fail (the chords can't excuse it)
        odd = {**s, "info": {**s["info"], "ok": False, "dist": 0.14, "worst": 0.2, "head_s": 0.0, "tail_s": 0.0, "parts": []}}
        v = judge(odd)
        # delivered only where the song's own listens say nothing but "the chords differ" or "the drum clock can't tell";
        # a step, a half beat, a part left out or an intro the gate already listed keeps it for a person (How Great, Trust In God, Believer)
        plain = all(l.startswith(("match:", "drums:")) for l in good["listen"])
        right = v["verdict"] != "FAIL" and v["deliver"] == plain
        ok &= right
        rows.append({"song": n, "case": "the tab's chords differ", "want": "deliver", "got": f"{v['verdict']}{'+d' if v['deliver'] else ''}", "right": right,
                     "why": v["fails"] + v["listen"]})
        if other is not None:
            v = judge(odd, env=other["env"], rec_c=other["rec_c"])
            right = v["verdict"] == "FAIL" and not v["deliver"]
            ok &= right
            rows.append({"song": n, "case": "wrong recording, chords differ", "want": "FAIL", "got": v["verdict"], "right": right, "why": v["fails"]})
        for case, pts in breaks(s, other).items():
            got = (judge(s, env=pts[1], rec_c=pts[2]) if isinstance(pts, tuple) and pts[0] == "env" else
                   judge(s, points=pts[1], env=pts[2], rec_c=pts[3]) if isinstance(pts, tuple) else judge(s, points=pts))
            right = got["verdict"] == "FAIL"
            ok &= right
            rows.append({"song": n, "case": case, "want": "FAIL", "got": got["verdict"], "right": right, "why": got["fails"]})
    for r in rows:
        print(f"  {'ok ' if r['right'] else 'BAD'} {r['song'][:28]:28} {r['case']:26} want {r['want']:4}  got {r['got']:6}  {'; '.join(r['why'])[:110]}")
    print(f"\n{'THE GATE WORKS' if ok else 'THE GATE IS WRONG'}: {sum(r['right'] for r in rows)} of {len(rows)} cases right")
    (listen.OUT.parent / "qa_selftest.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return ok


def ready():
    """The songs in out/listen with everything the gate needs."""
    import songdb
    db = songdb.load()
    names = []
    for s in db["songs"]:
        out = listen.OUT / run.slug(s["name"])
        if (out / "info.json").exists() and (out / "notes.json").exists() and next(out.glob("*.fretboard"), None):
            names.append(s["name"])
    return names


def show(name, v):
    print(f"{v['verdict']:6} {name}")
    for f in v["fails"]:
        print(f"         {f}")
    for f in v["listen"]:
        print(f"         listen to {f}")
    for f in v.get("notes", []):
        print(f"         ok: {f}")
    if v["verdict"] == "LISTEN" and v.get("deliver"):
        print("         timing only: the worker delivers this (the sync is right; the tab just isn't the band's version)")


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
    if a[0] == "--selftest":
        names = a[1:] or [n for n in ready() if judge(load(n))["verdict"] != "FAIL"]
        if not names:
            sys.exit("no song passes yet to test the gate with")
        sys.exit(0 if selftest(names) else 1)
    names = ready() if a[0] == "--all" else a
    verdicts = {}
    for n in names:
        verdicts[n] = judge(load(n))
        show(n, verdicts[n])
    (listen.OUT.parent / "qa.json").write_text(json.dumps(verdicts, indent=1), encoding="utf-8")
    sys.exit(0 if all(v["verdict"] != "FAIL" for v in verdicts.values()) else 1)


if __name__ == "__main__":
    main()
