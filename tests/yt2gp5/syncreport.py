"""The improvement table: how much each "new data" step helps lining a song's tab up with its recording, in numbers.

    python tests/yt2gp5/syncreport.py [--no-real] [--refresh] [--md PATH] [--cache PATH] [--save LABEL] [--open]

Prints one report (and saves it as out/truthbench/report.md). It also redraws history/dashboard.html (charts of the same
data over time); `--save "label"` keeps the numbers as a snapshot in history/sync-history.json (see synchistory.py).
The report:
  - a plain summary: what improved most, what did not help, what is still weak
  1. the ladder of steps on the truth benchmark (truthbench.py): plain wavefit, +harmony, +ending, +bars, +polish,
     +ending search, +wide start. Good / ok / bad / declined of the fits, and the change from the step before.
     good = every bar within 50 ms of the true bar time, ok = within 150 ms, bad = worse, declined = the fit gave up
     (the gate would leave the file alone).
  2. each ingredient switched on or off inside one stored run (paired, the same cases)
  3. the train / validation split (even / odd song index), so overfitting shows
  4. the same by clock, by what the tab holds, and by how far off the start was
  5. the start search alone on far starts (startcal*.json)
  6. the 10 worst cases still left
  7. the real songs in out/listen: the gate's verdict (qa.judge) for the file before wavefit and for the file now
  8. every stored result, for checking

It only READS what is stored: out/truthbench/last*.json (per-fit rows), run*.log (counts of runs whose rows were
overwritten), startcal*.json, and the songs' files. Nothing is re-run, no song file or backup is written. A step with
no stored result says so instead of showing a number. A newer `truthbench.py run` (one that had the wide start search:
its rows carry a 'moved' column, and far starts) is picked up by itself and fills the +wide start line.
The real songs' verdicts take a while the first time (the gate, ~4 s a verdict), so they are kept in
out/truthbench/syncreport-cache.json (keyed by the sync points and by the gate's own files, so a change to qa.py /
syncqa.py / drumclock.py or to a song's sync judges that song again). The gate's own caches (the recording's features,
the drum stems) are only read; a song that lacks them is listed as such, never built.

Run with the yt2gp5 Python (it re-executes itself there). Only the real-songs part needs librosa; --no-real skips it.
"""
import argparse
import collections
import contextlib
import hashlib
import io
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = Path.home() / ".fretboard" / "yt2gp5-venv" / "Scripts" / "python.exe"
if __name__ == "__main__" and VENV.exists() and Path(sys.executable).resolve() != VENV.resolve():
    import subprocess
    sys.exit(subprocess.call([str(VENV), __file__, *sys.argv[1:]]))
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(_v, "2")  # light CPU

BENCH = HERE / "out" / "truthbench"
LISTEN = HERE / "out" / "listen"
CLOCKS = ("steady", "slow3", "fast3", "step", "hohey")
CONTENTS = ("full", "partial", "wrong")
STARTS = ("good", "bad", "far")
RANK = {"PASS": 0, "LISTEN": 1, "FAIL": 2}
FINAL = "+bars+harmony+ending"  # the variant that carries every step (bars + harmony + ending)


def const(path, pattern, default):
    """A number out of another file's text (so a half-edited wavefit.py can't break this report)."""
    try:
        m = re.search(pattern, Path(path).read_text(encoding="utf-8"), re.M)
        return type(default)(float(m.group(1))) if m else default
    except OSError:
        return default


GOOD_MS = const(HERE / "truthbench.py", r"^GOOD_MS, OK_MS = (\d+),", 50)
OK_MS = const(HERE / "truthbench.py", r"^GOOD_MS, OK_MS = \d+, (\d+)", 150)
START_GAIN = const(HERE / "wavefit.py", r"^START_GAIN = ([\d.]+)", 0.75)
START_MIN = const(HERE / "wavefit.py", r"^START_MIN = ([\d.]+)", 0.8)
RANGE_S = const(HERE / "wavefit.py", r"^RANGE_S = ([\d.]+)", 1.5)  # how far either side of its start line the main fit looks


# ---------- reading what is stored ----------

def cls(worst):
    return "none" if worst is None else "good" if worst <= GOOD_MS else "ok" if worst <= OK_MS else "bad"


def counts(rows):
    c = collections.Counter(cls(r["worst"]) for r in rows)
    return {"n": len(rows), "good": c["good"], "ok": c["ok"], "bad": c["bad"], "none": c["none"]}


def score(c):
    """truthbench.score: good 1, ok 0.4, declined 0.25 (the gate leaves the file alone), bad -1."""
    return (c["good"] + 0.4 * c["ok"] + 0.25 * c["none"] - c["bad"]) / max(1, c["n"])


def load_row_files():
    """Every out/truthbench/last*.json with per-fit rows. Identical copies (last.json = last-run3.json) count once."""
    files, seen = [], {}
    for p in sorted(BENCH.glob("last*.json")):
        try:
            raw = p.read_bytes()
            rows = json.loads(raw.decode("utf-8"))
        except (OSError, ValueError):
            continue
        if not (isinstance(rows, list) and rows and isinstance(rows[0], dict) and "variant" in rows[0]):
            continue
        sha = hashlib.sha1(raw).hexdigest()
        if sha in seen:
            seen[sha]["also"].append(p.name)
            continue
        f = {"name": p.name, "rows": rows, "mtime": p.stat().st_mtime, "also": []}
        seen[sha] = f
        files.append(f)
    return files


LOG_LINE = re.compile(r"^\s{2}(\S.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+[\d.]+%\s+\d+ ms\s*$")


