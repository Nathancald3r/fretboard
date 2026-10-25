"""Key points by synctoolbox, one steady tempo between them, against the current sync.

    python tests/yt2gp5/anchors.py NAME        one song
    python tests/yt2gp5/anchors.py --all       every song in out/listen

synctoolbox (audiolabs-erlangen, MrMsDTW on chroma + note-start features) lines the tab's own sound up with
the recording all the way through. Its path wobbles from frame to frame, so it is used only for key points:
the start of each tab section. Between two key points the tempo stays steady (a straight line), so the tempo
can change only where a section starts. A key point is kept only when its section's tempo agrees with the
song's within KEEP_PCT: a section that doesn't (the recording plays something the tab doesn't, like Be My
Escape's outro) carries on at the tempo before it, and the tab may then end before or after the recording.
Nothing is squeezed to end together.

Writes <stem> (key points).fretboard beside the song, and prints for both syncs: the gate's verdict, the
note starts heard within 30 ms, and how far each section is off from where it lines up best.
"""
import copy
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import compare  # noqa: E402
import qa  # noqa: E402
import real  # noqa: E402
import run  # noqa: E402
import syncqa  # noqa: E402
from syncqa import SR, Sync  # noqa: E402

RATE = 50        # feature frames a second
LONG_S = 300     # longer songs use RATE / 2: synctoolbox's grids grow with length squared (Trust In God, 7.4 min, went over 9 GB)
KEEP_PCT = 3.0   # a section's tempo may differ from the song's by this much and still get a key point


def features(y, rate):
    from synctoolbox.feature.chroma import pitch_to_chroma, quantize_chroma
    from synctoolbox.feature.dlnco import pitch_onset_features_to_DLNCO
    from synctoolbox.feature.pitch import audio_to_pitch_features
    from synctoolbox.feature.pitch_onset import audio_to_pitch_onset_features
    chroma = quantize_chroma(pitch_to_chroma(audio_to_pitch_features(f_audio=y, Fs=SR, feature_rate=rate)))
    onsets = audio_to_pitch_onset_features(f_audio=y, Fs=SR)
    return chroma, pitch_onset_features_to_DLNCO(f_peaks=onsets, feature_rate=rate, feature_sequence_length=chroma.shape[1])


def path(s):
    """synctoolbox's line-up: tab seconds -> recording seconds (cached beside the song)."""
    f = s["out"] / "anchors_path.npz"
    if f.exists():
        d = np.load(f)
        if str(d["sha"]) == s["info"]["gp_sha"]:
            return d["tab"], d["rec"]
    import librosa
    from synctoolbox.dtw.mrmsdtw import sync_via_mrmsdtw
    from synctoolbox.dtw.utils import compute_optimal_chroma_shift, make_path_strictly_monotonic, shift_chroma_vectors
    wav = real.download(s["info"]["url"], real.CACHE / run.slug(s["song"]["name"]))
    rec, _ = librosa.load(str(wav), sr=SR, mono=True)
    tab = syncqa.tab_mix(s["song"], s["info"])
    rate = RATE if max(len(tab), len(rec)) / SR <= LONG_S else RATE // 2
    (ct, ot), (cr, orr) = features(tab, rate), features(rec, rate)
    shift = compute_optimal_chroma_shift(ct, cr)
    cr, orr = shift_chroma_vectors(cr, shift), shift_chroma_vectors(orr, shift)
    wp = sync_via_mrmsdtw(f_chroma1=ct, f_onset1=ot, f_chroma2=cr, f_onset2=orr, input_feature_rate=rate,
                          step_weights=np.array([1.5, 1.5, 2.0]), threshold_rec=10 ** 4)  # 10**6 took 18 GB on a long song
    wp = make_path_strictly_monotonic(wp)
    t, r = wp[0] / rate, wp[1] / rate
    np.savez(f, tab=t, rec=r, sha=s["info"]["gp_sha"])
    return t, r


