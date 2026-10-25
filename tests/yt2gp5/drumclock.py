"""The drum clock: how far the recording's beat sits from the sync's, every 4 bars, to a few ms.

    python tests/yt2gp5/drumclock.py NAME        one song from out/listen (part of its name is enough)
    python tests/yt2gp5/drumclock.py --all       every song there
    python tests/yt2gp5/drumclock.py --selftest  moves a stretch of each song 30, 60 and 90 ms; each must be found

Demucs (htdemucs, on the GPU when there is one) splits the recording once into drums, bass, other and vocals,
cached in cache/real/<song>/stems-<video id>/ (about 50 s a song). Each stem's note-start strength is folded onto
the tab's own notes of that instrument, moved to the video by the sync: for each shift, how strong the stem is
at those times. The strongest shift is how far the recording sits from the sync there. The drums fold onto the
tab's drum part (the beats when it has none), so a drummer accenting a 16th late isn't read as a sync a 16th out.

Every STRETCH bars get an offset, a ± (half the gap between the stretch's two halves) and a clarity (the peak over
the median). A stretch with unclear drums (a quiet intro) tries the bass, then the other stem. A step is real
only when two stretches in a row sit over STEP_MS from the song's level, on the same side. A song whose level is
itself over STEP_MS isn't sure (the drums sit off everywhere). qa.py calls `clock` by itself; nothing here needs
a person to listen.
"""
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import real  # noqa: E402
import run  # noqa: E402
import syncqa  # noqa: E402

SR = 22050
HOP = 64            # 2.9 ms per frame
STRETCH = 4         # bars per measured stretch
CLEAR = 6.0         # a stretch counts when its peak is this many times the median
QUIET = 0.1         # a stem this much quieter on the beats than over the whole song is silent there
STEP_MS = 20        # a stretch this far from the song's level is off
OUTSIDE = 1.2       # a peak outside the search this much stronger means the part sits elsewhere: unclear
STEP_RUN = 2        # for this many stretches in a row
LOOSE_MS = 10       # a stretch whose two halves differ by more than twice this isn't sure enough to count
SOURCES = ("drums", "bass", "other")
# each stem is folded onto the tab's notes of the same instruments (the drums onto the beats when the tab has none)
PARTS = {"drums": {"drums"}, "bass": {"bass"}, "other": {"guitar", "piano"}}


def split(wav, folder):
    """Demucs stems of the recording, mono at SR, written into `folder`."""
    import soundfile as sf
    import torch
    import julius
    import librosa
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    print(f"splitting {wav.name} into drums, bass, other and vocals (Demucs, once)...", flush=True)
    model = get_model("htdemucs")
    model.eval()
    audio, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    x = torch.from_numpy(audio.T.copy())
    x = (x.repeat(2, 1) if x.shape[0] == 1 else x)[:2]
    if sr != model.samplerate:
        x = julius.resample_frac(x, sr, model.samplerate)
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    mix = ((x - mean) / std)[None]
    tries = [("cuda", None), ("cuda", 7.0), ("cpu", None)] if torch.cuda.is_available() else [("cpu", None)]
    for dev, seg in tries:
        try:
            with torch.no_grad():
                stems = apply_model(model, mix, device=dev, split=True, overlap=0.25, progress=False,
                                    **({"segment": seg} if seg else {}))[0]
            break
        except RuntimeError as e:  # out of GPU memory: shorter pieces, then the CPU
            if "out of memory" not in str(e).lower():
                raise
            torch.cuda.empty_cache()
    folder.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(model.sources):
        y = librosa.resample((stems[i] * std + mean).mean(0).numpy(), orig_sr=model.samplerate, target_sr=SR)
        sf.write(str(folder / f"{name}.wav"), y, SR)


def strength(song, info):
    """Each stem's note-start strength at HOP (cached beside the stems)."""
    import librosa
    import soundfile as sf
    wav = real.download(info["url"], real.CACHE / run.slug(song["name"]))
    folder = wav.parent / f"stems-{wav.stem.split('recording-')[-1]}"
    f = folder / "strength.npz"
    if f.exists():
        return dict(np.load(f))
    if not all((folder / f"{n}.wav").exists() for n in SOURCES):
        split(wav, folder)
    out = {}
    for n in SOURCES:
        y = sf.read(str(folder / f"{n}.wav"), dtype="float32")[0]
        if n == "drums":  # hits: the rise in loudness, sharp in time
            e = np.log1p(10 * np.abs(librosa.stft(y, n_fft=512, hop_length=HOP)).sum(0))
            out[n] = np.maximum(0, np.diff(e, prepend=e[0])).astype(np.float32)
        else:  # notes: spectral flux
            out[n] = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, n_fft=1024).astype(np.float32)
    np.savez(f, **out)
    return out


