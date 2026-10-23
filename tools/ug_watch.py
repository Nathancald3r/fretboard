"""Leave this running while you browse Ultimate Guitar. It opens the collector's Chrome window
(its own profile, so log in to UG Pro there once). Every time you open an official (Pro) song
in it, a small window asks whether to save that song's instrument and vocal PDFs into
Downloads\\UG Songs\\<Song> - <Artist> (Key X), one song at a time, using ug_collect.py.
Chords, plain tabs and Guitar Pro tabs are offered too (one file each, same song folder);
--official-only asks about official songs only.

It also answers Fretboard (http://127.0.0.1:9231, this computer only): Find tabs online opens
its Ultimate Guitar search in this Chrome, and an Official or Pro song you open is saved without
asking which tracks; Fretboard then adds its PDFs as one song by itself.

The collector Chrome works out of sight (moved off the screen, where it keeps drawing at full
speed), so it never jumps in front of what you're doing. Click it in the taskbar, or Show UG
window in Fretboard or the collector, and it comes up maximized. A search from Fretboard brings
the results up in front: pick the song, and it's saved the right way for its kind (official: every
track's PDF and its chords; Pro / Guitar Pro: the file and the song's chords; chords: the text)
and added to Fretboard, without asking.

Songs already collected are remembered (Downloads\\UG Songs\\collected.txt) and not asked
again. A song you Skip or Cancel isn't asked again while its tab stays open.

It runs out of sight: started from a console it starts itself again without one and that console
closes (what it prints goes to helper.log beside it). Fretboard's Stop button ends it, and it ends
by itself a minute after you close its Chrome while nothing is being saved.

  python tools/ug_watch.py            (in the background)
  python tools/ug_watch.py --visible  (in this console, Ctrl+C to stop)
"""
import argparse, json, os, subprocess, sys, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

COLLECT = Path(__file__).with_name("ug_collect.py")
LOG = Path(__file__).with_name("helper.log")
CHROME = [Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
          Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
          Path.home() / r"AppData\Local\Google\Chrome\Application\chrome.exe"]
DONE, FAILED, SKIPPED, CANCELLED = 0, 1, 2, 3


def song_tabs(port, official_only=False):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as r:
            ts = json.load(r)
    except (OSError, ValueError):  # Chrome closed, or mid-change
        return None
    return [t["url"].split("?")[0].split("#")[0] for t in ts
            if t["type"] == "page" and "tabs.ultimate-guitar.com/tab/" in t["url"]
            and ("-official-" in t["url"] or not official_only)]


# ---------- the collector Chrome's window: out of sight while it works ----------
# Minimized windows draw about once a second and can't be captured reliably, so "out of sight" is
# off the screen instead; these flags keep Chrome drawing at full speed there.
CHROME_FLAGS = ["--start-maximized", "--no-first-run", "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding", "--disable-background-timer-throttling"]
OFF_LEFT = -20000


def _win32():
    import ctypes
    from ctypes import wintypes

    class Placement(ctypes.Structure):
        _fields_ = [("length", ctypes.c_uint), ("flags", ctypes.c_uint), ("showCmd", ctypes.c_uint),
                    ("ptMin", wintypes.POINT), ("ptMax", wintypes.POINT), ("rc", wintypes.RECT)]
    return ctypes, wintypes, ctypes.windll.user32, Placement


def offscreen_windows(iconic=None):
    """The collector Chrome's windows that are parked off the screen (no other window is out there)."""
    try:
        ctypes, wintypes, u32, Placement = _win32()
    except (ImportError, AttributeError, OSError):
        return []
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(h, _):
        cls = ctypes.create_unicode_buffer(64)
        u32.GetClassNameW(h, cls, 64)
        if cls.value == "Chrome_WidgetWin_1" and u32.IsWindowVisible(h):
            wp = Placement()
            wp.length = ctypes.sizeof(Placement)
            if u32.GetWindowPlacement(h, ctypes.byref(wp)) and wp.rc.left < OFF_LEFT // 2 \
                    and (iconic is None or bool(u32.IsIconic(h)) == iconic):
                found.append(h)
        return True
    u32.EnumWindows(each, 0)
    return found


