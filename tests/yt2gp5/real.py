"""Scores the YouTube → GP5 notebook on real recordings: the songs in songs.json that have a Guitar Pro file
and a YouTube link (songdb.py finds them).

For each song:
  1. the YouTube audio is downloaded (cached in cache/real/)
  2. Fretboard's synth plays the whole Guitar Pro file once (cached)
  3. the two are lined up by their chords (chroma + DTW), trying all 12 keys, so the tab's notes and bar lines
     get their times in the recording (and its key, if the band played it higher or lower)
  4. the notebook's own code runs on the recording, and the result is scored like run.py does, but with a
     wider timing window (100 ms for notes), because the line-up is only good to about a tenth of a second.
     There are no stem scores: a real recording has no true stems.
  5. out/real/scorecard.md, results.json and a line per run in history.jsonl

Run (from the project folder, with the test Python from README.md):
    python tests/yt2gp5/real.py
  -k NAME          only songs whose name contains NAME
  --model M        Demucs model (default htdemucs)
  --max-minutes N  don't start another song after N minutes
Exits 1 when a check fails its pass mark (config.json "pass_real"), 2 when no song is ready.
"""
import argparse
import base64
import datetime
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

import run  # the scoring, the page server and the notebook loader
import songdb

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache" / "real"
OUT = HERE / "out" / "real"
TOL = 0.1      # note timing window (s); bar lines get 1.6× this
HOP = 2048     # chroma frame for the line-up, at 22050 Hz (93 ms)


def ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def download(url, folder):
    """The video's audio as 44.1 kHz stereo WAV (cached by video id, so a new link downloads again)."""
    wav = folder / f"recording-{url.split('v=')[-1].split('&')[0]}.wav"
    if wav.exists():
        return wav
    import yt_dlp
    raw = folder / "download"
    shutil.rmtree(raw, ignore_errors=True)
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "format": "bestaudio/best",
                           "outtmpl": str(raw / "audio.%(ext)s"), "noplaylist": True, "noprogress": True}) as y:
        y.download([url])
    src = next(raw.iterdir())
    subprocess.run([ffmpeg(), "-v", "error", "-y", "-i", str(src), "-ac", "2", "-ar", "44100", str(wav)], check=True)
    shutil.rmtree(raw, ignore_errors=True)
    return wav


def render_whole(page, gp, folder):
    """The whole Guitar Pro song as one mix through Fretboard's synth, plus its notes and bar lines (cached)."""
    import soundfile as sf
    data = gp.read_bytes()
    sub = f"gp-{hashlib.sha1(data).hexdigest()[:12]}"
    meta_file = folder / sub / "meta.json"
    if not meta_file.exists():
        save_to = f"real/{folder.name}/{sub}"
        meta = page.evaluate("([b, o]) => renderSong(b, o)",
                             [base64.b64encode(data).decode(), {"whole": True, "saveTo": save_to}])
        mix = np.fromfile(folder / sub / "mix.f32", dtype=np.float32).reshape(-1, 2)
        sf.write(str(folder / sub / "mix.wav"), mix / max(1.0, float(np.abs(mix).max()) / 0.9), meta["rate"], subtype="FLOAT")
        (folder / sub / "mix.f32").unlink()
        meta_file.write_text(json.dumps(meta), encoding="utf-8")
    return json.loads(meta_file.read_text(encoding="utf-8")), folder / sub / "mix.wav"


def chroma(path):
    import librosa
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    c = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    return c / (np.linalg.norm(c, axis=0, keepdims=True) + 1e-9)