def key_points(s, t, r):
    """Each section start's place in the recording, and the steady line between the ones kept."""
    bars, info = s["bars"], s["info"]
    x = np.array([b[0] for b in bars])
    mapped = np.interp(x, t, r)
    starts = [0] + [p for p, b in enumerate(info["bars"]) if p and len(b) > 3 and b[3]]
    # The section start's place: a straight line through its first bars (the path wobbles a few frames)
    def at(p):
        q = min(len(bars), p + 4)
        if q - p < 2:
            return float(mapped[p])
        k = np.polyfit(x[p:q], mapped[p:q], 1)
        return float(np.polyval(k, x[p]))
    song_rate = float(np.median(np.diff(mapped) / np.diff(x)))
    kept, dropped = [(0, at(0))], []
    for p in starts[1:]:
        v = at(p)
        p0, v0 = kept[-1]
        rate = (v - v0) / (x[p] - x[p0])
        if abs(100 * (rate / song_rate - 1)) <= KEEP_PCT:
            kept.append((p, v))
        else:
            dropped.append((p, round(100 * (rate / song_rate - 1), 1)))
    # The end: the last section's tempo carries on, unless the end lines up too
    p0, v0 = kept[-1]
    end = len(bars) - 1
    v = float(mapped[end])
    rate = (v - v0) / max(1e-6, x[end] - x[p0]) if end > p0 else song_rate
    if end > p0 and abs(100 * (rate / song_rate - 1)) > KEEP_PCT:
        dropped.append(("end", round(100 * (rate / song_rate - 1), 1)))
        prev = (kept[-1][1] - kept[-2][1]) / (x[kept[-1][0]] - x[kept[-2][0]]) if len(kept) > 1 else song_rate
        v = v0 + prev * (x[end] - x[p0])
    kx = [x[p] for p, _ in kept] + ([x[end]] if end > p0 else [])
    ky = [v for _, v in kept] + ([v] if end > p0 else [])
    # synctoolbox's path sits ~30-45 ms late all through (Be My Escape): the whole line goes to its best
    # spot, the start fix the current sync gets too
    line = Sync(np.array(kx), np.array(ky))
    lags, c = syncqa.lag_curve(line, s["tab_env"], s["env"], most=0.1)
    move = float(lags[int(np.argmax(c))])
    return Sync(np.array(kx), np.array(ky) + move), [(p, v + move) for p, v in kept], dropped


def sections_off(s, sync):
    """How far each section is from where it lines up best (ms), by the gate's own line-up."""
    bars, info = s["bars"], s["info"]
    starts = [0] + [p for p, b in enumerate(info["bars"]) if p and len(b) > 3 and b[3]] + [len(bars)]
    out = []
    for a, b in zip(starts, starts[1:]):
        if b - a < 2:
            continue
        beat = (bars[b - 1][1] - bars[a][0]) / max(1, sum(q[2] for q in bars[a:b]))
        lags, c = syncqa.lag_curve(sync, s["tab_env"], s["env"], most=0.4 * beat, part=(bars[a][0], bars[b - 1][1]))
        out.append((a + 1, info["bars"][a][3] if len(info["bars"][a]) > 3 else "", round(1000 * float(lags[int(np.argmax(c))]))))
    return out