def hide_window(cdp):
    """Parks the window of this CDP session's tab off the screen without taking the focus from
    what you're using. True when it's out of sight."""
    w = cdp.send("Browser.getWindowForTarget")["windowId"]
    # parked already or not, it's parked again: bringing a tab to the front may have given it the focus
    cdp.send("Browser.setWindowBounds", {"windowId": w, "bounds": {"windowState": "normal"}})
    cdp.send("Browser.setWindowBounds", {"windowId": w, "bounds": {"left": OFF_LEFT, "top": 0, "width": 1500, "height": 1000}})
    # minimizing hands the focus back to the window you were using; then it's restored, still off
    # the screen, without taking the focus
    cdp.send("Browser.setWindowBounds", {"windowId": w, "bounds": {"windowState": "minimized"}})
    hs = settle(lambda: offscreen_windows(iconic=True), 0.6)
    if hs:
        _, _, u32, _ = _win32()
        for h in hs:
            u32.ShowWindow(h, 4)  # SW_SHOWNOACTIVATE
    else:
        cdp.send("Browser.setWindowBounds", {"windowId": w, "bounds": {"windowState": "normal"}})
    settle(lambda: offscreen_windows(iconic=False), 0.4)
    return True


def settle(check, most):
    """check() as soon as it's true (polled), or its last answer after most seconds."""
    end = time.time() + most
    while True:
        got = check()
        if got or time.time() >= end:
            return got
        time.sleep(0.03)


def show_window(activate=True):
    """Brings the parked window back onto the screen, maximized. False when none was parked."""
    hs = offscreen_windows()
    if not hs:
        return False
    try:
        ctypes, _, u32, _ = _win32()
        k32 = ctypes.windll.kernel32
        for h in hs:
            if u32.IsIconic(h):
                u32.ShowWindow(h, 4 if not activate else 9)  # restore
            # back on the screen first, so un-maximizing it later doesn't send it away again
            u32.SetWindowPos(h, 0, 80, 40, 1400, 900, 0x0004 | (0x0010 if not activate else 0))  # NOZORDER (|NOACTIVATE)
            u32.ShowWindow(h, 3 if activate else 4)  # SW_MAXIMIZE / SW_SHOWNOACTIVATE
            if activate:  # Windows only lets the window you're using hand the focus over
                fg = u32.GetForegroundWindow()
                them, me = u32.GetWindowThreadProcessId(fg, None), k32.GetCurrentThreadId()
                joined = them and them != me and u32.AttachThreadInput(me, them, True)
                u32.BringWindowToTop(h)
                u32.SetForegroundWindow(h)
                if joined:
                    u32.AttachThreadInput(me, them, False)
        return True
    except (AttributeError, OSError):
        return False


def watch_taskbar():
    """Clicked in the taskbar while it's parked: it comes up maximized."""
    last = None
    while True:
        try:
            _, _, u32, _ = _win32()
            h = u32.GetForegroundWindow()
            h = h if h and h in offscreen_windows(iconic=False) else None
            if h and h == last:  # twice in a row: not just the moment it's being parked
                show_window()
                h = None
            last = h
        except Exception:
            pass
        time.sleep(0.4)


def start_chrome(port, profile, url="https://www.ultimate-guitar.com/", hidden=True):
    exe = next((c for c in CHROME if c.exists()), None)
    if not exe:
        return False
    if time.time() - state.get("launched", 0) < 40:
        return True  # it's starting already: a second start would open another window
    state["launched"] = time.time()
    subprocess.Popen([str(exe), f"--remote-debugging-port={port}", f"--user-data-dir={profile}", *CHROME_FLAGS, url], close_fds=True)
    if hidden:
        threading.Thread(target=_hide_when_up, args=(port,), daemon=True).start()
    return True


def _connect(port):
    from playwright.sync_api import sync_playwright
    for _ in range(80):  # Chrome may still be starting
        if song_tabs(port) is not None:
            break
        time.sleep(0.5)
    return sync_playwright()


def _hide_when_up(port):
    try:
        with _connect(port) as p:
            ctx = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=15000).contexts[0]
            for _ in range(20):
                if ctx.pages:
                    break
                time.sleep(0.5)
            time.sleep(1)
            for pg in ctx.pages:  # a page in a normal window (not chrome:// pages of their own)
                try:
                    return hide_window(ctx.new_cdp_session(pg))
                except Exception:
                    continue
    except Exception as e:
        print(f"(Couldn't move the Chrome window out of sight: {str(e).splitlines()[0][:100]})")


