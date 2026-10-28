"""Does every track of the tab play in the recording's key?  (the user, 2026-10-28: How Great Is Our God, "the guitar, vocal
and drums are on key, all the other instruments clash")

    python tests/yt2gp5/trackkey.py NAME            each pitched track's key against the recording, under the song's sync
    python tests/yt2gp5/trackkey.py NAME --fix      and give a track that is a clear number of semitones off the capo that puts it right
    python tests/yt2gp5/trackkey.py --all           every song in out/listen (never fixes)

Each Ultimate Guitar track carries its own capo (Trust In God: acoustic capo 6, piano none). How Great's Strings track was
written in G shapes with capo 0, where the guitars, vocal and piano have capo 6: it sounds a tritone away from the band. The
sync can't fix that and the whole-song match averages it away, so this compares each track on its own: the pitch classes it
plays (its notes, over the recording's time through the sync) against the recording's chroma at those moments, for each
rotation 0-11. A track is off when one rotation fits clearly (FIT_MIN) and clearly better than 0 (GAIN_MIN).

--fix writes the capo into the track's staff in the .gp (score.gpif), keeps the first file as <name>.gp.before-keys, and the
song has to be built again (listen.py NAME --export: the new .gp gets a new sha) so the .fretboard carries it.
"""
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import qa  # noqa: E402
import syncqa  # noqa: E402

FIT_MIN = 0.6    # the best rotation must correlate at least this well with the recording's chroma
GAIN_MIN = 0.4   # and this much better than rotation 0
MIN_NOTES = 20   # a track with fewer notes says nothing
NAMES = "C C# D D# E F F# G G# A A# B".split()


def profiles(s, notes):
    """For each pitched track: (the recording's chroma where the track plays, the track's pitch classes), both 12 long."""
    bars, ps = s["bars"], sorted(s["points"])
    sync = qa.Sync.from_points([b[0] for b in bars], ps)
    rec_c = s["rec_c"]
    frames = rec_c.shape[1]
    per = syncqa.C_HOP / syncqa.SR
    out = {}
    for t in s["info"]["tracks"]:
        if t.get("category") == "drums":
            continue
        mine = [n for n in notes if n["track"] == t["index"]]
        if len(mine) < MIN_NOTES:
            continue
        mask = np.zeros(frames, bool)
        tp = np.zeros(12)
        for n in mine:
            a, b = (int(float(sync(x)) / per) for x in (n["start"], n["end"]))
            mask[max(0, a):max(0, min(frames, b))] = True
            tp[n["pitch"] % 12] += n["end"] - n["start"]
        if mask.sum() < 50 or tp.sum() <= 0:
            continue
        out[t["index"]] = (t["name"], rec_c[:, mask].mean(axis=1), tp / tp.sum())
    return out


def fit(rec_profile, track_profile):
    """Correlation of the recording's chroma with the track's pitch classes moved up by r semitones, r = 0..11."""
    a = (rec_profile - rec_profile.mean()) / (rec_profile.std() + 1e-9)
    sc = []
    for r in range(12):
        b = np.roll(track_profile, r)
        b = (b - b.mean()) / (b.std() + 1e-9)
        sc.append(float(np.mean(a * b)))
    return sc


def check(name):
    s = qa.load(name)
    notes = json.loads((s["out"] / "notes.json").read_text(encoding="utf-8"))["notes"]
    rows = []
    for idx, (tname, rp, tp) in profiles(s, notes).items():
        sc = fit(rp, tp)
        r = int(np.argmax(sc))
        off = r != 0 and sc[r] >= FIT_MIN and sc[r] - sc[0] >= GAIN_MIN
        rows.append({"index": idx, "name": tname, "at0": sc[0], "best": r, "fit": sc[r], "off": off})
    return s, rows


def show(name, rows):
    bad = [r for r in rows if r["off"]]
    print(f"{'KEY' if bad else 'ok '}  {name}")
    for r in rows:
        mark = f"  <- {r['best']} semitones up fits ({r['fit']:+.2f}, as written {r['at0']:+.2f})" if r["off"] else ""
        print(f"        {r['index']} {r['name']:16} as written {r['at0']:+.2f}{mark}")


def patch_gp(path, fixes):
    """Add `fixes` {track index: semitones} to those tracks' capo in the .gp (GP7: score.gpif). Returns the capos written."""
    path = Path(path)
    backup = path.with_name(path.name + ".before-keys")
    if not backup.exists():
        backup.write_bytes(path.read_bytes())
    zin = zipfile.ZipFile(io.BytesIO(path.read_bytes()))
    xml = zin.read("Content/score.gpif").decode("utf-8")
    done, order = {}, [0]

    def track(m):
        i = order[0]
        order[0] += 1
        if i not in fixes:
            return m.group(0)
        body, hit = re.subn(r'(<Property name="CapoFret">\s*<Fret>)(\d+)(</Fret>)',
                            lambda c: f"{c.group(1)}{int(c.group(2)) + fixes[i]}{c.group(3)}", m.group(0), count=1)
        if not hit:
            raise SystemExit(f"track {i} has no capo property to change")
        done[i] = int(re.search(r'<Property name="CapoFret">\s*<Fret>(\d+)', body).group(1))
        return body

    xml = re.sub(r"<Track id=\"\d+\">.*?</Track>", track, xml, flags=re.S)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = xml.encode("utf-8") if item.filename == "Content/score.gpif" else zin.read(item.filename)
            zout.writestr(item, data)
    path.write_bytes(out.getvalue())
    return done


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
    names = qa.ready() if a[0] == "--all" else a[:1]
    for name in names:
        s, rows = check(name)
        show(s["song"]["name"], rows)
        if "--fix" in a and a[0] != "--all":
            fixes = {r["index"]: r["best"] for r in rows if r["off"]}
            if not fixes:
                print("nothing to fix")
                continue
            done = patch_gp(s["song"]["gp"], fixes)
            print(f"capo written in {s['song']['gp']}: " + ", ".join(f"track {i} now capo {c}" for i, c in done.items()))
            print(f"build it again so the .fretboard carries it:  python tests/yt2gp5/listen.py \"{s['song']['name']}\" --export")


if __name__ == "__main__":
    main()
