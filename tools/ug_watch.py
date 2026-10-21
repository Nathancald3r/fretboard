"""Leave this running while you browse Ultimate Guitar in the debug Chrome. Every time you
open an official (Pro) song, it saves all of that song's instrument and vocal PDFs into
Downloads\\UG Songs\\<Song> - <Artist> (Key X), one song at a time, using ug_collect.py.

Songs already collected are remembered (Downloads\\UG Songs\\collected.txt) and skipped,
so opening a song again doesn't make duplicate copies. Delete its line there to redo it.

  python tools/ug_watch.py            (Ctrl+C to stop)
"""
import argparse, json, subprocess, sys, time, urllib.request
from pathlib import Path

COLLECT = Path(__file__).with_name("ug_collect.py")


def official_tabs(port):
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/json/list", timeout=5) as r:
            ts = json.load(r)
    except OSError:
        return None
    return [t["url"].split("?")[0].split("#")[0] for t in ts
            if t["type"] == "page" and "tabs.ultimate-guitar.com/tab/" in t["url"] and "-official-" in t["url"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--settle", type=float, default=8, help="seconds a song must stay open before collecting")
    ap.add_argument("--root", default=str(Path.home() / "Downloads" / "UG Songs"), help="where the song folders go")
    a = ap.parse_args()
    DONE = Path(a.root) / "collected.txt"
    DONE.parent.mkdir(parents=True, exist_ok=True)
    done = set(DONE.read_text(encoding="utf-8").split()) if DONE.exists() else set()
    seen = {}  # url -> first time it was seen open
    print("Watching the debug Chrome. Open any official UG song and its PDFs are saved by themselves.\n"
          "Keep hands off keyboard and mouse while a song is being saved. Ctrl+C to stop.\n")
    warned = False
    while True:
        urls = official_tabs(a.port)
        if urls is None:
            if not warned:
                print("Can't reach Chrome on port %d. Start it with the debug command; I'll keep waiting." % a.port)
                warned = True
            time.sleep(5)
            continue
        warned = False
        now = time.time()
        seen = {u: seen.get(u, now) for u in urls}
        for u in urls:
            if u in done or now - seen[u] < a.settle:
                continue
            print(f"\n=== {u}")
            r = subprocess.run([sys.executable, "-u", str(COLLECT), u, "--port", str(a.port), "--root", a.root])
            if r.returncode == 0:
                done.add(u)
                with DONE.open("a", encoding="utf-8") as f:
                    f.write(u + "\n")
                print("Ready for the next song.")
            else:
                print("That song didn't finish; it will be tried again while it stays open.")
                seen[u] = time.time() + 30  # wait a bit before retrying
            break  # one song at a time; re-read the open tabs afterwards
        time.sleep(3)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
