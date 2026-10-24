"""Quality test of the YouTube → GP5 notebook (tools/colab/youtube_to_gp5.ipynb), on this PC's GPU.

For each Guitar Pro song in config.json (a song whose notes are known):
  1. alphaTab plays every track solo with Fretboard's soundfont (render.html), for the song's busiest
     stretch. Their sum is the mix; the tracks summed per instrument are the true stems.
  2. the notebook's own code (read from the .ipynb, so this tests exactly what Colab runs) separates the
     mix with each Demucs model in config.json, transcribes bass and guitar, and writes the .gp5
  3. everything is scored against the truth: stems (SDR), notes (F1), tempo, bar lines, key, notes that
     came from the wrong instrument, notes dropped as unplayable, and whether Fretboard loads the .gp5
  4. scorecard.md and results.json are written in out/, one line per run is added to history.jsonl, and
     a score that fell since the last run is flagged

Run (from the project folder, with the test Python from README.md):
    python tests/yt2gp5/run.py
  -k NAME            only songs whose file name contains NAME
  --models A,B       Demucs models (default: config.json)
  --seconds N        length of the stretch tested per song
  --max-minutes N    don't start another song after N minutes
  --rerender         make the test audio again (it is cached in cache/)
Exits 1 when a check fails its pass mark (config.json), 2 when nothing could run.
"""
import argparse
import base64
import datetime
import functools
import gc
import hashlib
import http.server
import json
import re
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
NOTEBOOK = ROOT / "tools" / "colab" / "youtube_to_gp5.ipynb"
CACHE, OUT = HERE / "cache", HERE / "out"


# ---------------------------------------------------------------- the notebook's code
class StepError(RuntimeError):
    pass


def fail(step, what, detail=None):
    raise StepError(f"[{step}] {what}" + (f"\n    Details: {str(detail).strip()[:600]}" if detail else ""))


def load_notebook():
    """The library part of notebook cells 4, 5 and 6a (above each '# --- run ---' line)."""
    import torch
    ns = {"np": np, "Path": Path, "fail": fail, "StepError": StepError, "gc": gc, "json": json, "re": re,
          "shutil": shutil, "subprocess": subprocess, "zipfile": zipfile, "torch": torch, "__name__": "notebook"}
    cells = {}
    for c in json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]:
        src = "".join(c["source"])
        m = re.match(r"# @title (\w+)\.", src)
        if m:
            cells[m.group(1)] = src
    for name in ("4", "5", "6a"):
        lib = cells[name].split("# --- run ---")[0]
        lib = "\n".join(l for l in lib.splitlines() if not l.lstrip().startswith("!"))
        exec(compile(lib, f"notebook cell {name}", "exec"), ns)
    return ns