def align(gp_wav, rec_wav):
    """Lines the synth mix up with the recording. Returns (gp seconds → recording seconds, semitones the
    recording is above the tab, mean chroma distance along the path: 0 = same chords, ~0.5 = unrelated)."""
    import librosa
    a, b = chroma(gp_wav), chroma(rec_wav)
    # the key: compare chord-by-chord at a coarse step first, for all 12 shifts
    step = 4
    costs = []
    for k in range(12):
        D, _ = librosa.sequence.dtw(X=np.roll(a, k, axis=0)[:, ::step], Y=b[:, ::step], metric="cosine")
        costs.append(D[-1, -1])
    shift = int(np.argmin(costs))
    D, wp = librosa.sequence.dtw(X=np.roll(a, shift, axis=0), Y=b, metric="cosine")
    wp = wp[::-1]
    fps = 22050 / HOP
    gi, rj = wp[:, 0], wp[:, 1]
    # one recording time per synth frame (the middle of its run), smoothed over ~2 s, never going back
    uniq = np.unique(gi)
    rt = np.array([np.median(rj[gi == i]) for i in uniq])
    k = 21
    pad = np.pad(rt, k // 2, mode="edge")
    rt = np.array([np.median(pad[i:i + k]) for i in range(len(rt))])
    rt = np.maximum.accumulate(rt)
    gtimes, rtimes = (uniq + 0.5) / fps, (rt + 0.5) / fps
    dist = float(D[-1, -1] / len(wp))
    return (lambda t: np.interp(t, gtimes, rtimes)), (shift if shift <= 6 else shift - 12), dist


WINDOW = 10.0  # seconds of the tab per stretch in whole_match


def whole_match(gp_wav, rec_wav, window=WINDOW):
    """Does the recording follow the tab from start to end, or only on average? Lines the two up as align()
    does, then checks every `window` seconds of the tab on its own: its chords (distance), its length in
    the recording (ratio: ~1 when the band plays the same part at the same speed; a missing or extra
    chorus, a skit or a long intro shows as a far-off ratio), and how much of the recording is left over
    at the start and the end. Silence at either end is trimmed first, so a quiet lead-in doesn't count.
    Returns a dict; "ok" is True when every stretch matches (limits in MATCH)."""
    import librosa
    fps = 22050 / HOP

    def load(path):
        y, sr = librosa.load(str(path), sr=22050, mono=True)
        _, (i0, i1) = librosa.effects.trim(y, top_db=35, frame_length=4096, hop_length=HOP)
        c = librosa.feature.chroma_cqt(y=y[i0:i1], sr=sr, hop_length=HOP)
        return c / (np.linalg.norm(c, axis=0, keepdims=True) + 1e-9), (i1 - i0) / sr, i0 / sr

    a, gp_len, gp_off = load(gp_wav)
    b, rec_len, rec_off = load(rec_wav)
    step = 4
    costs = [librosa.sequence.dtw(X=np.roll(a, k, axis=0)[:, ::step], Y=b[:, ::step], metric="cosine")[0][-1, -1] for k in range(12)]
    shift = int(np.argmin(costs))
    a = np.roll(a, shift, axis=0)
    # a step off the diagonal costs a little, so where the chords repeat the path keeps going straight
    # instead of wobbling (a real missing or extra part still costs far less than its wrong chords)
    sc = MATCH["skip_cost"]
    D, wp = librosa.sequence.dtw(X=a, Y=b, metric="cosine", weights_add=np.array([0.0, sc, sc]))
    wp = wp[::-1]
    gi, rj = wp[:, 0], wp[:, 1]
    cost = 1 - np.sum(a[:, gi] * b[:, rj], axis=0)  # cosine distance of each matched pair
    # the recording's time for each tab frame, as in align(): middle of its run, smoothed, never going back
    uniq = np.unique(gi)
    rt = np.array([np.median(rj[gi == i]) for i in uniq])
    k = 21
    pad = np.pad(rt, k // 2, mode="edge")
    rt = np.maximum.accumulate(np.array([np.median(pad[i:i + k]) for i in range(len(rt))]))
    to_rec = lambda t: float(np.interp(t * fps, uniq, rt)) / fps
    # what the recording has before the tab's first second and after its last
    head = rj[gi < fps].max() / fps - 1.0
    tail = (len(b[0]) - rj[gi >= len(a[0]) - fps].min()) / fps - 1.0
    n = max(1, round(gp_len / window))
    edges = np.linspace(0, gp_len, n + 1)
    parts = []
    for t0, t1 in zip(edges, edges[1:]):
        sel = (gi >= t0 * fps) & (gi < t1 * fps)
        r0, r1 = to_rec(t0), to_rec(t1)
        parts.append({"tab": [round(float(t0), 1), round(float(t1), 1)], "rec": [round(r0, 1), round(r1, 1)],
                      "dist": round(float(cost[sel].mean()) if sel.any() else 1.0, 3),
                      "ratio": round(float((r1 - r0) / max(1e-6, t1 - t0)), 2)})
    m = MATCH
    # chords are checked per stretch. The timing by its drift (recording time minus tab time): a missing or
    # extra part moves the drift from one steady level to another and it stays there. Where the band plays
    # freely (a rubato intro) or the chords repeat, the drift wanders and comes back: that is noted ("timing
    # wanders"), not failed. So each stretch compares the nearest steady 10 s before it with the nearest after.
    T = np.arange(0, gp_len, 0.5)
    drift = np.array([to_rec(t) - t for t in T])
    steady = []  # (start, end, level) of every steady 10 s
    for t in np.arange(0, max(0.0, gp_len - 10) + 0.01, 2.0):
        d = drift[(T >= t) & (T <= t + 10)]
        if len(d) and np.percentile(d, 90) - np.percentile(d, 10) <= m["steady_s"]:
            steady.append((t, t + 10, float(np.median(d))))
    look = m["side_s"]
    for p in parts:
        t0, t1 = p["tab"]
        before = [w for w in steady if t0 - look <= w[1] <= t0 + 1e-6]
        after = [w for w in steady if t1 - 1e-6 <= w[0] <= t1 + look]
        step = after[0][2] - before[-1][2] if before and after else 0.0
        inside = drift[(T >= t0) & (T <= t1)]
        p["step_s"] = round(step, 1)
        p["wanders"] = bool(len(inside) and np.percentile(inside, 90) - np.percentile(inside, 10) > m["steady_s"])
        p["why"] = ", ".join(w for w, bad in (("chords differ", p["dist"] > m["dist"]),
                                              (f"recording {step:.0f} s longer here", step > m["step_s"]),
                                              (f"recording {-step:.0f} s shorter here", step < -m["step_s"])) if bad)
    bad = [p for p in parts if p["why"]]
    total = rec_len / gp_len
    # another key is another recording (a cover, a live take): the tab sounds in the key it was made from
    ok = bool(shift == 0 and not bad and head <= m["edge_s"] and tail <= m["edge_s"] and 1 / m["length"] <= total <= m["length"])
    return {"ok": ok, "shift": shift if shift <= 6 else shift - 12, "dist": round(float(cost.mean()), 3),
            "worst": round(max(p["dist"] for p in parts), 3), "head_s": round(float(head), 1), "tail_s": round(float(tail), 1),
            "length_ratio": round(float(total), 3), "tab_s": round(float(gp_len), 1), "rec_s": round(float(rec_len), 1), "bad": bad, "parts": parts,
            # tab seconds → recording seconds, every half second, from the start of each file (for listen.py)
            "map": [[round(t + gp_off, 3), round(to_rec(t) + rec_off, 3)] for t in np.arange(0, gp_len, 0.5)]}


# whole_match limits: a stretch's chord distance, the off-diagonal cost of the line-up, the drift step (s) across a
# stretch between steady levels up to side_s away (steady: 80% of 10 s within steady_s),
# seconds of recording left over at either end, and the whole length's ratio
MATCH = {"dist": 0.33, "skip_cost": 0.05, "step_s": 4.0, "side_s": 60.0, "steady_s": 1.5, "edge_s": 6.0, "length": 1.1}


def real_meta(meta, to_rec, shift):
    """The tab's truth moved into the recording's time and key, in the form run.score_run reads."""
    notes = [{**n, "start": float(to_rec(n["start"])), "end": float(to_rec(n["end"])), "pitch": n["pitch"] + shift}
             for n in meta["notes"]]
    bars = [{**b, "time": float(to_rec(b["time"]))} for b in meta["barLines"]]
    # the true tempo as the band played it: beats per bar over each bar's length in the recording
    bpms = [b["num"] * (4 / b["den"]) * 60 / (n["time"] - b["time"]) for b, n in zip(bars, bars[1:]) if n["time"] - b["time"] > 0.3]
    bpm = float(np.median(bpms)) if bpms else meta["bpm"]
    return {**meta, "notes": notes, "barLines": bars, "bpm": bpm, "fifths": (meta["fifths"] + 7 * shift + 6) % 12 - 6}


def write_scorecard(rows, errors, gpu, total_s, path):
    lines = ["# YouTube → GP5 scorecard: real recordings", "",
             f"{datetime.datetime.now():%Y-%m-%d %H:%M} · {gpu} · {total_s / 60:.1f} min · "
             f"{sum(not r['fails'] for r in rows)} of {len(rows)} songs pass", "",
             "| Song | Line-up | Guitar F1 | Bass F1 | Tab guitar | Tab bass | Tempo off | Bar lines | Key | Wrong-instrument | Dropped | Loads | Time | Fails |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    fmt = run.fmt
    for r in rows:
        line_up = f"{r['align_dist']:.2f}" + (f", {r['shift']:+d} st" if r["shift"] else "") + (" **poor**" if r["align_poor"] else "")
        bars = fmt(r["bar_lines"], True) + ("" if r["best_downbeat_setting"] == 0 else f" (setting {r['best_downbeat_setting']} fits)")
        if r["time_sig"] != "4/4":
            bars += f" · song is {r['time_sig']}"
        tempo = f"{r['tempo_pct']}%" + (f" ({r['tempo_note']})" if r["tempo_note"] else "")
        key = r["key"] + ("" if r["key_ok"] else f" (true {r['true_key']})")
        fails = ", ".join(r["fails"]) or "–"
        if r["drops"]:
            fails += " · fell: " + ", ".join(r["drops"])
        lines.append(f"| {r['song']} | {line_up} | {fmt(r['guitar_f1'], True)} | {fmt(r['bass_f1'], True)} | "
                     f"{fmt(r['tab_guitar_f1'], True)} | {fmt(r['tab_bass_f1'], True)} | {tempo} | {bars} | {key} | "
                     f"{fmt(r['guitar_leak'], True)} | {fmt(r['dropped_pct'])}% | {fmt(r['loads_ok'])} | {r['seconds_taken']:.0f} s | {fails} |")
    if errors:
        lines += ["", "**Songs that crashed:**", ""] + [f"- {e}" for e in errors]
    lines += ["", "Line-up: mean chord distance between the tab (played by Fretboard's synth) and the recording after lining them up (0 = same chords; above 0.25 the video is probably another version, and its scores mean little). A band doesn't play exactly on the tab's grid, so notes and bar lines can only be lined up to about 0.1-0.15 s: compare these scores with earlier runs, not with the synth test. \"+2 st\": the recording is 2 semitones above the tab.",
              f"F1: share of the tab's notes found with the right pitch, starting within {TOL * 1000:.0f} ms (Tab: as written in the .gp5, within {2 * TOL * 1000:.0f} ms). A real band doesn't always play what the tab says, so these run lower than the synth test.",
              "Tempo, bar lines, key, wrong-instrument, dropped and loads: as in the synth test (scorecard.md)."]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-k", default="")
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--max-minutes", type=float, default=0)
    args = ap.parse_args()

    cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    marks = cfg.get("pass_real", cfg["pass"])
    db = songdb.load()
    songs = [s for s in db["songs"] if s.get("gp") and songdb.usable(s) and args.k.lower() in s["name"].lower()]
    songs = [s for s in songs if Path(s["gp"]).exists() or print(f"missing tab file, skipped: {s['gp']}")]
    if not songs:
        print("no song has both a tab and a confirmed YouTube link (see songdb.py list)")
        return 2

    import torch
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU (no GPU found)"
    print(f"{len(songs)} recordings, {args.model}, on {gpu}")
    ns = run.load_notebook()
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
    srv = run.serve()
    rows, errors, t_all = [], [], time.time()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.set_default_timeout(1_200_000)
        page.on("pageerror", lambda e: print("  page error:", e, flush=True))
        page.goto(f"http://127.0.0.1:{srv.server_address[1]}/tests/yt2gp5/render.html")
        page.wait_for_function("window.renderReady === true")
        for s in songs:
            if args.max_minutes and time.time() - t_all > args.max_minutes * 60:
                print(f"stopped: the {args.max_minutes:g}-minute budget is used up")
                break
            name = s["name"]
            print(f"\n{name}  ({s['youtube']})", flush=True)
            t1 = time.time()
            folder = CACHE / run.slug(name)
            folder.mkdir(parents=True, exist_ok=True)
            work = OUT / run.slug(name)
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True)
            try:
                rec = download(s["youtube"], folder)
                meta, gp_wav = render_whole(page, Path(s["gp"]), folder)
                to_rec, shift, dist = align(gp_wav, rec)
                m = real_meta(meta, to_rec, shift)
                print(f"  lined up: chord distance {dist:.2f}, recording {shift:+d} semitones from the tab, "
                      f"{m['bpm']:.0f} bpm as played ({time.time() - t1:.0f} s)", flush=True)
                if torch.cuda.is_available():
                    torch.cuda.reset_peak_memory_stats()
                import random
                random.seed(0)
                torch.manual_seed(0)
                stems = ns["separate_stems"](rec, work / "stems", args.model)
                gmid, _ = ns["transcribe"](ns["guitar_stem"](stems), work / "guitar.mid", "guitar")
                bmid, _ = ns["transcribe"](stems["bass"], work / "bass.mid", "bass")
                detail = {}
                beats, first = ns["find_beats"](rec)
                summary = ns["build_gp5"](gmid, bmid, beats, work / "song.gp5", name, first, 25, detail)
                loaded = page.evaluate("b => checkGp5(b)", base64.b64encode((work / "song.gp5").read_bytes()).decode())
                r = run.score_run(m, {}, stems, ns, gmid, bmid, summary, detail, loaded, tol=TOL)
                r.update(song=name, model=args.model, youtube=s["youtube"], shift=shift, align_dist=round(dist, 3),
                         align_poor=dist > 0.25, seconds_taken=round(time.time() - t1, 1),
                         gpu_peak_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2) if torch.cuda.is_available() else 0,
                         when=datetime.datetime.now().isoformat(timespec="seconds"))
                r["fails"] = run.failures(r, marks)
                r["drops"] = run.drops(r, last.get((name, args.model)), cfg["drop"])
            except Exception as e:
                import traceback
                traceback.print_exc()
                errors.append(f"{name}: {type(e).__name__}: {e}")
                print(f"  ERROR {e}", flush=True)
                continue
            rows.append(r)
            with history.open("a", encoding="utf-8") as f:
                f.write(json.dumps(r) + "\n")
            print(f"  guitar F1 {run.fmt(r['guitar_f1'], True)} · bass F1 {run.fmt(r['bass_f1'], True)} · "
                  f"tab {run.fmt(r['tab_guitar_f1'], True)}/{run.fmt(r['tab_bass_f1'], True)} · tempo {r['tempo_pct']}% "
                  f"{r['tempo_note']} · bars {run.fmt(r['bar_lines'], True)} · key {r['key']} (true {r['true_key']}) · "
                  f"{r['seconds_taken']:.0f} s, GPU peak {r['gpu_peak_gb']} GB"
                  + (f"\n    FAILS: {', '.join(r['fails'])}" if r["fails"] else ""), flush=True)
        browser.close()
    srv.shutdown()

    total = time.time() - t_all
    (OUT / "results.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    write_scorecard(rows, errors, gpu, total, OUT / "scorecard.md")
    n_fail = sum(bool(r["fails"]) for r in rows) + len(errors)
    print(f"\n{len(rows)} songs, {n_fail} failing, {total / 60:.1f} min on {gpu}. Cost: none (this PC). "
          f"Scorecard: {OUT / 'scorecard.md'}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