# A note across the top of the search results (only in this window, nothing is sent anywhere):
# what to do next, and what happens for each kind of version.
GUIDE_JS = r"""() => {
  if (document.getElementById('fretboard-guide')) return;
  const d = document.createElement('div');
  d.id = 'fretboard-guide';
  d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#f6a935;color:#1a1206;' +
    'font:15px/1.4 system-ui,Segoe UI,sans-serif;padding:12px 48px 12px 18px;box-shadow:0 -4px 18px #0006';
  d.innerHTML = '<div style="font-size:20px;font-weight:800;margin-bottom:4px">Fretboard: now click the song you want in the list above ↑</div>' +
    '<div>Pick one version. Fretboard saves it and adds it to your library by itself:</div>' +
    '<div style="margin-top:4px"><b>Official</b>: every instrument as a PDF, plus the chords. &nbsp;·&nbsp; ' +
    '<b>Tab Pro / Guitar Pro</b>: its Download (gp) file, plus the chords. &nbsp;·&nbsp; <b>Chords / Tab</b>: the text.</div>' +
    '<div style="margin-top:4px;opacity:.8">Keep this window open until the little Fretboard window says it’s done.</div>';
  const x = document.createElement('button');
  x.textContent = '×';
  x.title = 'Hide this note';
  x.style.cssText = 'position:absolute;top:8px;right:12px;border:0;background:transparent;font-size:26px;cursor:pointer;color:#1a1206';
  x.onclick = () => d.remove();
  d.append(x);
  document.body.append(d);
}"""


def open_tab(url):
    """Opens url in the collector Chrome; a search shows its results up front so you pick the song."""
    port = state["chrome_port"]
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get("value", [""])[0]
    try:
        with _connect(port) as p:
            br = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=15000)
            ctx = br.contexts[0]
            with ctx.expect_page(timeout=15000) as new:  # a background tab: the window stays where it is
                br.new_browser_cdp_session().send("Target.createTarget", {"url": "about:blank", "background": True})
            pg = new.value
            state["asked"][url.split("?")[0]] = time.time()  # opened from Fretboard: wanted, even if saved before
            pg.goto(url, wait_until="domcontentloaded", timeout=30000)
            if "/search.php" not in url or not q:
                return
            # you pick the song: the results come up in front, and the song you open is saved the
            # right way for its kind (official: every track; Pro / Guitar Pro: the file; chords: the text)
            state["picking"] = time.time()
            try:
                pg.evaluate(GUIDE_JS)
            except Exception:
                pass  # the guide only helps; the results work without it
            try:  # the window you searched from (Fretboard): where you go back to once you've picked
                _, _, u32, _ = _win32()
                state["back_to"] = u32.GetForegroundWindow()
            except Exception:
                state["back_to"] = 0
            pg.bring_to_front()
            show_window()
            print("Pick the song in the UG window: it's saved and added to Fretboard by itself.")
    except Exception as e:
        print(f"(Opening that page: {str(e).splitlines()[0][:100]})")


# ---------- the helper Fretboard talks to ----------
HELPER_PORT = int(os.environ.get("FB_HELPER_PORT") or 9231)  # another port only for tests
# What Fretboard's UG helper line set, kept beside the helper: {"notation": true} also saves each
# fretted track's pages with the music staff (dynamics, words), a slower save
SETTINGS = Path(__file__).with_name("settings.json")


def settings():
    try:
        s = json.loads(SETTINGS.read_text(encoding="utf-8"))
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}
# Only Fretboard's own pages may ask (the site, and the local copy while it's being worked on).
ORIGINS = {"https://nathancald3r.github.io"} | {f"http://{h}:{p}" for h in ("localhost", "127.0.0.1") for p in (8420, 8421)}
state = {"busy": "", "wait": "", "chrome": False, "chrome_port": 9222, "profile": "", "launched": 0, "asked": {}, "picking": 0}  # set from the command line in main()


def is_ug(url):
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    return u.scheme == "https" and (host == "ultimate-guitar.com" or host.endswith(".ultimate-guitar.com"))


def back_to_app(port):
    """You picked a song: its Chrome goes out of sight again and you're back in Fretboard, while it saves."""
    back, state["back_to"] = state.get("back_to"), 0
    try:
        with _connect(port) as p:
            ctx = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=15000).contexts[0]
            hide_window(ctx.new_cdp_session(ctx.pages[-1]))
        _, _, u32, _ = _win32()
        if back and u32.IsWindow(back):
            from ug_collect import focus_window
            focus_window(back)
    except Exception as e:
        print(f"(Couldn't go back to Fretboard by itself: {str(e).splitlines()[0][:100]})")