# ---------------------------------------------------------------- the page that makes test audio
class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".woff2": "font/woff2", ".wasm": "application/wasm"}

    def log_message(self, *a):
        pass

    def do_POST(self):  # render.js saves each track's audio here; only inside cache/
        rel = self.path.split("?")[0]
        dest = (CACHE / rel[len("/__save/"):]).resolve() if rel.startswith("/__save/") else None
        if dest is None or CACHE.resolve() not in dest.parents:
            self.send_error(403)
            return
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("ab" if self.path.endswith("?append") else "wb") as f:
            f.write(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(204)
        self.end_headers()


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def slug(text):
    return re.sub(r"[^\w\-]+", "_", text).strip("_")[:60]


def render_song(page, song_path, seconds, start, rerender):
    """Test audio for one song (cached): {meta, mix path, true stems {category: array}}."""
    import soundfile as sf
    data = song_path.read_bytes()
    key = hashlib.sha1(data + f"{seconds}|{start}".encode()).hexdigest()[:12]
    folder = CACHE / f"{slug(song_path.stem)}-{key}"
    meta_file = folder / "meta.json"
    if rerender or not meta_file.exists():
        shutil.rmtree(folder, ignore_errors=True)
        meta = page.evaluate("([b, o]) => renderSong(b, o)",
                             [base64.b64encode(data).decode(), {"seconds": seconds, "start": start, "saveTo": folder.name}])
        tracks = {t["index"]: np.fromfile(folder / f"track{t['index']}.f32", dtype=np.float32).reshape(-1, 2)
                  for t in meta["tracks"]}
        mix = sum(tracks.values())
        peak = float(np.abs(mix).max()) or 1.0
        scale = 0.9 / peak if peak > 0.9 else 1.0  # same scale for mix and stems, so they still add up
        stems = {}
        for t in meta["tracks"]:
            stems.setdefault(t["category"], np.zeros_like(mix))
            stems[t["category"]] += tracks[t["index"]] * scale
        for cat, a in stems.items():
            sf.write(str(folder / f"true_{cat}.wav"), a, meta["rate"], subtype="FLOAT")
        sf.write(str(folder / "mix.wav"), mix * scale, meta["rate"], subtype="FLOAT")
        for p in folder.glob("track*.f32"):
            p.unlink()
        meta_file.write_text(json.dumps(meta), encoding="utf-8")
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    stems = {p.stem[5:]: sf.read(str(p), dtype="float32")[0] for p in folder.glob("true_*.wav")}
    return meta, folder / "mix.wav", stems


# ---------------------------------------------------------------- scoring
def sdr(ref, est):
    n = min(len(ref), len(est))
    ref, est = ref[:n].astype(np.float64), est[:n].astype(np.float64)
    noise = np.sum((ref - est) ** 2)
    return float(10 * np.log10(np.sum(ref ** 2) / max(noise, 1e-12)))


def stem_scores(ref, est, rate=44100):
    """Like the music-separation benchmarks (BSS Eval): the median SDR of the 1-second windows where the
    instrument plays, plus bleed = the share of the stem's sound that falls where the instrument is silent."""
    n = min(len(ref), len(est))
    ref, est = ref[:n].astype(np.float64), est[:n].astype(np.float64)
    loud = float(np.max([np.mean(ref[i:i + rate] ** 2) for i in range(0, n - rate + 1, rate)] or [0]))
    good, quiet_est, all_est = [], 0.0, float(np.sum(est ** 2)) or 1e-12
    for i in range(0, n - rate + 1, rate):
        r, e = ref[i:i + rate], est[i:i + rate]
        if np.mean(r ** 2) > loud * 1e-3:  # within 30 dB of the loudest second: the instrument plays
            good.append(sdr(r, e))
        else:
            quiet_est += float(np.sum(e ** 2))
    return (round(float(np.median(good)), 2) if good else None), round(quiet_est / all_est, 3)


def note_f1(ref, est, tol):
    """F1 of note starts with the right pitch within tol seconds. ref/est: [(start, pitch)].
    None when there is nothing to find."""
    import mir_eval
    if not ref:
        return None
    if not est:
        return 0.0
    hz = lambda ps: 440.0 * 2 ** ((np.asarray(ps, dtype=float) - 69) / 12)
    # mir_eval refuses times below 0 (a placed note can land just before the window), so all times move by 100 s
    iv = lambda ss: np.stack([np.asarray(ss, dtype=float) + 100, np.asarray(ss, dtype=float) + 100.1], 1)
    r = sorted(ref)
    e = sorted(est)
    _, _, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        iv([x[0] for x in r]), hz([x[1] for x in r]), iv([x[0] for x in e]), hz([x[1] for x in e]),
        onset_tolerance=tol, offset_ratio=None)
    return float(f)


def merge_unisons(notes, tol=0.05):
    """Same pitch starting within tol of each other is one note: two guitars doubling a part sound as one,
    and no transcriber can split them."""
    out = []
    for s, p in sorted(notes):
        if not any(q == p and s - t <= tol for t, q in out[-12:]):
            out.append((s, p))
    return out