def one(name):
    s = qa.load(name)
    bars = s["bars"]
    fb = next(p for p in s["out"].glob("*.fretboard") if "(" not in p.stem)
    shared = json.loads(fb.read_text(encoding="utf-8"))
    current = Sync.from_points([b[0] for b in bars], shared["songs"][0]["syncPoints"])
    t, r = path(s)
    keyed, kept, dropped = key_points(s, t, r)
    print(f"\n== {name}: {len(kept)} key points" + (f", not used (tempo % off): {dropped}" if dropped else ""))
    res = {}
    for label, sync in (("current", current), ("key points", keyed)):
        pts = compare.points_of(sync, bars)
        v = qa.judge(s, points=pts)
        within, typical = compare.note_timing(s, sync)
        offs = sections_off(s, sync)
        bad = [f"{n or 'bar ' + str(a)} {o:+d}" for a, n, o in offs if abs(o) > 30]
        print(f"  {label:10} {v['verdict']:6} notes within 30 ms {within}%, typical {typical} ms, whole song {v.get('off_ms')} ms;"
              f" sections over 30 ms off: {', '.join(bad) or 'none'}")
        res[label] = {"verdict": v["verdict"], "within": within, "typical": typical, "sections": offs, "fails": v["fails"]}
        if label == "key points":
            out = copy.deepcopy(shared)
            e = out["songs"][0]
            e["title"] = f"{e['title']} (key points)"
            e["syncPoints"] = pts
            (s["out"] / f"{fb.stem} (key points).fretboard").write_text(json.dumps(out), encoding="utf-8")
    res["kept"] = [[p + 1, round(v, 3)] for p, v in kept]
    res["dropped"] = dropped
    (s["out"] / "anchors.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    return res


CSS = """:root{--bg:#f9f9f7;--card:#fcfcfb;--fg:#0b0b0b;--mute:#52514e;--grid:#e4e2dc;--band:#e9f3e9;--s1:#2a78d6;--s2:#eb6834}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d0d0d;--card:#1a1a19;--fg:#f0efec;--mute:#c3c2b7;--grid:#2e2e2b;--band:#1d2e1f;--s1:#3987e5;--s2:#d95926}}
:root[data-theme=dark]{--bg:#0d0d0d;--card:#1a1a19;--fg:#f0efec;--mute:#c3c2b7;--grid:#2e2e2b;--band:#1d2e1f;--s1:#3987e5;--s2:#d95926}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1000px}
h1{font-size:22px;margin:4px 0}h2{font-size:17px;margin:22px 0 2px}p{color:var(--mute);margin:4px 0 8px}
.card{background:var(--card);border:1px solid var(--grid);border-radius:8px;padding:10px 12px;margin:10px 0}
.key span{display:inline-block;width:16px;height:3px;border-radius:2px;vertical-align:middle;margin:0 5px 0 12px}
svg{width:100%;height:auto;display:block}.ax{font-size:11px;fill:var(--mute)}.grid{stroke:var(--grid)}.band{fill:var(--band)}
.l{fill:none;stroke-width:2}.m{stroke:var(--card);stroke-width:2}
table{border-collapse:collapse;font-size:13px;margin-top:6px}td,th{padding:2px 10px 2px 0;text-align:left;font-variant-numeric:tabular-nums}
summary{cursor:pointer;color:var(--mute);font-size:13px}"""


def chart(cur, key):
    """Each section's offset (ms), current vs key points: 0 is where it lines up best, the band is 30 ms."""
    W, H, L, T, B = 940, 220, 44, 10, 34
    lim = 250
    n = len(cur)
    xs = lambda i: L + (W - L - 10) * (i + 0.5) / n
    ys = lambda v: T + (H - T - B) * (lim - max(-lim, min(lim, v))) / (2 * lim)
    g = [f'<rect class="band" x="{L}" y="{ys(30):.1f}" width="{W - L - 10}" height="{ys(-30) - ys(30):.1f}"/>']
    for v in (-200, -100, 0, 100, 200):
        g.append(f'<line class="grid" x1="{L}" x2="{W - 10}" y1="{ys(v):.1f}" y2="{ys(v):.1f}"/><text class="ax" x="{L - 6}" y="{ys(v) + 4:.1f}" text-anchor="end">{v:+d}</text>')
    for i, (bar, name, _) in enumerate(cur):
        g.append(f'<text class="ax" x="{xs(i):.1f}" y="{H - B + 14}" text-anchor="middle">{bar}</text>')
        if name:
            g.append(f'<text class="ax" x="{xs(i):.1f}" y="{H - B + 27}" text-anchor="middle">{name[:9]}</text>')
    for rows, col, label in ((cur, "--s1", "current"), (key, "--s2", "key points")):
        d = " ".join(f"{'M' if i == 0 else 'L'}{xs(i):.1f},{ys(o):.1f}" for i, (_, _, o) in enumerate(rows))
        g.append(f'<path class="l" style="stroke:var({col})" d="{d}"/>')
        for i, (bar, name, o) in enumerate(rows):
            g.append(f'<circle class="m" style="fill:var({col})" cx="{xs(i):.1f}" cy="{ys(o):.1f}" r="4.5"><title>{label}, {name or "bar " + str(bar)} (bar {bar}): {o:+d} ms</title></circle>')
    return f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="ms off per section">{"".join(g)}</svg>'


def page(names):
    import songdb
    db = songdb.load()
    parts = []
    for n in names:
        song = next((x for x in db["songs"] if x["name"] == n), None) or songdb.find_one(db, n)
        f = qa.listen.OUT / run.slug(song["name"]) / "anchors.json"
        if not f.exists():
            continue
        r = json.loads(f.read_text(encoding="utf-8"))
        c, k = r["current"], r["key points"]
        rows = "".join(f"<tr><td>{a}</td><td>{nm}</td><td>{o1:+d}</td><td>{o2:+d}</td></tr>"
                       for (a, nm, o1), (_, _, o2) in zip(c["sections"], k["sections"]))
        parts.append(f'<h2>{n}</h2><p>Notes heard within 30 ms: current <b>{c["within"]}%</b> ({c["verdict"]}), key points <b>{k["within"]}%</b> ({k["verdict"]})'
                     f'{"; sections whose tempo didn&#39;t fit, so not used as key points: " + ", ".join(str(d[0]) for d in r["dropped"]) if r["dropped"] else ""}</p>'
                     f'<div class="card">{chart(c["sections"], k["sections"])}<details><summary>Table</summary><table><tr><th>Bar</th><th>Section</th><th>Current (ms)</th><th>Key points (ms)</th></tr>{rows}</table></details></div>')
    html = (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Key points vs current</title><style>{CSS}</style></head><body><h1>Key points (synctoolbox) vs the current sync</h1>'
            f'<p>Each dot is one section of the tab: how far it is from where it lines up best with the recording. 0 is right on; the green band is within 30 ms. Hover a dot for its number.</p>'
            f'<p class="key"><span style="background:var(--s1)"></span>current (one steady tempo)<span style="background:var(--s2)"></span>key points (synctoolbox at each section start, steady between)</p>'
            f'{"".join(parts)}</body></html>')
    out = qa.listen.OUT.parent / "anchors.html"
    out.write_text(html, encoding="utf-8")
    return out


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
    names = qa.ready() if a[0] == "--all" else a
    for n in names:
        one(n)
    print(page(names))


if __name__ == "__main__":
    main()