def open_in_chrome(url):
    """Opens url in the collector Chrome, out of sight (starting it if it isn't running)."""
    port = state["chrome_port"]
    if song_tabs(port) is None and not start_chrome(port, state["profile"]):
        return False
    threading.Thread(target=open_tab, args=(url,), daemon=True).start()
    return True


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
            return self._send(200, {"ok": True, "app": "fretboard-ug-helper", "version": 4,
                                    "chrome": state["chrome"], "busy": state["busy"], "wait": state["wait"], "notation": bool(settings().get("notation"))})
        self._send(404, {"ok": False})

    def do_POST(self):
        if not self._allowed():
            return self._send(403, {"ok": False})
        if self.path.split("?")[0] == "/show":  # the collector window asks too (no Origin: not a web page)
            ok = show_window()
            return self._send(200, {"ok": ok})
        if self.path.split("?")[0] == "/wait":  # the collector: what it waits on (UG's player not loading), for Fretboard
            if self.headers.get("Origin") is not None:
                return self._send(403, {"ok": False})
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 8192)
                state["wait"] = str(json.loads(self.rfile.read(n) or b"{}").get("text") or "")[:500]
            except (ValueError, AttributeError):
                return self._send(400, {"ok": False})
            return self._send(200, {"ok": True})
        if self.headers.get("Origin") is None:
            return self._send(403, {"ok": False})
        if self.path.split("?")[0] == "/quit":  # Fretboard's Stop: its Chrome closes too (it opened it)
            if state["busy"]:  # not in the middle of a song: Cancel it in its window, or let it finish
                return self._send(200, {"ok": False, "busy": True})
            self._send(200, {"ok": True})
            threading.Thread(target=quit_helper, daemon=True).start()
            return
        if self.path.split("?")[0] == "/settings":
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 8192)
                got = json.loads(self.rfile.read(n) or b"{}")
                s = settings()
                if "notation" in got:
                    s["notation"] = bool(got["notation"])
                SETTINGS.write_text(json.dumps(s), encoding="utf-8")
            except (ValueError, AttributeError, OSError):
                return self._send(400, {"ok": False})
            return self._send(200, {"ok": True, "notation": bool(s.get("notation"))})
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


def close_chrome(port):
    try:
        from ug_collect import Cdp
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3) as r:
            ws = json.load(r)["webSocketDebuggerUrl"]
        with Cdp(ws, timeout=5) as b:
            b.send("Browser.close")
    except Exception:
        pass  # closed already


def quit_helper():
    """Stop from Fretboard (never while a song is being saved): its Chrome closes, then the helper ends."""
    print("Stopped from Fretboard.")
    close_chrome(state["chrome_port"])
    time.sleep(0.3)
    os._exit(0)


def helper_running():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{HELPER_PORT}/status", timeout=1.5) as r:
            return json.load(r).get("app") == "fretboard-ug-helper"
    except (OSError, ValueError):
        return False


def to_background():
    """Starts this helper again without a console window (what it prints goes to helper.log); this one ends."""
    if helper_running():
        print("The UG helper is already running.")
        return
    log = LOG.open("w", encoding="utf-8")
    subprocess.Popen([sys.executable, "-u", str(Path(__file__).resolve()), *sys.argv[1:], "--hidden"],
                     cwd=str(Path(__file__).parent), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                     env={**os.environ, "PYTHONIOENCODING": "utf-8"}, creationflags=0x08000000)  # CREATE_NO_WINDOW
    print("The UG helper is running in the background. Stop it from Fretboard (Find tabs online).")