def fold(e, beats, most_ms, beat_ms, floor=0.0):
    """(offset ms, clarity) of the strength `e` on the beat times `beats` (s), the peak searched up to most_ms
    away. Clarity is 0 where it can't be trusted: the stem is silent there (under `floor`), the peak is at
    the edge of the search, or a much stronger peak lies outside it (the part doesn't sit on these notes)."""
    fps = SR / HOP
    lags = np.arange(-0.75 * beat_ms, 0.75 * beat_ms + 0.1, 1000 / fps)
    g = np.array([e[np.clip(np.round((beats + k / 1000) * fps).astype(int), 0, len(e) - 1)].mean() for k in lags])
    inside = np.abs(lags) <= most_ms
    j = int(np.flatnonzero(inside)[np.argmax(g[inside])])
    p = 0.0
    if 0 < j < len(g) - 1:  # the peak between frames
        a, b, c = g[j - 1], g[j], g[j + 1]
        p = 0.5 * (a - c) / (a - 2 * b + c) if a - 2 * b + c < 0 else 0.0
    ms = float(lags[j] + p * 1000 / fps)
    if np.mean(g) < floor or abs(lags[j]) > most_ms - 2 * 1000 / fps or g.max() > OUTSIDE * g[j]:
        return ms, 0.0
    return ms, float(g[j] / (np.median(g) + 1e-9))


def clock(s, points=None):
    """Every STRETCH bars of song `s` (qa.load): how far the recording's beat sits from the sync's (ms; the
    recording earlier is negative), with its ± and the stem it was read from. Its own sync points unless others
    are given. `sure` is False when the song's level itself is over STEP_MS: the drums then sit off the sync
    everywhere (the whole sync off, or a part that doesn't sit on the tab's notes), and its steps can't be read."""
    st = strength(s["song"], s["info"])
    bars = s["bars"]
    ps = sorted(s["points"] if points is None else points)
    sync = syncqa.Sync.from_points([b[0] for b in bars], ps)
    floor = {k: QUIET * float(np.mean(v)) for k, v in st.items()}
    # the tab's own notes per stem: folding onto them, not onto the beats, keeps a part played off the beat
    # (a drummer accenting a 16th late) from being taken for a sync a 16th out
    notes = json.loads((s["out"] / "notes.json").read_text(encoding="utf-8"))
    starts = {}
    for src, cats in PARTS.items():
        tr = {t["index"] for t in notes["tracks"] if t["category"] in cats}
        starts[src] = np.array(sorted({round(n["start"], 4) for n in notes["notes"] if n["track"] in tr}))
    rows = []
    for i in range(0, len(bars), STRETCH):
        part = bars[i:i + STRETCH]
        beats = np.concatenate([t0 + (t1 - t0) * np.arange(n) / n for t0, t1, n in part])
        r = sync(beats)
        beat_ms = 1000 * float(np.median(np.diff(r))) if len(r) > 1 else 500
        most = min(150, 0.4 * beat_ms)  # well inside a beat, so the next beat can't be taken for this one
        row = {"bars": [i + 1, i + len(part)], "ms": None, "pm": None, "clarity": 0.0, "from": None}
        for src in SOURCES:
            t = starts[src]
            t = t[(t >= part[0][0]) & (t < part[-1][1])]
            if len(t) >= len(beats):
                on, name = sync(t), f"{src} part"
            elif src == "drums" and not len(starts[src]):  # no drum part in the tab at all: the beats
                on, name = r, "drum beat"
            else:
                continue
            ms, q = fold(st[src], on, most, beat_ms, floor[src])
            if q >= CLEAR:
                h = len(on) // 2
                a, b = (fold(st[src], x, most, beat_ms)[0] for x in (on[:h], on[h:]))
                pm = max(1.5, abs(a - b) / 2)
                if pm <= LOOSE_MS:
                    row.update(ms=round(ms, 1), pm=round(pm, 1), clarity=round(q, 1), **{"from": name})
                    break
        rows.append(row)
    clear = [r["ms"] for r in rows if r["ms"] is not None]
    level = float(np.median(clear)) if clear else 0.0
    return {"level_ms": round(level, 1), "sure": bool(clear) and abs(level) <= STEP_MS, "clear": round(len(clear) / max(1, len(rows)), 2), "stretches": rows,
            "steps": steps(rows, level)}