def lag(ref, est, most=0.12):
    """The steady delay of the detected notes (sound attack + basic-pitch), from same-pitch neighbours.
    It moves the whole song equally, so it is taken out before scoring and reported instead."""
    by = {}
    for s, p in ref:
        by.setdefault(p, []).append(s)
    d = []
    for s, p in est:
        near = [s - t for t in by.get(p, ()) if abs(s - t) <= 0.25]
        if near:
            d.append(min(near, key=abs))
    if len(d) < 5:
        return 0.0
    return float(np.clip(np.median(d), -most, most))


def matches(note, others, tol):
    return any(p == note[1] and abs(s - note[0]) <= tol for s, p in others)


def score_run(meta, true_stems, stems, ns, guitar_mid, bass_mid, summary, detail, loaded, tol=0.05):
    """All checks for one song and model. Values are None where a check doesn't apply.
    tol: how far a note may start from the true one (real recordings, aligned by DTW, need more)."""
    import soundfile as sf
    cats = {t["index"]: t["category"] for t in meta["tracks"]}
    notes = [n for n in meta["notes"] if cats[n["track"]] != "drums"]
    truth = {c: merge_unisons([(n["start"], n["pitch"]) for n in notes if cats[n["track"]] == c]) for c in ("guitar", "bass")}
    others = merge_unisons([(n["start"], n["pitch"]) for n in notes if cats[n["track"]] != "guitar"])
    r = {}

    # stems: each model stem against the true stem; "other" holds what the model has no stem for
    have = set(stems)
    want = {}
    for cat, a in true_stems.items():
        dest = cat if cat in have else "other"
        want[dest] = want.get(dest, 0) + a
    r["stems"], r["bleed"] = {}, {}
    for name, path in stems.items():
        ref = want.get(name)
        if ref is None or np.sqrt(np.mean(ref ** 2)) < 1e-4:
            continue  # this instrument isn't in the song
        r["stems"][name], r["bleed"][name] = stem_scores(ref, sf.read(str(path), dtype="float32")[0], meta["rate"])
    gstem = "guitar" if "guitar" in stems else "other"
    r["guitar_stem"] = gstem
    r["stem_sdr_db"] = min([r["stems"][s] for s in ("bass", gstem) if s in r["stems"]], default=None)

    # notes straight from basic-pitch
    est = {k: [(n[0], n[2]) for n in ns["read_midi_notes"](p)] for k, p in (("guitar", guitar_mid), ("bass", bass_mid))}
    lags = {k: lag(truth[k], est[k], most=max(0.12, 2 * tol)) for k in est}
    r["lag_ms"] = {k: round(v * 1000) for k, v in lags.items()}
    est = {k: [(s - lags[k], p) for s, p in v] for k, v in est.items()}
    placed = {k: [(s - lags[k], p) for s, p in detail[k]] for k in est}
    r["guitar_f1"] = note_f1(truth["guitar"], est["guitar"], tol)
    r["bass_f1"] = note_f1(truth["bass"], est["bass"], tol)
    # wrong instrument: guitar notes that match another instrument's note and no guitar note
    wrong = [n for n in est["guitar"] if not matches(n, truth["guitar"], tol) and matches(n, others, tol)]
    r["guitar_leak"] = round(len(wrong) / len(est["guitar"]), 3) if est["guitar"] else None

    # notes as written in the .gp5 (after the 16th grid and the fingering)
    r["tab_guitar_f1"] = note_f1(truth["guitar"], placed["guitar"], 2 * tol)
    r["tab_bass_f1"] = note_f1(truth["bass"], placed["bass"], 2 * tol)
    n_in = sum(detail["notes_in"].values())
    r["dropped_pct"] = round(100 * sum(summary["dropped_notes"].values()) / n_in, 1) if n_in else None

    # tempo: half or double tempo is a common beat-tracker slip, so it is named
    ratio = summary["bpm"] / meta["bpm"]
    r["tempo_pct"] = round(abs(ratio - 1) * 100, 1)
    r["tempo_note"] = "half" if abs(ratio - 0.5) < 0.03 else "double" if abs(ratio - 2) < 0.06 else ""

    # bar lines: true bar lines with a .gp5 bar line within 80 ms; and which downbeat setting would fit best
    beats = np.asarray(detail["beat_lines"])
    bar_tol = 0.08 * tol / 0.05
    true_bars = [b["time"] for b in meta["barLines"] if beats[0] - bar_tol <= b["time"] <= beats[-1] + bar_tol]
    def hit(lines):
        if not true_bars or not len(lines):
            return None
        return round(float(np.mean([np.min(np.abs(lines - t)) <= bar_tol for t in true_bars])), 3)
    r["bar_lines"] = hit(beats[::4])
    shifts = {k: hit(beats[k::4]) or 0 for k in range(4)}
    r["best_downbeat_setting"] = max(shifts, key=shifts.get)
    r["time_sig"] = "/".join(map(str, meta["timeSig"]))

    # key: from the transcribed notes vs from the true notes (and the file's own key signature)
    est_key = ns["estimate_key"]([(s, s + 0.25, p) for s, p in est["guitar"] + est["bass"]])
    true_key = ns["estimate_key"]([(n["start"], n["end"], n["pitch"]) for n in notes])
    r["key"], r["true_key"], r["file_fifths"] = est_key[0], true_key[0], meta["fifths"]
    r["key_ok"] = est_key[1] == true_key[1]

    # Fretboard (alphaTab) loads it: two tracks, the right tunings, every bar full
    t = loaded["tracks"]
    r["loads_ok"] = (len(t) == 2 and t[0]["tuning"] == [64, 59, 55, 50, 45, 40] and t[1]["tuning"] == [43, 38, 33, 28]
                     and all(x["badBars"] == 0 for x in t))
    return r


