"""Automatic checks of a tab against its recording, once listen.py has lined the two up: the spots that are
probably wrong, for the user to listen to and answer (their answers, kept in marks/, are what these limits
get tuned on).

  chords  a bar whose chords (all tracks together) sound unlike the recording's there
  notes   a track's notes in a bar that the tab's own mix shows clearly but the recording doesn't have
          (often the recording has the note a semitone away)
  timing  a track whose note starts sit early or late against the recording's in a bar

Times: tab seconds are the tab's own (from the start of its render), recording seconds the recording's.
"""
import numpy as np

RATE = 44100
HOP = 512  # spectrum frames, ~11.6 ms
LOW = 24  # the spectrum's lowest note (C1)
LIMITS = {
    "chord": 0.2,      # a bar's chord distance (0 same, 1 nothing alike) at least this, and well above the song's usual
    "note_rec": -2.0,  # dB: the note is this much quieter than the louder semitone next to it, in the recording...
    "note_tab": 3.0,   # ...while in the tab's own mix it stands this much above both
    "note_share": 0.5,  # this share of a track's checked notes in the bar
    "lag_ms": 70,      # a track this early or late...
    "lag_corr": 0.3,   # ...with its note starts clearly matching the recording's at that offset
    "most": 12,        # at most this many of each kind (the worst)
}
NAMES = "C C# D D# E F F# G G# A A# B".split()


def pitch_name(p):
    return f"{NAMES[p % 12]}{p // 12 - 1}"


def spectrum(y):
    """dB per semitone (rows: MIDI LOW..LOW+83) per frame."""
    import librosa
    C = np.abs(librosa.cqt(y, sr=RATE, hop_length=HOP, fmin=librosa.midi_to_hz(LOW), n_bins=84, bins_per_octave=12))
    return librosa.amplitude_to_db(C, ref=np.max)


def chroma(L):
    lin = 10 ** (L / 20)
    c = np.zeros((12, L.shape[1]), dtype=np.float32)
    for q in range(L.shape[0]):
        c[(q + LOW) % 12] += lin[q]
    return c


def contrast(L, p, f0, f1):
    """How far note p stands above the semitones either side of it over frames f0..f1 (dB), and which side is louder."""
    q = p - LOW
    if q < 1 or q > L.shape[0] - 2 or f1 <= f0:
        return None, 0
    e = L[q - 1:q + 2, f0:f1].mean(axis=1)
    return float(e[1] - max(e[0], e[2])), (-1 if e[0] > e[2] else 1)


def bar_spans(bars, song_end, rec_of):
    """[(bar number, time it's played (1st, 2nd...), tab s, tab end, rec s, rec end)] in played order."""
    seen, out = {}, []
    for i, b in enumerate(bars):
        end = bars[i + 1]["time"] if i + 1 < len(bars) else max(song_end, b["time"] + 0.5)
        n = b["index"] + 1
        seen[n] = seen.get(n, 0) + 1
        out.append((n, seen[n], b["time"], end, float(rec_of(b["time"])), float(rec_of(end))))
    return out


def bar_label(n, k):
    return f"bar {n}" + (f" ({['', '1st', '2nd', '3rd'][k] if k < 4 else str(k) + 'th'} time)" if k > 1 else "")