def steps(rows, level):
    """Runs of STEP_RUN+ clear stretches over STEP_MS from the song's level, on one side."""
    out, cur = [], []
    side = lambda r: 0 if r["ms"] is None or abs(r["ms"] - level) <= STEP_MS else (1 if r["ms"] > level else -1)

    def close():
        if len(cur) >= STEP_RUN:
            out.append({"bars": [cur[0]["bars"][0], cur[-1]["bars"][1]],
                        "ms": round(float(np.median([r["ms"] - level for r in cur])), 1),
                        "pm": round(float(np.median([r["pm"] for r in cur])), 1)})
    for r in rows:
        if r["ms"] is None:  # unclear stretches don't break a run
            continue
        sd = side(r)
        if sd and cur and side(cur[-1]) == sd:
            cur.append(r)
        else:
            close()
            cur = [r] if sd else []
    close()
    return out


def at(c, a, b):
    """The clear stretches inside bars a..b: (largest offset from the level in ms, its ±, how many), or None."""
    rs = [r for r in c["stretches"] if r["ms"] is not None and r["bars"][0] <= b and a <= r["bars"][1]]
    if not rs:
        return None
    r = max(rs, key=lambda r: abs(r["ms"] - c["level_ms"]))
    return round(r["ms"] - c["level_ms"], 1), r["pm"], len(rs)


def show(name, c):
    print(f"{name}: the recording's beat sits {c['level_ms']:+.1f} ms from the sync's; {100 * c['clear']:.0f}% of stretches clear")
    print("  " + " ".join(f"{r['bars'][0]}:{r['ms'] - c['level_ms']:+.0f}{r['from'][0]}" if r["ms"] is not None else f"{r['bars'][0]}:?"
                          for r in c["stretches"]))
    if not c["sure"]:
        print(f"  NOT SURE: the drums sit off the sync everywhere, so steps can't be read")
    for st in c["steps"]:
        print(f"  STEP bars {st['bars'][0]}-{st['bars'][1]}: {st['ms']:+.1f} ± {st['pm']:.1f} ms")
    if not c["steps"]:
        print(f"  no steps: every clear stretch is within {STEP_MS} ms")


def selftest(names):
    import qa
    right = total = 0
    for name in names:
        s = qa.load(name)
        base = clock(s)
        if not base["sure"]:
            print(f"  -- {name[:30]:30} the drums sit {base['level_ms']:+.0f} ms off everywhere: not readable, skipped")
            continue
        # the 16 bars (4 stretches) with the most clear stretches, the middle of the song on a tie
        rows = base["stretches"]
        mid = len(rows) // 2
        k = max(range(max(1, len(rows) - 3)), key=lambda k: (sum(r["ms"] is not None for r in rows[k:k + 4]), -abs(k - mid)))
        if sum(r["ms"] is not None for r in rows[k:k + 4]) < STEP_RUN:
            print(f"  -- {name[:30]:30} no 16 bars with a clear beat, skipped")
            continue
        a, b = k * STRETCH, min(len(s["bars"]), k * STRETCH + 16)  # bars a+1..b, 0-based points a..b-1
        for move in (30, 60, 90):
            # moving the sync later there puts the recording's beat earlier against it
            pts = [(p, ms + move if a <= p < b else ms) for p, ms in s["points"]]
            c = clock(s, pts)
            found = [x for x in c["steps"] if x["bars"][0] <= b and a + 1 <= x["bars"][1]]
            ms = found[0]["ms"] if found else None
            good = ms is not None and abs(-ms - move) <= 10
            right += good
            total += 1
            print(f"  {'ok ' if good else 'BAD'} {name[:30]:30} bars {a + 1}-{b} moved {move} ms: "
                  + (f"found {-ms:+.1f} ± {found[0]['pm']} ms" if found else "not found"))
    print(f"DRUM CLOCK {'WORKS' if right == total else 'MISSES'}: {right} of {total} moves found to within 10 ms")
    return right == total


def main():
    import qa
    a = sys.argv[1:]
    names = None
    if "--all" in a or "--selftest" in a:
        names = [json.loads((p / "info.json").read_text(encoding="utf-8"))["name"]
                 for p in sorted(qa.listen.OUT.iterdir()) if (p / "info.json").exists()]
        names = list(dict.fromkeys(names))
    if "--selftest" in a:
        sys.exit(0 if selftest(names) else 1)
    for name in names or [" ".join(x for x in a if not x.startswith("--"))]:
        s = qa.load(name)
        show(s["song"]["name"], clock(s))


if __name__ == "__main__":
    main()