def load_logs():
    """{log name: {variant: counts}} from run*.log (the tables truthbench.py printed). A run split by clock or content
    is added up per variant."""
    logs = {}
    for p in sorted(BENCH.glob("run*.log")):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        table_ = {}
        for line in text.splitlines():
            m = LOG_LINE.match(line)
            if not m:
                continue
            variant = m.group(1).split(" ")[0]
            n, g, o, b, z = (int(x) for x in m.groups()[1:6])
            c = table_.setdefault(variant, {"n": 0, "good": 0, "ok": 0, "bad": 0, "none": 0})
            for k, v in zip(("n", "good", "ok", "bad", "none"), (n, g, o, b, z)):
                c[k] += v
        if table_:
            logs[p.name] = table_
    return logs


def song_order():
    try:
        return json.loads((BENCH / "songs.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def wide_start_file(files):
    """The newest rows file from a run that had the wide start search (its rows carry 'moved', or hold far starts)."""
    wide = [f for f in files if any(("moved" in r) or r.get("start") == "far" for r in f["rows"][:300])]
    return max(wide, key=lambda f: f["mtime"]) if wide else None


# ---------- the ladder ----------

STEPS = [  # name, what it adds, [(source kind, file, variant)] the first one that exists is used
    ("plain wavefit", "note starts only", [("rows", "last-run2.json", "wavefit"), ("log", "run1.log", "wavefit")]),
    ("+harmony", "chords in each window's evidence", [("log", "run1.log", "+harmony")]),
    ("+ending", "a slow-down knot in the last bars", [("log", "run1.log", "+harmony+ending")]),
    ("+bars", "Beat This! bar lines as evidence", [("log", "run1.log", FINAL)]),
    ("+polish", "each tempo change tried at nearby bar lines", [("rows", "last-run2.json", FINAL), ("log", "run2.log", FINAL)]),
    ("+ending search", "the ending slow-down searched, kept only if the note starts agree more", [("rows", "last-run3.json", FINAL), ("log", "run3.log", FINAL)]),
]


def build_ladder(files, logs):
    by_name = {f["name"]: f for f in files}
    for f in files:
        for a in f["also"]:
            by_name.setdefault(a, f)
    ladder = []
    for name, adds, sources in STEPS:
        step = {"name": name, "adds": adds, "c": None, "rows": None, "src": None, "far": None, "far_rows": []}
        for kind, file, variant in sources:
            if kind == "rows" and file in by_name:
                rows = [r for r in by_name[file]["rows"] if r["variant"] == variant]
                if rows:
                    step.update(rows=rows, c=counts(rows), src=f"{file} rows")
                    break
            if kind == "log" and file in logs and variant in logs[file]:
                step.update(c=logs[file][variant], src=f"{file} counts only")
                break
        ladder.append(step)
    # +wide start: a stored full-fit run that had the start search
    wf = wide_start_file(files)
    step = {"name": "+wide start", "adds": "the start searched +-40 s (chords + bar lines), adopted when it wins by START_GAIN", "c": None, "rows": None,
            "src": None, "far": None, "far_rows": []}
    if wf:
        rows = [r for r in wf["rows"] if r["variant"] == FINAL] or [r for r in wf["rows"] if r["variant"] == wf["rows"][0]["variant"]]
        gb = [r for r in rows if r["start"] in ("good", "bad")]  # the same starts as the steps before, so the change is fair
        far = [r for r in rows if r["start"] == "far"]
        step.update(rows=gb, c=counts(gb), src=f"{wf['name']} rows", far=counts(far) if far else None, far_rows=far)
    ladder.append(step)
    return ladder


def stored(files, logs, file, variant):
    """(counts, rows or None) of one stored variant: its rows when the file has them, else the log's counts."""
    for f in files:
        if file == f["name"] or file in f["also"]:
            rows = [r for r in f["rows"] if r["variant"] == variant]
            if rows:
                return counts(rows), rows
    log = logs.get(file)
    if log and variant in log:
        return log[variant], None
    return None, None


# paired comparisons inside one stored run (the same cases, one ingredient switched on): key, label, off, on
PAIRS = [
    ("harmony_plain", "+harmony on plain wavefit (run1, before polish)", ("run1.log", "wavefit"), ("run1.log", "+harmony")),
    ("harmony_bars", "+harmony with bar lines on (run1, before polish)", ("run1.log", "+bars"), ("run1.log", "+bars+harmony")),
    ("ending_nochords", "+ending with no chords (run1, before polish)", ("run1.log", "wavefit"), ("run1.log", "+ending")),
    ("ending_polish", "+ending with chords, bars, polish (run2)", ("last-run2.json", "+bars+harmony"), ("last-run2.json", "+bars+harmony+ending")),
    ("bars_polish", "+bars with chords, ending, polish (run2)", ("last-run2.json", "+harmony+ending"), ("last-run2.json", FINAL)),
    ("bars_final", "+bars in the final stack (run3: ending search, polish, chords)", ("last-run3.json", "+harmony+ending"), ("last-run3.json", FINAL)),
    ("endsearch", "+ending search, everything else on (run2 -> run3)", ("last-run2.json", FINAL), ("last-run3.json", FINAL)),
]


def split_counts(rows, songs):
    out = {}
    for label, parity in (("train", 0), ("val", 1)):
        keep = {s for i, s in enumerate(songs) if i % 2 == parity}
        out[label] = counts([r for r in rows if r["song"] in keep])
    return out


def pair_results(files, logs, songs):
    out = []
    for key, label, a, b in PAIRS:
        ca, ra = stored(files, logs, *a)
        cb, rb = stored(files, logs, *b)
        row = {"key": key, "label": label, "ca": ca, "cb": cb, "src": a[0] if a[0] == b[0] else f"{a[0]} / {b[0]}", "tv": None}
        if ra and rb and songs:
            sa, sb = split_counts(ra, songs), split_counts(rb, songs)
            row["tv"] = {k: sb[k]["good"] - sa[k]["good"] for k in sa}
        out.append(row)
    return out


def group_counts(rows, key, order):
    got = collections.defaultdict(list)
    for r in rows:
        got[r[key]].append(r)
    return {k: counts(got[k]) for k in order if k in got}


# ---------- the start search alone (startcal) ----------

def start_search():
    """The newest startcal*.json judged with the rule as wavefit has it now: how the start line does by how far off the start was."""
    best = None
    for p in sorted(BENCH.glob("startcal*.json")):
        try:
            rows = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(rows, list) and rows and "harm" in rows[0] and (best is None or p.stat().st_mtime > best[2]):
            best = (p.name, rows, p.stat().st_mtime)
    if not best:
        return None
    name, rows, _ = best
    groups = [(f"start < {START_MIN:g} s off", lambda t: t < START_MIN), (f"start {START_MIN:g}-3 s off", lambda t: START_MIN <= t < 3), ("start > 3 s off (far)", lambda t: t >= 3)]
    out = []
    for label, sel in groups:
        g = [r for r in rows if sel(abs(r["true"]))]
        if not g:
            continue
        o = {"label": label, "n": len(g), "far": "far" in label}
        for src in ("harm", "full"):
            before, after, moved, worse = [], [], 0, 0
            for r in g:
                x = r[src]
                t = abs(r["true"])
                adopted = abs(x["shift"]) >= START_MIN and x["gain"] >= START_GAIN
                err = abs(x["err"]) if adopted else t
                moved += adopted
                worse += err > t + 0.05
                before.append(t)
                after.append(err)
            within = lambda arr, lim: sum(a < lim for a in arr)
            o[src] = {"moved": moved, "worse": worse, "before_median": sorted(before)[len(before) // 2], "after_median": sorted(after)[len(after) // 2],
                      "w150": within(after, 0.15), "w150_was": within(before, 0.15), "w300": within(after, 0.30), "w300_was": within(before, 0.30),
                      "reach": within(after, RANGE_S), "reach_was": within(before, RANGE_S)}
        out.append(o)
    return {"file": name, "groups": out, "n": len(rows)}


# ---------- the real songs ----------

def gate_signature():
    parts = []
    for f in ("qa.py", "syncqa.py", "drumclock.py"):
        try:
            st = (HERE / f).stat()
            parts.append(f"{f}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append(f"{f}:missing")
    return "|".join(parts)


def stat_sig(*paths):
    out = []
    for p in paths:
        try:
            st = Path(p).stat()
            out.append(f"{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            out.append("-")
    return ",".join(out)


def read_entry(path):
    """(sync points, tempo sections as qa.load reads them, autoSync) of a .fretboard file."""
    entry = json.loads(Path(path).read_text(encoding="utf-8"))["songs"][0]
    secs = ((entry.get("autoSync") or {}).get("beats") or {}).get("tempo_sections") or []
    return entry["syncPoints"], [p - 1 for p in secs], entry.get("autoSync") or {}


class NeedsCache(Exception):
    pass


def real_songs(refresh, cache_path):
    """The gate's verdict per song for the file before wavefit and for the file now, the way wavefit.run judges a fit:
    qa.judge(qa.load(name), points=...). Read-only: the gate's own caches are replaced by readers that never build,
    download or write anything."""
    sys.path.insert(0, str(HERE))
    import wave
    import numpy as np
    import drumclock
    import qa
    import real
    import run
    import syncqa

    def video_id(info):
        return info["url"].split("v=")[-1].split("&")[0]

    def features(out, song, info):  # qa.features' cache hit, never its rebuild (which downloads and writes into the song's folder)
        f = out / "qa_env.npz"
        wav = real.CACHE / run.slug(song["name"]) / f"recording-{video_id(info)}.wav"
        if not (f.exists() and wav.exists()):
            raise NeedsCache("the recording's features aren't cached (qa.py makes them)")
        with wave.open(str(wav)) as w:
            seconds = w.getnframes() / w.getframerate()
        d = np.load(f)
        if str(d["sha"]) == info["gp_sha"] and "rec_c" in d and abs(float(d["length"]) - seconds) < 0.2:
            return d["env"], d["tab_env"], d["rec_c"], d["tab_c"], float(d["length"])
        raise NeedsCache("the cached features are stale (qa.py would rebuild them)")

    state = {"no_drums": False}

    def strength(song, info):  # drumclock.strength's cache hit, never the download or the Demucs split
        f = real.CACHE / run.slug(song["name"]) / f"stems-{video_id(info)}" / "strength.npz"
        if not f.exists():
            state["no_drums"] = True
            raise ImportError("the drum stems aren't cached")  # qa.drums takes this as "no drum clock"
        return dict(np.load(f))

    qa.features = features
    drumclock.strength = strength

    cache, sig = {}, gate_signature()
    if not refresh and cache_path.exists():
        try:
            c = json.loads(cache_path.read_text(encoding="utf-8"))
            if c.get("gate") == sig:
                cache = c.get("results", {})
        except (OSError, ValueError):
            pass

    def verdict(s, points, sections, key):
        if key in cache:
            return cache[key]
        state["no_drums"] = False
        with contextlib.redirect_stdout(io.StringIO()):
            v = qa.judge({**s, "sections": sections}, points=points)
        first = float(syncqa.Sync.from_points([b[0] for b in s["bars"]], sorted(points))(s["bars"][0][0]))
        r = {"verdict": v["verdict"], "fails": v["fails"], "listen": v["listen"], "drift": sum(b - a + 1 for a, b in v.get("drift_bars", [])),
             "first": first, "no_drums": state["no_drums"]}
        cache[key] = r
        return r

    sha = lambda *x: hashlib.sha1(json.dumps(x).encode()).hexdigest()
    rows = []
    for d in sorted(LISTEN.glob("*_official")):
        if d.name.startswith("SYNCTEST") or not (d / "info.json").exists():
            continue
        try:
            name = json.loads((d / "info.json").read_text(encoding="utf-8"))["name"]
        except (OSError, ValueError, KeyError):
            continue
        row = {"slug": d.name, "name": name}
        rows.append(row)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                s = qa.load(name)
            out = s["out"]
            main = min(out.glob("*.fretboard"), key=lambda p: ("(" in p.stem, p.name))
            backup = main.with_name(main.name + ".before-wavefit")
            stamp = stat_sig(out / "qa_env.npz", out / "info.json", out / "notes.json")
            now_pts, now_secs, auto = read_entry(main)
            row["now"] = verdict(s, now_pts, now_secs, f"{d.name}|now|{sha(now_pts, now_secs)}|{stamp}")
            if backup.exists():
                b_pts, b_secs, _ = read_entry(backup)
                row["before"] = verdict(s, b_pts, b_secs, f"{d.name}|before|{sha(b_pts, b_secs)}|{stamp}")
                row["backup"] = True
            else:
                row["before"], row["backup"] = row["now"], False
        except SystemExit as e:
            row.pop("now", None)
            row["error"] = f"not in songs.json ({e})"
            continue
        except NeedsCache as e:
            row.pop("now", None)
            row["error"] = str(e)
            continue
        except Exception as e:  # a song whose files are incomplete
            row.pop("now", None)
            row["error"] = f"{type(e).__name__}: {e}"
            continue
        al = auto.get("aligned") or {}
        row["by"] = al.get("by") or ("fixsync (" + auto["fixed"].get("by", "?") + ")" if "fixed" in auto else "one-tempo fit (listen.py / syncqa)")
        row["note"] = al.get("note", "")
    try:
        cache_path.write_text(json.dumps({"gate": sig, "results": cache}), encoding="utf-8")
    except OSError:
        pass
    return rows


# ---------- printing ----------

def ascii_(text):
    return str(text).replace("±", "+-").replace("…", "...").encode("ascii", "replace").decode("ascii")


def table(head, rows, right=()):
    cols = list(zip(*([head] + rows)))
    w = [max(len(str(c)) for c in col) for col in cols]
    cell = lambda i, c: str(c).rjust(w[i]) if i in right else str(c).ljust(w[i])
    line = lambda r: "| " + " | ".join(cell(i, c) for i, c in enumerate(r)) + " |"
    sep = "|" + "|".join(("-" * (w[i] + 1) + ":") if i in right else ("-" * (w[i] + 2)) for i in range(len(w))) + "|"
    return "\n".join([line(head), sep] + [line(r) for r in rows])


def d(x):
    return f"{x:+d}" if x else "0"


def pct(a, n):
    return f"{100 * a / n:.0f}%" if n else "-"


def short(text, n=62):
    text = ascii_(re.sub(r"\s+", " ", text))
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0] + "..."


def first_reason(v):
    for f in v["fails"] + v["listen"]:
        return short(f)
    return ""


def kind_of(f):
    return f.split(":")[0]


def summary(ladder, split, pairs, startcal, real_rows):
    """The plain-language summary; every number comes from the tables below."""
    out = []
    have = [s for s in ladder if s["c"]]
    first, last = have[0], have[-1]
    gains, prev = [], None
    for s in have:
        if prev:
            gains.append((s, *(s["c"][k] - prev["c"][k] for k in ("good", "ok", "bad", "none")), prev))
        prev = s
    out.append(f"Overall: on the truth benchmark ({first['c']['n']} fits a step, bar times known exactly) the stack went from {first['c']['good']} good / "
               f"{first['c']['ok']} ok / {first['c']['bad']} bad / {first['c']['none']} declined ('{first['name']}') to {last['c']['good']} good / "
               f"{last['c']['ok']} ok / {last['c']['bad']} bad / {last['c']['none']} declined ('{last['name']}'): fits with every bar within {GOOD_MS:g} ms went "
               f"from {pct(first['c']['good'], first['c']['n'])} to {pct(last['c']['good'], last['c']['n'])}.")
    top = [g for g in sorted(gains, key=lambda g: -g[1])[:2] if g[1] > 0]
    if top:
        text = "Improved most: " + "; ".join(f"{g[0]['name']} (good {d(g[1])}: {g[5]['c']['good']} -> {g[0]['c']['good']}, bad {d(g[3])}"
                                             + (f", declined {d(g[4])}" if g[4] else "") + ")" for g in top) + "."
        if any(g[0]["name"] == "+harmony" and g[4] < 0 for g in gains):
            text += " Chords are what stopped the fit from giving up."
        if any(g[0]["name"] == "+polish" and g[2] < 0 for g in gains):
            text += " Polish turned near-misses (ok) into good ones."
        out.append(text)
    by_key = {p["key"]: p for p in pairs}
    little = []
    for s, dg, do, db, dn, p in gains:
        if s["name"] == "+wide start":
            continue  # it is made for far starts, and leaves the good and bad starts alone: judged on the far ones below
        if dg < 10 and db <= -10:
            line = f"{s['name']} on its own mostly moved bad fits to ok ones (good {d(dg)}, ok {d(do)}, bad {d(db)})"
            b = by_key.get("bars_final")
            if s["name"] == "+bars" and b and b["ca"] and b["cb"]:
                line += (f", but in the final stack the bar lines are worth good {d(b['cb']['good'] - b['ca']['good'])}, bad {d(b['cb']['bad'] - b['ca']['bad'])} "
                         f"({b['ca']['good']} -> {b['cb']['good']} good), so it is worth keeping")
            little.append(line)
        elif dg < 10:
            little.append(f"{s['name']} made little difference here (good {d(dg)}, bad {d(db)})")
    e = by_key.get("ending_nochords")
    if e and e["ca"] and e["cb"] and (e["ca"]["good"], e["ca"]["bad"], e["ca"]["none"]) == (e["cb"]["good"], e["cb"]["bad"], e["cb"]["none"]):
        little.append(f"the ending knot without chords changed nothing ({e['ca']['good']} / {e['ca']['ok']} / {e['ca']['bad']} / {e['ca']['none']} both ways): "
                      "without chords the fit gave up before the ending mattered")
    if little:
        out.append("Little or no help: " + "; ".join(little) + ".")
    # what is not measured end to end
    missing = [s["name"] for s in ladder if not s["c"]]
    rowless = [s["name"] for s in ladder if s["c"] and not s["rows"]]
    wide = ladder[-1]
    if not wide["c"]:
        line = "+wide start has no stored full-fit run"
        far = next((g for g in (startcal or {}).get("groups", []) if g["far"]), None)
        if far:
            h = far["harm"]
            line += (f"; the start search alone moved {h['moved']} of {far['n']} far starts (6-24 s off), put {h['w300']} within 0.3 s and {h['reach']} within the main fit's "
                     f"+-{RANGE_S:g} s reach, and made {sum(g['harm']['worse'] for g in startcal['groups'])} of {startcal['n']} starts worse")
        out.append("Not measured end to end: " + line + ".")
    elif wide.get("far"):
        f = wide["far"]
        out.append(f"Wide start: far starts end to end {f['good']} good / {f['ok']} ok / {f['bad']} bad / {f['none']} declined of {f['n']}; the good and bad starts went "
                   f"{wide['c']['good']} / {wide['c']['ok']} / {wide['c']['bad']} of {wide['c']['n']}.")
    if rowless:
        out.append("Counts only (the rows were overwritten, so no train/val or breakdown): " + ", ".join(rowless) + ".")
    # still weak
    wk = []
    lastrows = last["rows"] or []
    if lastrows:
        gb = [r for r in lastrows if r["start"] in ("good", "bad")]
        overall = sum(cls(r["worst"]) != "good" for r in gb) / max(1, len(gb))
        c_clock = group_counts(gb, "clock", CLOCKS)
        worst_clock = max(c_clock, key=lambda k: (c_clock[k]["n"] - c_clock[k]["good"]) / c_clock[k]["n"])
        wc = c_clock[worst_clock]
        if (wc["n"] - wc["good"]) / wc["n"] >= 1.4 * overall:
            wk.append(f"the '{worst_clock}' clock: {wc['n'] - wc['good']} of {wc['n']} not good ({wc['ok']} ok, {wc['bad'] + wc['none']} bad), against {100 * overall:.0f}% overall")
        bads = [r for r in gb if cls(r["worst"]) in ("bad", "none")]
        if bads:
            bc = collections.Counter(r["clock"] for r in bads).most_common(1)[0]
            bt = collections.Counter(r["content"] for r in bads).most_common(1)[0]
            wk.append(f"{len(bads)} bad fits left, most with the '{bc[0]}' clock ({bc[1]}) and the '{bt[0]}' tab ({bt[1]})")
            sg = collections.Counter(r["song"] for r in bads).most_common(1)[0]
            cont = sorted({r["content"] for r in bads if r["song"] == sg[0]})
            wk.append(f"they cluster in song {sg[0]} ({sg[1]} of {len(bads)}, {'/'.join(cont)} tab)")
    tv = split.get(last["name"])
    if tv:
        gt, gv = tv["train"], tv["val"]
        gap = 100 * (gv["good"] / max(1, gv["n"]) - gt["good"] / max(1, gt["n"]))
        wk.append(f"train/val at '{last['name']}': good {pct(gt['good'], gt['n'])} train vs {pct(gv['good'], gv['n'])} val ({gap:+.0f} points)"
                  + (", so no sign of overfitting" if abs(gap) < 5 else ", a gap worth a look"))
    if not wide["c"]:
        wk.append("far starts (6-24 s off) have no end-to-end result stored")
    if wk:
        out.append("Still weak on the benchmark: " + "; ".join(wk) + ".")
    judged = [r for r in (real_rows or []) if "now" in r]
    if judged:
        nowc = collections.Counter(r["now"]["verdict"] for r in judged)
        bc = collections.Counter(r["before"]["verdict"] for r in judged)
        backed = [r for r in judged if r["backup"]]
        better = [r for r in backed if RANK[r["now"]["verdict"]] < RANK[r["before"]["verdict"]]]
        worse = [r for r in backed if RANK[r["now"]["verdict"]] > RANK[r["before"]["verdict"]]]
        fewer = [r for r in backed if r["now"]["verdict"] == r["before"]["verdict"] and r["now"]["drift"] < r["before"]["drift"]]
        nm = lambda r: r["name"].replace(" (official)", "").split(" - ", 1)[-1]
        out.append(f"Real songs ({len(judged)}): {bc['PASS']} PASS / {bc['LISTEN']} LISTEN / {bc['FAIL']} FAIL before wavefit, {nowc['PASS']} / {nowc['LISTEN']} / {nowc['FAIL']} now. "
                   f"Wavefit wrote a new sync for {len(backed)} songs: {len(better)} got a better verdict ("
                   + ", ".join(f"{nm(r)} {r['before']['verdict']} -> {r['now']['verdict']}" + (" via the aligner by hand" if r["by"] == "aligner" else "") for r in better) + ")"
                   + (f", {len(worse)} got worse" if worse else ", none got worse")
                   + (", " + ", ".join(f"{nm(r)} stayed {r['now']['verdict']} with {r['before']['drift']} -> {r['now']['drift']} drift bars" for r in fewer) if fewer else "")
                   + f". The other {len(judged) - len(backed)} have no wavefit backup (wavefit wrote nothing for them), so the new data changed none of them.")
        fails = [r for r in judged if r["now"]["verdict"] == "FAIL"]
        if fails:
            mism = [r for r in fails if any(kind_of(f) == "match" for f in r["now"]["fails"])]
            rest = collections.Counter(kind_of(next(f for f in r["now"]["fails"] if kind_of(f) != "match")) for r in fails if r not in mism and any(kind_of(f) != "match" for f in r["now"]["fails"]))
            out.append(f"Still weak on real songs: {len(mism)} of the {len(fails)} FAILs say the tab is not the recording (a 'match' fail), which no alignment can fix; "
                       f"the other {len(fails) - len(mism)} fail on " + (", ".join(f"{k} ({v})" for k, v in rest.most_common()) or "other checks") + ".")
    return [ascii_(x) for x in out]


LAST = {}  # what the last build_report computed, for the snapshot and the dashboard


def build_report(refresh, no_real, cache_path):
    t0 = time.time()
    files, logs, songs = load_row_files(), load_logs(), song_order()
    ladder = build_ladder(files, logs)
    pairs = pair_results(files, logs, songs)
    startcal = start_search()
    real_rows = None if no_real else real_songs(refresh, cache_path)
    split = {s["name"]: split_counts(s["rows"], songs) for s in ladder if s["rows"] and songs}
    LAST.update(ladder=ladder, split=split, real=real_rows, songs=songs)
    L = ["# Sync improvement report", "",
         f"Made {time.strftime('%Y-%m-%d %H:%M')} by `python tests/yt2gp5/syncreport.py` from stored results only (nothing re-run). "
         f"good = every bar within {GOOD_MS:g} ms of the true bar time, ok = within {OK_MS:g} ms, bad = worse, declined = the fit gave up (the gate leaves the file alone).",
         "", "## Summary", ""]
    for line in summary(ladder, split, pairs, startcal, real_rows):
        L.append(f"- {line}")
    L.append("")

    # 1. the ladder
    L += ["## 1. The ladder: each step on the truth benchmark", ""]
    head = ["step", "good", "ok", "bad", "declined", "score", "d good", "d ok", "d bad", "d declined", "source"]
    rows, prev = [], None
    for s in ladder:
        c = s["c"]
        if not c:
            rows.append([s["name"], "-", "-", "-", "-", "-", "-", "-", "-", "-", "no stored result"])
            continue
        delta = ["-"] * 4 if not prev else [d(c[k] - prev[k]) for k in ("good", "ok", "bad", "none")]
        rows.append([s["name"], f"{c['good']} ({pct(c['good'], c['n'])})", c["ok"], c["bad"], c["none"], f"{score(c):+.3f}", *delta, s["src"]])
        prev = c
    L.append(table(head, rows, right=set(range(1, 10))))
    L.append("")
    ns = sorted({s["c"]["n"] for s in ladder if s["c"]})
    L.append(f"Every step is the line before plus what the step adds, over {', '.join(str(n) for n in ns)} fits: 16 AAM songs x 9 cases (clock steady / slow3 / fast3 / step / hohey "
             "x tab content full / partial / wrong) x the stored starts (good = 0.15 s off, bad = 0.9 s off). 'score' = good 1, ok 0.4, declined 0.25, bad -1, per fit.")
    L.append("")
    for s in ladder:
        L.append(f"- {s['name']}: {s['adds']}.")
    if any(s["c"] and not s["rows"] for s in ladder):
        L.append("- 'counts only' = from run1.log: the per-fit rows of that run were overwritten when later runs saved last.json, so there is no train/val split or breakdown "
                 "for it. It ran on wavefit before `polish` existed.")
    plain_log = logs.get("run1.log", {}).get("wavefit")
    if plain_log and ladder[0]["src"] and "rows" in ladder[0]["src"]:
        L.append(f"- Plain wavefit counted {plain_log['good']} / {plain_log['ok']} / {plain_log['bad']} / {plain_log['none']} in run1.log (before polish) and counts as shown here in the stored rows (run2).")
    if not ladder[-1]["c"]:
        L.append("- +wide start: no full-fit run with the start search is stored (the benchmark now has far starts too, and a `truthbench.py run` that has them saves last.json with a 'moved' column; "
                 "this report picks that up by itself). Section 5 has the start search alone.")
    elif ladder[-1].get("far"):
        f = ladder[-1]["far"]
        L.append(f"- +wide start, far starts (6-24 s off, not part of the earlier steps): {f['good']} good / {f['ok']} ok / {f['bad']} bad / {f['none']} declined of {f['n']}.")
    L.append("")

    # 2. ingredient on / off
    L += ["## 2. One ingredient on or off, same cases (paired)", ""]
    head = ["ingredient (and what else is on)", "good off -> on", "ok", "bad", "declined", "d good", "d bad", "d good train / val", "source"]
    rows = []
    for p in pairs:
        a, b = p["ca"], p["cb"]
        if not (a and b):
            rows.append([p["label"], "no stored result", "", "", "", "", "", "", ""])
            continue
        tv = f"{p['tv']['train']:+d} / {p['tv']['val']:+d}" if p["tv"] else "counts only"
        rows.append([p["label"], f"{a['good']} -> {b['good']}", f"{a['ok']} -> {b['ok']}", f"{a['bad']} -> {b['bad']}", f"{a['none']} -> {b['none']}",
                     d(b["good"] - a["good"]), d(b["bad"] - a["bad"]), tv, p["src"]])
    L.append(table(head, rows, right={1, 2, 3, 4, 5, 6, 7}))
    L.append("")
    L.append("The ladder adds steps in the order they were built; this table is the other view: the same run, one ingredient switched on, so it shows what each is worth where it ended up. "
             "Only the pairs a stored run contains can be shown (the benchmark was not re-run).")
    L.append("")

    # 3. train/val
    L += ["## 3. Train / validation split (even / odd song index)", ""]
    if split:
        head = ["step", "train good", "val good", "gap (val - train)", "train bad+declined", "val bad+declined"]
        rows = []
        for s in ladder:
            tv = split.get(s["name"])
            if not tv:
                rows.append([s["name"], "no per-fit rows", "", "", "", ""])
                continue
            t, v = tv["train"], tv["val"]
            gap = 100 * (v["good"] / max(1, v["n"]) - t["good"] / max(1, t["n"]))
            rows.append([s["name"], f"{t['good']}/{t['n']} ({pct(t['good'], t['n'])})", f"{v['good']}/{v['n']} ({pct(v['good'], v['n'])})", f"{gap:+.0f} points",
                         f"{t['bad'] + t['none']}/{t['n']}", f"{v['bad'] + v['none']}/{v['n']}"])
        L.append(table(head, rows, right={1, 2, 3, 4, 5}))
        L.append("")
        L.append("The constants (LAMBDA, KNOT_*, HARM, BEAT_*, POLISH_*, START_*) were tuned on the train songs (even index, 8 of 16); the val songs (odd index, 8) are the check. "
                 "A val result close to the train one means the gain is not tuned to those 8 songs. With 8 songs a side, a gap of a few points is noise.")
    else:
        L.append("No per-fit rows or no songs.json stored: no split.")
    L.append("")

    # 4. breakdowns
    L += ["## 4. By clock, by what the tab holds, and by start", ""]
    with_rows = [s for s in ladder if s["rows"]]
    if with_rows:
        cell = lambda c: f"{c['good']}/{c['ok']}/{c['bad']}/{c['none']}" if c else "-"
        for label, key, order in (("clock (how the tab's tempo differs from the recording)", "clock", CLOCKS), ("tab content", "content", CONTENTS),
                                  ("start (how far off the starting line was)", "start", STARTS)):
            L += [f"By {label}, as good/ok/bad/declined:", ""]
            per = []
            for s in with_rows:
                rws = (s["rows"] + s["far_rows"]) if key == "start" else s["rows"]
                per.append(group_counts(rws, key, order))
            keys = [k for k in order if any(k in p for p in per)]
            rows = [[k, next(p[k]["n"] for p in per if k in p), *[cell(p.get(k)) for p in per]] for k in keys]
            L.append(table(["group", "n"] + [s["name"] for s in with_rows], rows, right=set(range(1, 2 + len(with_rows)))))
            L.append("")
        skipped = [s["name"] for s in ladder if s["c"] and not s["rows"]]
        if skipped:
            L += [f"Not shown (counts only, no rows): {', '.join(skipped)}.", ""]
    else:
        L += ["No per-fit rows are stored.", ""]

    # 5. start search alone
    L += ["## 5. The start search alone (wide start, +-40 s)", ""]
    if startcal:
        L.append(f"From {startcal['file']} ({startcal['n']} start lines: 16 songs x 4 cases x good / bad / far starts), judged with the rule as wavefit.py has it now: "
                 f"adopted when the best line wins by START_GAIN {START_GAIN:g} and is off by at least START_MIN {START_MIN:g} s. 'Error' is the median distance of the start line from the truth.")
        L.append("")
        head = ["start was", "n", "evidence", "adopted", "median error", "within 0.15 s", "within 0.3 s", f"within {RANGE_S:g} s (main fit's reach)", "made worse"]
        rows = []
        for g in startcal["groups"]:
            for src, name in (("harm", "chords"), ("full", "chords + bars")):
                x = g[src]
                rows.append([g["label"], g["n"], name, f"{x['moved']}/{g['n']}", f"{1000 * x['before_median']:.0f} -> {1000 * x['after_median']:.0f} ms",
                             f"{x['w150']} (was {x['w150_was']})", f"{x['w300']} (was {x['w300_was']})", f"{x['reach']} (was {x['reach_was']})", x["worse"]])
        L.append(table(head, rows, right={1, 3, 4, 5, 6, 7, 8}))
        L.append("")
        L.append(f"The main fit looks +-{RANGE_S:g} s around the start line it is given, so a start line within {RANGE_S:g} s is enough for it to finish the job. "
                 "'within 0.15 s' counts the start line alone, one straight line with no tempo change, so hohey and step clocks sit a little off the truth there. "
                 "A start less than START_MIN off is left to the main fit on purpose.")
    else:
        L.append("No startcal*.json is stored.")
    L.append("")

    # 6. worst
    L += ["## 6. The 10 worst cases still left", ""]
    final = next((s for s in reversed(ladder) if s["rows"]), None)
    if final:
        pool = final["rows"] + final["far_rows"]
        order = sorted(pool, key=lambda r: (r["worst"] is not None, -(r["worst"] or 0)))[:10]
        rows = [[r["song"], r["clock"], r["content"], r["start"], "declined" if r["worst"] is None else f"{r['worst']:.0f}", "-" if r["worst"] is None else f"{r['median']:+.0f}",
                 f"{r['start_worst']:.0f}", r.get("knots", "-")] for r in order]
        L += [f"Step '{final['name']}' ({final['src']}), worst bar error over the whole song, worst first:", "",
              table(["song (AAM)", "clock", "content", "start", "worst bar (ms)", "median (ms)", "start line off (ms)", "tempo knots"], rows, right={4, 5, 6, 7}), ""]
        bad = [r for r in pool if cls(r["worst"]) in ("bad", "none")]
        per_song = collections.Counter(r["song"] for r in bad)
        if per_song:
            L += ["Bad or declined fits per song: " + ", ".join(f"{k}: {v}" for k, v in per_song.most_common()) + f" (of {len(bad)}).", ""]
    else:
        L += ["No per-fit rows are stored.", ""]

    # 7. real songs
    L += ["## 7. Real songs in out/listen (the gate's verdict)", ""]
    if real_rows is None:
        L.append("Skipped (--no-real).")
    else:
        L.append("`qa.judge` on the file before wavefit (the `.fretboard.before-wavefit` backup) and on the file now. A song with no backup has the same file before and now: "
                 "wavefit wrote nothing for it (it was not better, or wavefit was never run), so 'before' and 'now' agree. 'drift' = bars the gate sees drifting off the tempo. "
                 "'first bar' = the video time the first bar starts at. Read-only: no song file or backup was written.")
        L.append("")
        head = ["song", "backup", "before", "now", "drift bars", "first bar (s)", "now written by", "what is left (now)"]
        rows = []
        for r in real_rows:
            nm = ascii_(r["name"].replace(" (official)", ""))
            if "now" not in r:
                rows.append([nm, "-", "-", "-", "-", "-", "-", short(f"not judged: {r.get('error', '?')}", 70)])
                continue
            b, n = r["before"], r["now"]
            left = first_reason(n) + (" [no drum clock: stems not cached]" if n.get("no_drums") else "")
            by = r["by"] + (f" ({short(r['note'], 40)})" if r["note"] else "")
            rows.append([nm, "yes" if r["backup"] else "none", b["verdict"], n["verdict"], f"{b['drift']} -> {n['drift']}" if r["backup"] else str(n["drift"]),
                         f"{b['first']:.3f} -> {n['first']:.3f}" if r["backup"] else f"{n['first']:.3f}", ascii_(by), left])
        L.append(table(head, rows, right={4, 5}))
        judged = [r for r in real_rows if "now" in r]
        if judged:
            c0 = collections.Counter(r["before"]["verdict"] for r in judged)
            c1 = collections.Counter(r["now"]["verdict"] for r in judged)
            L += ["", f"Totals over {len(judged)} songs: before {c0['PASS']} PASS / {c0['LISTEN']} LISTEN / {c0['FAIL']} FAIL; now {c1['PASS']} PASS / {c1['LISTEN']} LISTEN / {c1['FAIL']} FAIL. "
                  f"{sum(1 for r in judged if r['backup'])} songs have a before-wavefit backup (wavefit wrote a new sync for them)."]
    L.append("")

    # 8. everything stored
    L += ["## 8. Every stored result (to check the tables above)", ""]
    head = ["file", "variant", "n", "good", "ok", "bad", "declined", "kind"]
    rows = []
    for f in files:
        by_v = collections.defaultdict(list)
        for r in f["rows"]:
            by_v[r["variant"]].append(r)
        tags = " = ".join([f["name"]] + f["also"])
        for v in sorted(by_v):
            c = counts(by_v[v])
            starts = "/".join(sorted({r["start"] for r in by_v[v]}))
            rows.append([tags, v, c["n"], c["good"], c["ok"], c["bad"], c["none"], f"rows; starts {starts}" + (", with wide start" if any("moved" in r for r in by_v[v][:50]) else "")])
    for name, tbl in logs.items():
        for v in sorted(tbl):
            c = tbl[v]
            rows.append([name, v, c["n"], c["good"], c["ok"], c["bad"], c["none"], "log counts"])
    L.append(table(head, rows, right={2, 3, 4, 5, 6}))
    L += ["", f"(report took {time.time() - t0:.0f} s)"]
    return ascii_("\n".join(L)) + "\n"


def main():
    global BENCH
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-real", action="store_true", help="skip the real songs (no gate, no librosa)")
    ap.add_argument("--refresh", action="store_true", help="judge the real songs again instead of using the saved verdicts")
    ap.add_argument("--dir", default=str(BENCH), help="the folder with the benchmark's stored results (default out/truthbench)")
    ap.add_argument("--md", help="where to save the report (default report.md in that folder)")
    ap.add_argument("--cache", help="where the real songs' verdicts are kept (default syncreport-cache.json in that folder)")
    ap.add_argument("--save", metavar="LABEL", help="keep this moment in the history (history/sync-history.json) and redraw the dashboard")
    ap.add_argument("--open", action="store_true", help="open history/dashboard.html in the browser")
    a = ap.parse_args()
    BENCH = Path(a.dir)
    if a.save is not None and a.no_real:
        sys.exit("--save keeps the real songs too: run it without --no-real.")
    if not BENCH.exists():
        sys.exit(f"No {BENCH}: run truthbench.py build and run first.")
    text = build_report(a.refresh, a.no_real, Path(a.cache) if a.cache else BENCH / "syncreport-cache.json")
    a.md = a.md or str(BENCH / "report.md")
    print(text)
    Path(a.md).write_text(text, encoding="utf-8", newline="\n")
    import synchistory
    snap = synchistory.snapshot(LAST, a.save, group_counts, cls, counts)
    if a.save is not None:
        added, why = synchistory.save(snap)
        print(f"History: {why}")
        snaps, unsaved = synchistory.load(), False
    else:
        snaps = synchistory.load()
        unsaved = not snaps or synchistory.fingerprint(snaps[-1]) != synchistory.fingerprint(snap)
        if unsaved:
            snaps = snaps + [snap]
    page = synchistory.write_dashboard(snaps, unsaved)
    print(f"Dashboard: {page}" + (" (includes numbers not saved yet: run with --save \"label\" to keep them)" if unsaved else ""))
    if a.open:
        os.startfile(str(page))


if __name__ == "__main__":
    main()