def suspects(rec, mix, onsets, song, rec_of, shift=0, limits=LIMITS):
    """rec: the recording (mono), mix: the tab's mix stretched onto the recording's time, onsets: {track index:
    its stretched audio's onset strength at 100 per s}, song: songNotes' result, rec_of: tab s → recording s."""
    import librosa
    lim = {**LIMITS, **limits}
    L_rec, L_tab = spectrum(rec), spectrum(mix)
    n = min(L_rec.shape[1], L_tab.shape[1])
    L_rec, L_tab = L_rec[:, :n], L_tab[:, :n]
    fr = lambda t: int(np.clip(t * RATE / HOP, 0, n))
    names = {t["index"]: t["name"] for t in song["tracks"]}
    drums = {t["index"] for t in song["tracks"] if t["category"] == "drums"}
    song_end = max([x["end"] for x in song["notes"]] + [0])
    spans = bar_spans(song["bars"], song_end, rec_of)
    out = []

    # chords, bar by bar
    c_rec, c_tab = chroma(L_rec), chroma(L_tab)
    dist = []
    for b in spans:
        f0, f1 = fr(b[4]), fr(b[5])
        if f1 - f0 < 5:
            dist.append(None)
            continue
        a, t = c_rec[:, f0:f1].mean(axis=1), c_tab[:, f0:f1].mean(axis=1)
        if t.sum() < 1e-6 or a.sum() < 1e-6:
            dist.append(None)
            continue
        dist.append(float(1 - a @ t / (np.linalg.norm(a) * np.linalg.norm(t))))
    real = np.array([d for d in dist if d is not None])
    if len(real):
        med = np.median(real)
        mad = np.median(np.abs(real - med)) or 0.01
        cut = max(lim["chord"], med + 4 * mad)
        bad = [(d, b) for d, b in zip(dist, spans) if d is not None and d >= cut]
        for d, b in sorted(bad, key=lambda x: -x[0])[:lim["most"]]:
            out.append({"kind": "chords", "bar": b[0], "time": b[1], "track": None, "tab": round(b[2], 2),
                        "rec": [round(b[4], 2), round(b[5], 2)], "score": round(d, 3),
                        "text": f"{bar_label(b[0], b[1])}: the chords sound different from the recording's"})

    # notes, per track and bar
    by = {}
    for x in song["notes"]:
        if x["track"] in drums:
            continue
        i = np.searchsorted([s[2] for s in spans], x["start"], side="right") - 1
        if i < 0:
            continue
        r0 = float(rec_of(x["start"]))
        r1 = float(rec_of(min(x["end"], x["start"] + 0.3)))
        f0, f1 = fr(r0 + 0.03), fr(r1)
        p = x["pitch"] + shift
        cr, side = contrast(L_rec, p, f0, f1)
        ct, _ = contrast(L_tab, p, f0, f1)
        if cr is None or ct is None:
            continue
        by.setdefault((x["track"], i), []).append((p, cr, ct, side, x["start"]))
    found = []
    for (t, i), ns in by.items():
        clear = [z for z in ns if z[2] >= lim["note_tab"]]
        bad = [z for z in clear if z[1] <= lim["note_rec"]]
        if not bad or len(bad) < lim["note_share"] * len(clear):
            continue
        b = spans[i]
        heard = sorted({pitch_name(z[0]) + " (the recording has " + pitch_name(z[0] + z[3]) + "?)" for z in bad})
        found.append({"kind": "notes", "bar": b[0], "time": b[1], "track": t, "tab": round(b[2], 2),
                      "rec": [round(b[4], 2), round(b[5], 2)],
                      "score": round(float(np.mean([z[2] - z[1] for z in bad])) * len(bad) / len(clear), 2),
                      "notes": sorted({round(z[4], 3) for z in bad}),
                      "text": f"{bar_label(b[0], b[1])}, {names.get(t, t)}: not in the recording: {', '.join(heard[:4])}"})
    out += sorted(found, key=lambda s: -s["score"])[:lim["most"]]

    # timing, per track and bar
    o_rec = librosa.onset.onset_strength(y=rec, sr=RATE, hop_length=RATE // 100)
    ks = np.arange(-15, 16)
    found = []
    for t, o in onsets.items():
        m = min(len(o), len(o_rec))
        run = None
        for i, b in enumerate(spans):
            s0, s1 = int(b[4] * 100) - 30, int(b[5] * 100) + 30
            lag = None
            if s0 >= 0 and s1 <= m and s1 - s0 > 60:
                a, q = o_rec[s0:s1] - o_rec[s0:s1].mean(), o[s0:s1] - o[s0:s1].mean()
                if np.linalg.norm(q) > 1e-6 and np.linalg.norm(a) > 1e-6:
                    c = np.array([np.dot(a[15:-15], np.roll(q, j)[15:-15]) for j in ks]) / (np.linalg.norm(a) * np.linalg.norm(q))
                    j = int(np.argmax(c))
                    if c[j] >= lim["lag_corr"] and abs(ks[j]) * 10 >= lim["lag_ms"]:
                        lag = int(ks[j]) * 10  # > 0: the tab is early
            if lag is not None and run and np.sign(run["lag"][-1]) == np.sign(lag) and run["last"] == i - 1:
                run["lag"].append(lag)
                run["last"] = i
                run["end"] = b
            else:
                if run:
                    found.append(run)
                run = {"track": t, "first": b, "end": b, "last": i, "lag": [lag]} if lag is not None else None
        if run:
            found.append(run)
    tim = []
    for r in found:
        b0, b1 = r["first"], r["end"]
        ms = int(np.median(r["lag"]))
        where = bar_label(b0[0], b0[1]) if b0 is b1 else f"bars {b0[0]}–{b1[0]}"
        tim.append({"kind": "timing", "bar": b0[0], "time": b0[1], "track": r["track"], "tab": round(b0[2], 2),
                    "rec": [round(b0[4], 2), round(b1[5], 2)], "score": abs(ms) * len(r["lag"]), "lag_ms": ms,
                    "text": f"{where}, {names.get(r['track'], r['track'])}: about {abs(ms)} ms {'early' if ms > 0 else 'late'}"})
    out += sorted(tim, key=lambda s: -s["score"])[:lim["most"]]
    for s in out:
        s["id"] = f"{s['kind']}:{s['bar']}:{s['time']}:{s['track']}"
    return out
