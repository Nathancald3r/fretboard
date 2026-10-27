"""The sync ladder: get simple songs syncing right first, then harder ones.

    python tests/yt2gp5/ladder.py            every song in ladder.json, in order (fromlink.py each, one at a time)
    python tests/yt2gp5/ladder.py -k NAME    one song
    python tests/yt2gp5/ladder.py --table    only print the table from the last results
    python tests/yt2gp5/ladder.py --tracks guitar   redo only the line-up of the songs already made, on these
                                                    tracks of the tab and the same parts of the recording
                                                    (guitar; guitar,bass; guitar,bass,drums; all)

Each song: UG Official tab + the video in ladder.json → fromlink.py (saved, made, lined up, QA gate).
Each --tracks stage keeps its own results (out/ladder/results-<tracks>.json).
Writes out/ladder.md: song, length, tracks kept, gate verdict, tempo, notes within 30 ms, why it failed.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VENV = Path.home() / ".fretboard" / "yt2gp5-venv" / "Scripts" / "python.exe"
LIST = HERE / "ladder.json"
OUT = HERE / "out" / "ladder.md"
LOGS = HERE / "out" / "ladder"


# the line-up again on the song already made (FB_SYNC_TRACKS picks the tracks), then the gate
RESYNC = """import sys, json; sys.path.insert(0, sys.argv[1]); import songdb, syncqa, qa, listen, run
song = songdb.find_one(songdb.load(), sys.argv[2]); syncqa.improve(song)
v = qa.judge(qa.load(song['name'])); (listen.OUT / run.slug(song['name']) / 'qa.json').write_text(json.dumps(v, indent=1), encoding='utf-8')
qa.show(song['name'], v); sys.exit({'PASS': 0, 'LISTEN': 2, 'FAIL': 3}[v['verdict']])"""


def find(s):
    sys.path.insert(0, str(HERE))
    import songdb
    key = lambda x: "".join(c for c in x.lower() if c.isalnum())
    return next((x for x in songdb.load()["songs"] if x.get("official") and key(x.get("title", "")) == key(s["title"])
                 and x.get("youtube", "").endswith(s["link"].split("v=")[-1])), None)


def made(s):
    song = find(s)
    return song["name"] if song else None


def row(s, code, secs):
    import run
    song = find(s)
    r = {"song": f"{s['artist']} - {s['title']}", "verdict": {0: "PASS", 2: "LISTEN", 3: "FAIL"}.get(code, "ERROR"), "took_s": round(secs)}
    if song:
        out = HERE / "out" / "listen" / run.slug(song["name"])
        qa = json.loads((out / "qa.json").read_text(encoding="utf-8")) if (out / "qa.json").exists() else {}
        sj = json.loads((out / "sync.json").read_text(encoding="utf-8")) if (out / "sync.json").exists() else {}
        now = sj.get("now", {})
        info = json.loads((out / "info.json").read_text(encoding="utf-8")) if (out / "info.json").exists() else {}
        r.update(video_s=(song.get("video") or {}).get("seconds"), tab_s=song.get("seconds"),
                 tracks=len(info.get("tracks", [])), notes30=now.get("notes_within_30ms"),
                 off_ms=now.get("whole_song_off_ms"), why="; ".join(qa.get("fails", []) + qa.get("listen", []))[:300])
    return r


def table(rows):
    lines = ["| # | Song | Video / tab | Tracks | Gate | Notes ≤30 ms | Whole song off | Why |", "|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(rows, 1):
        mmss = lambda s: f"{s // 60}:{s % 60:02d}" if s else "?"
        lines.append(f"| {i} | {r['song']} | {mmss(r.get('video_s'))} / {mmss(r.get('tab_s'))} | {r.get('tracks', '?')} | {r['verdict']} | "
                     f"{r.get('notes30', '?')}% | {r.get('off_ms', '?')} ms | {r.get('why', '')} |")
    return "\n".join(lines)


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    songs = json.loads(LIST.read_text(encoding="utf-8"))["songs"]
    stage = a[a.index("--tracks") + 1] if "--tracks" in a else None
    res_file = LOGS / (f"results-{stage.replace(',', '+')}.json" if stage else "results.json")
    LOGS.mkdir(parents=True, exist_ok=True)
    old = json.loads(res_file.read_text(encoding="utf-8")) if res_file.exists() else {}
    if "--table" in a:
        print(table([old[s["title"]] for s in songs if s["title"] in old]))
        return
    only = a[a.index("-k") + 1].lower() if "-k" in a else None
    for s in songs:
        if only and only not in s["title"].lower():
            continue
        print(f"\n=== {s['artist']} - {s['title']}", flush=True)
        t = time.time()
        env = {**__import__("os").environ, "PYTHONUNBUFFERED": "1"}
        if stage:
            name = made(s)
            if not name:
                print("  not made yet: run ladder.py without --tracks first")
                continue
            env["FB_SYNC_TRACKS"] = stage
            cmd = [str(VENV), "-c", RESYNC, str(HERE), name]
        else:
            cmd = [str(VENV), str(HERE / "fromlink.py"), s["link"], "--title", s["title"], "--artist", s["artist"]]
        with open(LOGS / f"{s['title']}{'-' + stage.replace(',', '+') if stage else ''}.log", "w", encoding="utf-8") as log:
            code = subprocess.run(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env).returncode
        try:
            r = row(s, code, time.time() - t)
        except Exception as e:  # noqa: BLE001
            r = {"song": f"{s['artist']} - {s['title']}", "verdict": "ERROR", "why": str(e)}
        if r["verdict"] == "ERROR":
            r["why"] = r.get("why") or (LOGS / f"{s['title']}.log").read_text(encoding="utf-8", errors="replace").strip().splitlines()[-1][:300]
        old[s["title"]] = r
        res_file.write_text(json.dumps(old, indent=1), encoding="utf-8")
        print(f"  {r['verdict']}  notes≤30ms {r.get('notes30')}%  {r.get('why', '')}", flush=True)
    rows = [old[s["title"]] for s in songs if s["title"] in old]
    OUT.write_text("# Sync ladder\n\n" + table(rows) + "\n", encoding="utf-8")
    print("\n" + table(rows))
    print(f"\n{sum(r['verdict'] == 'PASS' for r in rows)} PASS of {len(rows)}; table: {OUT}")


if __name__ == "__main__":
    main()
