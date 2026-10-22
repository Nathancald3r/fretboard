"""Leave this running while you browse Ultimate Guitar. It opens the collector's Chrome window
(its own profile, so log in to UG Pro there once). Every time you open an official (Pro) song
in it, a small window asks whether to save that song's instrument and vocal PDFs into
Downloads\\UG Songs\\<Song> - <Artist> (Key X), one song at a time, using ug_collect.py.
Chords, plain tabs and Guitar Pro tabs are offered too (one file each, same song folder);
--official-only asks about official songs only.

It also answers Fretboard (http://127.0.0.1:9231, this computer only): Find tabs online opens
its Ultimate Guitar search in this Chrome, and an Official or Pro song you open is saved without
asking which tracks; Fretboard then adds its PDFs as one song by itself.

Songs already collected are remembered (Downloads\\UG Songs\\collected.txt) and not asked
again. A song you Skip or Cancel isn't asked again while its tab stays open.

  python tools/ug_watch.py            (Ctrl+C to stop)
"""
import argparse, json, subprocess, sys, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

COLLECT = Path(__file__).with_name("ug_collect.py")
CHROME = [Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
          Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
          Path.home() / r"AppData\Local\Google\Chrome\Application\chrome.exe"]
DONE, FAILED, SKIPPED, CANCELLED = 0, 1, 2, 3


def song_tabs(port, official_only=False):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as r:
            ts = json.load(r)
    except OSError:
        return None
    return [t["url"].split("?")[0].split("#")[0] for t in ts
            if t["type"] == "page" and "tabs.ultimate-guitar.com/tab/" in t["url"]
            and ("-official-" in t["url"] or not official_only)]


def start_chrome(port, profile, url="https://www.ultimate-guitar.com/"):
    exe = next((c for c in CHROME if c.exists()), None)
    if not exe:
        return False
    subprocess.Popen([str(exe), f"--remote-debugging-port={port}", f"--user-data-dir={profile}", url], close_fds=True)
    return True


# ---------- the helper Fretboard talks to ----------
HELPER_PORT = 9231
# Only Fretboard's own pages may ask (the site, and the local copy while it's being worked on).
ORIGINS = {"https://nathancald3r.github.io", "http://localhost:8420", "http://127.0.0.1:8420"}
state = {"busy": "", "chrome": False, "chrome_port": 9222, "profile": ""}  # set from the command line in main()


def is_ug(url):
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    return u.scheme == "https" and (host == "ultimate-guitar.com" or host.endswith(".ultimate-guitar.com"))


def open_in_chrome(url):
    """Opens url as a new tab of the collector Chrome (starting it if it isn't running)."""
    port = state["chrome_port"]
    if song_tabs(port) is None:
        return start_chrome(port, state["profile"], url)
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?{urllib.parse.quote(url, safe=':/?&=%')}", method="PUT")
        with urllib.request.urlopen(req, timeout=5) as r:
            tab = json.load(r)
        urllib.request.urlopen(f"http://127.0.0.1:{port}/json/activate/{tab['id']}", timeout=5).close()
        return True
    except (OSError, ValueError, KeyError):
        return False


class Helper(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body=None):
        origin = self.headers.get("Origin", "")
        self.send_response(code)
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        data = json.dumps(body).encode() if body is not None else b""
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in ORIGINS

    def do_OPTIONS(self):
        self._send(204 if self._allowed() else 403)

    def do_GET(self):
        if not self._allowed():
            return self._send(403, {"ok": False})
        if self.path.split("?")[0] == "/status":
            return self._send(200, {"ok": True, "app": "fretboard-ug-helper", "version": 1,
                                    "chrome": state["chrome"], "busy": state["busy"]})
        self._send(404, {"ok": False})

    def do_POST(self):
        if not self._allowed() or self.headers.get("Origin") is None:
            return self._send(403, {"ok": False})
        if self.path.split("?")[0] != "/open":
            return self._send(404, {"ok": False})
        try:
            n = min(int(self.headers.get("Content-Length") or 0), 8192)
            url = str(json.loads(self.rfile.read(n) or b"{}").get("url", ""))
        except (ValueError, AttributeError):
            return self._send(400, {"ok": False, "error": "bad request"})
        if not is_ug(url):
            return self._send(400, {"ok": False, "error": "only Ultimate Guitar pages"})
        ok = open_in_chrome(url)
        if ok:
            print(f"\nOpened from Fretboard: {url}")
        self._send(200 if ok else 502, {"ok": ok})


class HelperServer(ThreadingHTTPServer):
    allow_reuse_address = False  # on Windows reuse would let a second copy share the port
    daemon_threads = True


def start_helper():
    try:
        srv = HelperServer(("127.0.0.1", HELPER_PORT), Helper)
    except OSError:
        print(f"(Fretboard link off: port {HELPER_PORT} is in use, probably by another copy of this window.)")
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Fretboard link on: Find tabs online opens Ultimate Guitar here, and Official / Pro songs are added by themselves.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--settle", type=float, default=8, help="seconds a song must stay open before asking")
    ap.add_argument("--root", default=str(Path.home() / "Downloads" / "UG Songs"), help="where the song folders go")
    ap.add_argument("--profile", default=r"C:\ug-chrome", help="the collector Chrome's own profile folder")
    ap.add_argument("--no-ui", action="store_true", help="no windows: save every track without asking")
    ap.add_argument("--official-only", action="store_true", help="only official songs, not chords / tabs / Guitar Pro pages")
    a = ap.parse_args()
    state["chrome_port"], state["profile"] = a.port, a.profile
    start_helper()
    DONE_FILE = Path(a.root) / "collected.txt"
    DONE_FILE.parent.mkdir(parents=True, exist_ok=True)
    done = set(DONE_FILE.read_text(encoding="utf-8").split()) if DONE_FILE.exists() else set()
    seen = {}  # url -> first time it was seen open
    passed = set()  # skipped or cancelled: not asked again while the tab stays open
    print("Watching the collector Chrome. Open a UG song there and a window asks to save it (official songs: their\n"
          "PDFs; chords and tabs: the text; Guitar Pro tabs: their download).\n"
          f"They go into {a.root}. Ctrl+C here to stop.\n")
    started = warned = False
    while True:
        urls = song_tabs(a.port, a.official_only)
        state["chrome"] = urls is not None
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
            cmd = [sys.executable, "-u", str(COLLECT), u, "--port", str(a.port), "--root", a.root, "--auto-official"] + (["--no-ui"] if a.no_ui else [])
            state["busy"] = u
            try:
                code = subprocess.run(cmd).returncode
            finally:
                state["busy"] = ""
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