def start_helper():
    try:
        srv = HelperServer(("127.0.0.1", HELPER_PORT), Helper)
    except OSError:
        return False  # another copy of the helper is running
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=watch_taskbar, daemon=True).start()
    print(f"Fretboard link on: Find tabs online opens Ultimate Guitar here, and Official / Pro songs are added by themselves.")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--settle", type=float, default=8, help="seconds a song must stay open before asking")
    ap.add_argument("--root", default=str(Path.home() / "Downloads" / "UG Songs"), help="where the song folders go")
    ap.add_argument("--profile", default=r"C:\ug-chrome", help="the collector Chrome's own profile folder")
    ap.add_argument("--no-ui", action="store_true", help="no windows: save every track without asking")
    ap.add_argument("--official-only", action="store_true", help="only official songs, not chords / tabs / Guitar Pro pages")
    ap.add_argument("--visible", action="store_true", help="run in this console instead of in the background")
    ap.add_argument("--hidden", action="store_true", help=argparse.SUPPRESS)  # the background copy
    a = ap.parse_args()
    if os.name == "nt" and not (a.visible or a.hidden):
        return to_background()
    state["chrome_port"], state["profile"] = a.port, a.profile
    if not start_helper():
        print("The UG helper is already running. This one closes in a few seconds.")
        if not a.hidden:
            time.sleep(4)
        return
    DONE_FILE = Path(a.root) / "collected.txt"
    DONE_FILE.parent.mkdir(parents=True, exist_ok=True)
    done = set(DONE_FILE.read_text(encoding="utf-8").split()) if DONE_FILE.exists() else set()
    seen = {}  # url -> first time it was seen open
    passed = set()  # skipped or cancelled: not asked again while the tab stays open
    print("Watching the collector Chrome. Open a UG song there and a window asks to save it (official songs: their\n"
          "PDFs; chords and tabs: the text; Guitar Pro tabs: their download).\n"
          f"They go into {a.root}. " + ("Stop it from Fretboard.\n" if a.hidden else "Ctrl+C here to stop.\n"))
    started = warned = False
    gone = None  # when its Chrome was last seen closed (after it had been open)
    while True:
        try:
            urls = song_tabs(a.port, a.official_only)
            state["chrome"] = urls is not None
            if urls is not None:
                gone, started = None, True
            elif started and time.time() - state["launched"] > 40 and not state["busy"]:
                gone = gone or time.time()
                if a.hidden and time.time() - gone > 60:  # you closed its Chrome: nothing left for it to do
                    print("Its Chrome was closed, so the UG helper stopped.")
                    return
            if urls is None:
                if not started:
                    started = True
                    if start_chrome(a.port, a.profile):
                        print("Opened the collector Chrome, out of sight: click it in the taskbar to use it. Log in to UG Pro\n"
                              "there (once), then open an official song, or search from Fretboard.")
                        time.sleep(5)
                        continue
                if not warned and time.time() - state["launched"] > 40:  # not while it's still starting
                    print("Can't reach Chrome on port %d. Close every window of that Chrome and run this again, or start it with:\n"
                          '  & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=%d --user-data-dir="%s"'
                          % (a.port, a.port, a.profile))
                    warned = True
                time.sleep(5)
                continue
            warned = False
            now = time.time()
            if now - state["picking"] < 900:  # a song opened after a search from Fretboard: you picked it
                for u in urls:
                    if u not in seen:
                        state["asked"][u.split("?")[0]] = now
                        if state.get("back_to"):
                            threading.Thread(target=back_to_app, args=(a.port,), daemon=True).start()
            seen = {u: seen.get(u, now) for u in urls}
            passed &= set(urls)  # a song closed and opened again is asked again
            for u in urls:
                # saved before and opened again from Fretboard (within the last 2 minutes): a window asks what to do
                again = u in done and now - state["asked"].get(u.split("?")[0], 0) < 120
                if (u in done and not again) or u in passed or now - seen[u] < a.settle:
                    continue
                state["asked"].pop(u.split("?")[0], None)
                print(f"\n=== {u}")
                cmd = [sys.executable, "-u", str(COLLECT), u, "--port", str(a.port), "--root", a.root] + (["--no-ui"] if a.no_ui else [])
                if settings().get("notation"):
                    cmd.append("--notation")
                if again:
                    print("Saved before: a window asks whether to replace it or save a new copy.")
                    cmd.append("--again")
                else:
                    cmd.append("--auto-official")
                state["busy"] = u
                try:
                    code = subprocess.run(cmd).returncode
                finally:
                    state["busy"] = state["wait"] = ""
                if code == DONE:
                    done.add(u)
                    with DONE_FILE.open("a", encoding="utf-8") as f:
                        f.write(u + "\n")
                    print("Ready for the next song.")
                elif again and code in (SKIPPED, CANCELLED):
                    print("Left as it was.")
                elif code in (SKIPPED, CANCELLED):
                    passed.add(u)
                    print("Skipped." if code == SKIPPED else "Cancelled; what it saved was removed.")
                else:
                    print("That song didn't finish; it will be tried again in a minute while it stays open.")
                    seen[u] = time.time() + 60
                break  # one song at a time; re-read the open tabs afterwards
        except Exception as e:  # one bad moment never closes the helper
            print(f"(Something went wrong, carrying on: {e})")
            time.sleep(5)
            continue
        time.sleep(3)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
