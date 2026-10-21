"""Leave this running while you browse Ultimate Guitar. It opens the collector's Chrome window
(its own profile, so log in to UG Pro there once). Every time you open an official (Pro) song
in it, a small window asks whether to save that song's instrument and vocal PDFs into
Downloads\\UG Songs\\<Song> - <Artist> (Key X), one song at a time, using ug_collect.py.

Songs already collected are remembered (Downloads\\UG Songs\\collected.txt) and not asked
again. A song you Skip or Cancel isn't asked again while its tab stays open.

  python tools/ug_watch.py            (Ctrl+C to stop)
"""
import argparse, json, subprocess, sys, time, urllib.request
from pathlib import Path

COLLECT = Path(__file__).with_name("ug_collect.py")
CHROME = [Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
          Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
          Path.home() / r"AppData\Local\Google\Chrome\Application\chrome.exe"]
DONE, FAILED, SKIPPED, CANCELLED = 0, 1, 2, 3


def official_tabs(port):
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/json/list", timeout=5) as r:
            ts = json.load(r)
    except OSError:
        return None
    return [t["url"].split("?")[0].split("#")[0] for t in ts
            if t["type"] == "page" and "tabs.ultimate-guitar.com/tab/" in t["url"] and "-official-" in t["url"]]


def start_chrome(port, profile):
    exe = next((c for c in CHROME if c.exists()), None)
    if not exe:
        return False
    subprocess.Popen([str(exe), f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
                      "https://www.ultimate-guitar.com/"], close_fds=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--settle", type=float, default=8, help="seconds a song must stay open before asking")
    ap.add_argument("--root", default=str(Path.home() / "Downloads" / "UG Songs"), help="where the song folders go")
    ap.add_argument("--profile", default=r"C:\ug-chrome", help="the collector Chrome's own profile folder")
    ap.add_argument("--no-ui", action="store_true", help="no windows: save every track without asking")
    a = ap.parse_args()
    DONE_FILE = Path(a.root) / "collected.txt"
    DONE_FILE.parent.mkdir(parents=True, exist_ok=True)
    done = set(DONE_FILE.read_text(encoding="utf-8").split()) if DONE_FILE.exists() else set()
    seen = {}  # url -> first time it was seen open
    passed = set()  # skipped or cancelled: not asked again while the tab stays open
    print("Watching the collector Chrome. Open any official UG song there and a window asks to save its PDFs.\n"
          f"They go into {a.root}. Ctrl+C here to stop.\n")
    started = warned = False
    while True:
        urls = official_tabs(a.port)
        if urls is None:
            if not started:
                started = True
                if start_chrome(a.port, a.profile):
                    print("Opened the collector Chrome. Log in to UG Pro there (once), then open an official song.")
                    time.sleep(5)
                    continue
            if not warned:
                print("Can't reach Chrome on port %d. Close every window of that Chrome and run this again, or start it with:\n"
                      '  & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=%d --user-data-dir="%s"'
                      % (a.port, a.port, a.profile))
                warned = True
            time.sleep(5)
            continue
        warned = False
        now = time.time()
        seen = {u: seen.get(u, now) for u in urls}
        passed &= set(urls)  # a song closed and opened again is asked again
        for u in urls:
            if u in done or u in passed or now - seen[u] < a.settle:
                continue
            print(f"\n=== {u}")
            cmd = [sys.executable, "-u", str(COLLECT), u, "--port", str(a.port), "--root", a.root] + (["--no-ui"] if a.no_ui else [])
            code = subprocess.run(cmd).returncode
            if code == DONE:
                done.add(u)
                with DONE_FILE.open("a", encoding="utf-8") as f:
                    f.write(u + "\n")
                print("Ready for the next song.")
            elif code in (SKIPPED, CANCELLED):
                passed.add(u)
                print("Skipped." if code == SKIPPED else "Cancelled; what it saved was removed.")
            else:
                print("That song didn't finish; it will be tried again in a minute while it stays open.")
                seen[u] = time.time() + 60
            break  # one song at a time; re-read the open tabs afterwards
        time.sleep(3)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