def failures(r, marks):
    """Checks below their pass mark, as short words."""
    out = []
    lo = lambda k: r.get(k) is not None and r[k] < marks[k]
    hi = lambda k: r.get(k) is not None and r[k] > marks[k]
    for k in ("stem_sdr_db", "guitar_f1", "bass_f1", "tab_guitar_f1", "tab_bass_f1", "bar_lines"):
        if lo(k):
            out.append(k)
    for k in ("tempo_pct", "guitar_leak", "dropped_pct"):
        if hi(k):
            out.append(k)
    if not r["key_ok"]:
        out.append("key")
    if not r["loads_ok"]:
        out.append("loads")
    return out


def drops(r, prev, limits):
    """Scores that fell since the last run of this song and model."""
    if not prev:
        return []
    out = []
    for k in ("guitar_f1", "bass_f1", "tab_guitar_f1", "tab_bass_f1", "bar_lines"):
        if r.get(k) is not None and prev.get(k) is not None and r[k] < prev[k] - limits["f1"]:
            out.append(f"{k} {prev[k]:.2f}→{r[k]:.2f}")
    for s, v in r["stems"].items():
        pv = prev.get("stems", {}).get(s)
        if pv is not None and v < pv - limits["sdr_db"]:
            out.append(f"{s} SDR {pv:.1f}→{v:.1f}")
    return out


def fmt(v, pct=False):
    if v is None:
        return "–"
    if isinstance(v, bool):
        return "yes" if v else "**no**"
    return f"{v:.0%}" if pct else f"{v:g}"


def write_scorecard(rows, errors, gpu, total_s, path):
    lines = [f"# YouTube → GP5 scorecard", "",
             f"{datetime.datetime.now():%Y-%m-%d %H:%M} · {gpu} · {total_s / 60:.1f} min · "
             f"{sum(not r['fails'] for r in rows)} of {len(rows)} runs pass", "",
             "| Song | Model | Stems SDR dB | Guitar F1 | Bass F1 | Tab guitar | Tab bass | Tempo off | Bar lines | Key | Wrong-instrument | Dropped | Loads | Time | Fails |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        stems = ", ".join(f"{k} {v:.1f}" for k, v in r["stems"].items())
        bars = fmt(r["bar_lines"], True) + ("" if r["best_downbeat_setting"] == 0 else f" (setting {r['best_downbeat_setting']} fits)")
        if r["time_sig"] != "4/4":
            bars += f" · song is {r['time_sig']}"
        tempo = f"{r['tempo_pct']}%" + (f" ({r['tempo_note']})" if r["tempo_note"] else "")
        key = r["key"] + ("" if r["key_ok"] else f" (true {r['true_key']})")
        fails = ", ".join(r["fails"]) or "–"
        if r["drops"]:
            fails += " · fell: " + ", ".join(r["drops"])
        lines.append(f"| {r['song']} | {r['model']} | {stems} | {fmt(r['guitar_f1'], True)} | {fmt(r['bass_f1'], True)} | "
                     f"{fmt(r['tab_guitar_f1'], True)} | {fmt(r['tab_bass_f1'], True)} | {tempo} | {bars} | {key} | "
                     f"{fmt(r['guitar_leak'], True)} | {fmt(r['dropped_pct'])}% | {fmt(r['loads_ok'])} | {r['seconds_taken']:.0f} s | {fails} |")
    if errors:
        lines += ["", "**Runs that crashed:**", ""] + [f"- {e}" for e in errors]
    lines += ["", "SDR: how clean a stem is while its instrument plays (median of 1-second windows, as music-separation benchmarks do; higher is better, 10 dB is very clean, under 5 dB has audible bleed). Bleed (results.json) is the share of a stem's sound heard while its instrument is silent.",
              "F1: share of notes right in pitch and start (Guitar/Bass straight from basic-pitch within 50 ms; Tab = as written in the .gp5, within 100 ms).",
              "Note times are scored after taking out each run's steady delay (lag_ms in results.json, typically 30-60 ms: the sound's attack plus basic-pitch); notes doubled in unison count once.",
              "Wrong-instrument: guitar-track notes that were really another instrument (keys, vocals). Dropped: notes left out as unplayable.",
              "Bar lines: true bar lines the .gp5 has within 80 ms; \"setting N fits\" means BEATS_BEFORE_FIRST_DOWNBEAT = N would line them up."]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- main
def main():
    for stream in (sys.stdout, sys.stderr):  # the Windows console is cp1252; scores print · and →
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-k", default="")
    ap.add_argument("--models", default="")
    ap.add_argument("--seconds", type=float, default=0)
    ap.add_argument("--max-minutes", type=float, default=0)
    ap.add_argument("--rerender", action="store_true")
    args = ap.parse_args()

    cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    models = [m for m in (args.models or ",".join(cfg["models"])).split(",") if m]
    seconds = args.seconds or cfg["seconds"]
    songs = []
    for s in cfg["songs"]:
        p = Path(s["path"]).expanduser()
        if args.k.lower() in p.name.lower():
            if p.exists():
                songs.append((p, s.get("start")))
            else:
                print(f"missing song file, skipped: {p}")
    if not songs:
        print("no songs to test")
        return 2

    import torch
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU (no GPU found)"
    print(f"{len(songs)} songs × {len(models)} models on {gpu}")
    ns = load_notebook()
    OUT.mkdir(parents=True, exist_ok=True)
    history = OUT / "history.jsonl"
    last = {}
    if history.exists():
        for line in history.read_text(encoding="utf-8").splitlines():
            try:
                h = json.loads(line)
                last[(h["song"], h["model"])] = h
            except ValueError:
                pass

    from playwright.sync_api import sync_playwright
    srv = serve()
    rows, errors, t_all, stopped = [], [], time.time(), False
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.set_default_timeout(600_000)
        page.on("pageerror", lambda e: print("  page error:", e, flush=True))
        page.on("console", lambda m: print("  page:", m.text, flush=True) if m.text.startswith("[yt2gp5]") else None)
        page.goto(f"http://127.0.0.1:{srv.server_address[1]}/tests/yt2gp5/render.html")
        page.wait_for_function("window.renderReady === true")
        for song_path, start in songs:
            if args.max_minutes and time.time() - t_all > args.max_minutes * 60:
                print(f"stopped: the {args.max_minutes:g}-minute budget is used up")
                stopped = True
                break
            name = song_path.stem
            print(f"\n{name}")
            t0 = time.time()
            try:
                meta, mix, true_stems = render_song(page, song_path, seconds, start, args.rerender)
            except Exception as e:
                errors.append(f"{name}: test audio failed: {type(e).__name__}: {e}")
                print(f"  ERROR making test audio: {e}", flush=True)
                continue
            kinds = sorted({t["category"] for t in meta["tracks"]})
            print(f"  test audio {meta['start']:.0f}-{meta['start'] + meta['seconds']:.0f} s of {meta['songEnd']:.0f} s, "
                  f"{meta['bpm']:.0f} bpm {'/'.join(map(str, meta['timeSig']))}, instruments: {', '.join(kinds)} ({time.time() - t0:.0f} s)")
            for model in models:
                t1 = time.time()
                work = OUT / slug(name) / model
                shutil.rmtree(work, ignore_errors=True)
                work.mkdir(parents=True)
                try:
                    if torch.cuda.is_available():
                        torch.cuda.reset_peak_memory_stats()
                    import random
                    random.seed(0)  # Demucs' random shift: the same each run, so runs compare fairly
                    torch.manual_seed(0)
                    stems = ns["separate_stems"](mix, work / "stems", model)
                    t_sep = time.time() - t1
                    gmid, _ = ns["transcribe"](ns["guitar_stem"](stems), work / "guitar.mid", "guitar")
                    bmid, _ = ns["transcribe"](stems["bass"], work / "bass.mid", "bass")
                    detail = {}
                    beats, first = ns["find_beats"](mix)
                    summary = ns["build_gp5"](gmid, bmid, beats, work / "song.gp5", name, first, 25, detail)
                    loaded = page.evaluate("b => checkGp5(b)", base64.b64encode((work / "song.gp5").read_bytes()).decode())
                    r = score_run(meta, true_stems, stems, ns, gmid, bmid, summary, detail, loaded)
                    r.update(song=name, model=model, seconds_taken=round(time.time() - t1, 1), separation_s=round(t_sep, 1),
                             gpu_peak_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2) if torch.cuda.is_available() else 0,
                             when=datetime.datetime.now().isoformat(timespec="seconds"), seconds=seconds, start=meta["start"])
                    r["fails"] = failures(r, cfg["pass"])
                    r["drops"] = drops(r, last.get((name, model)), cfg["drop"])
                except Exception as e:  # one broken run is reported, and the others still run
                    import traceback
                    traceback.print_exc()
                    errors.append(f"{name} / {model}: {type(e).__name__}: {e}")
                    print(f"  {model}: ERROR {e}", flush=True)
                    continue
                rows.append(r)
                with history.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(r) + "\n")
                print(f"  {model}: stems {r['stems']} · guitar F1 {fmt(r['guitar_f1'], True)} · bass F1 {fmt(r['bass_f1'], True)} · "
                      f"tab {fmt(r['tab_guitar_f1'], True)}/{fmt(r['tab_bass_f1'], True)} · tempo {r['tempo_pct']}% · "
                      f"bars {fmt(r['bar_lines'], True)} · key {r['key']} · {r['seconds_taken']:.0f} s (separation {t_sep:.0f} s, "
                      f"GPU peak {r['gpu_peak_gb']} GB)" + (f"\n    FAILS: {', '.join(r['fails'])}" if r["fails"] else "")
                      + (f"\n    FELL: {', '.join(r['drops'])}" if r["drops"] else ""))
        browser.close()
    srv.shutdown()

    total = time.time() - t_all
    (OUT / "results.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    write_scorecard(rows, errors, gpu, total, OUT / "scorecard.md")
    n_fail = sum(bool(r["fails"]) for r in rows) + len(errors)
    per_song = total / max(1, len({r["song"] for r in rows}))
    print(f"\n{len(rows)} runs, {n_fail} failing, {total / 60:.1f} min ({per_song / 60:.1f} min per song) on {gpu}. "
          f"Cost: none (this PC). Scorecard: {OUT / 'scorecard.md'}" + (" (stopped early: budget)" if stopped else ""))
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
