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
closes (what it prints goes to helper.log beside it). Fretboard's Stop button ends it, so does Quit
on its icon by the clock (the notification area), and it ends by itself a minute after you close its Chrome while nothing is being saved.

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


CLAIM = Path.home() / ".fretboard" / "ug-claim.json"  # written by ug_collect.py --claim (a script's own save)


def claimed():
    """The song a script is saving now (ug_collect.py --claim), or None. A claim over 20 minutes old is stale."""
    try:
        c = json.loads(CLAIM.read_text(encoding="utf-8"))
        return c["url"] if time.time() - c["time"] < 1200 else None
    except (OSError, ValueError, KeyError):
        return None


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
state = {"busy": "", "wait": "", "songs": {}, "queue": [], "jobs": [], "skip": set(), "drops": {}, "root": "", "chrome": False, "chrome_port": 9222, "profile": "", "launched": 0, "asked": {}, "picking": 0}  # set from the command line in main()


def is_ug(url):
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    return u.scheme == "https" and (host == "ultimate-guitar.com" or host.endswith(".ultimate-guitar.com"))


# ---------- the downloads: each song's files, for Fretboard's panel (Retry / Cancel) ----------
SONG_STATES = ("waiting", "saving", "done", "held", "failed", "cancelled")


def song_name_of(url):
    """A name from the URL until the page has told it: /tab/hillsong/here-i-am-official-123 -> Here I Am."""
    slug = url.rstrip("/").split("/")[-1]
    slug = slug.rsplit("-", 1)[0] if slug.rsplit("-", 1)[-1].isdigit() else slug
    for k in ("-official", "-guitar-pro", "-chords", "-tabs", "-bass", "-ukulele", "-drums", "-power", "-pro"):
        slug = slug.split(k)[0]
    return slug.replace("-", " ").title()


def reported(got):
    """A report from the collector. A retry reports only its own tracks: they're put into the song's list by name."""
    url = got["url"].split("?")[0]
    old = state["songs"].get(url)
    tracks = [t for t in got.get("tracks", []) if isinstance(t, dict)]
    if old and old.get("tracks") and state.get("retrying") == url:
        merged, used = [dict(t) for t in old["tracks"]], set()
        for t in tracks:
            j = next((j for j, o in enumerate(merged) if o["name"] == t.get("name") and j not in used), None)
            if j is None:
                merged.append(t)
            else:
                used.add(j)
                merged[j] = {**merged[j], **t}
        tracks = merged
    state["songs"][url] = {"url": url, "song": str(got.get("song") or (old or {}).get("song") or song_name_of(url)),
                           "artist": str(got.get("artist") or (old or {}).get("artist") or ""),
                           "folder": str(got.get("folder") or (old or {}).get("folder") or ""),
                           "state": got.get("state") if got.get("state") in SONG_STATES else "saving",
                           "why": str(got.get("why") or ""), "tracks": tracks, "t": time.time()}


def song_list():
    """The songs for Fretboard: waiting in the queue, being saved, held for you, and the ones just done."""
    now = time.time()
    for u, s in list(state["songs"].items()):  # finished ones stay a while, so Fretboard can show them
        if s["state"] in ("done", "cancelled") and now - s["t"] > 600:
            del state["songs"][u]
    songs = [dict(s) for s in sorted(list(state["songs"].values()), key=lambda s: s["t"])]
    have = {s["url"] for s in songs}
    retries = {j["url"] for j in state["jobs"]}
    for s in songs:
        if s["url"] in retries and s["url"] != state["busy"]:
            s["state"] = "waiting"
    songs += [{"url": u, "song": song_name_of(u), "artist": "", "folder": "", "state": "waiting", "why": "", "tracks": []}
              for u in state["queue"] if u not in have]
    return songs


def in_root(folder):
    try:
        f, root = Path(folder).resolve(), Path(state["root"]).resolve()
        return f != root and root in f.parents
    except (OSError, ValueError):
        return False


def manifest(folder):
    try:
        return json.loads((Path(folder) / "fretboard-run.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_manifest(folder, m):
    from ug_collect import write_manifest
    write_manifest(Path(folder), "fretboard-run.json", {k: v for k, v in m.items() if k not in ("app", "version", "finished")})


def retry(url, track, shots=False):
    """A track that failed (or that you want again), saved once more into its song: in the queue, one at a time."""
    s = state["songs"].get(url)
    if not s or not track or not in_root(s["folder"]):
        return False, "That song isn't in the downloads any more."
    if any(j["url"] == url and j["track"] == track for j in state["jobs"]):
        return True, ""
    state["jobs"].append({"url": url, "track": track, "shots": shots})
    for t in s["tracks"]:
        if t["name"] == track and t["state"] != "saved":
            t.update(state="waiting", why="")
    print(f"Retry queued: {s['song']} - {track}" + (" (pictures of the score)" if shots else ""))
    return True, ""


def drop_track(s, track):
    """One file out of the song: its PDF is deleted, and the song no longer waits for it."""
    m = manifest(s["folder"])
    if m is not None:
        for t in [t for t in m.get("tracks", []) if t.get("name") == track]:
            try:
                (Path(s["folder"]) / Path(t["file"]).name).unlink(missing_ok=True)
            except OSError:
                pass
            m["tracks"].remove(t)
        m["missing"] = [n for n in m.get("missing", []) if n != track]
        m["dropped"] = sorted(set(m.get("dropped", [])) | {track})
        save_manifest(s["folder"], m)
    for t in s["tracks"]:
        if t["name"] == track:
            t.update(state="dropped", why="")
    if s["state"] == "held" and not any(t["state"] in ("failed", "waiting", "saving") for t in s["tracks"]):
        s["state"] = "done" if any(t["state"] == "saved" for t in s["tracks"]) else "cancelled"
    s["t"] = time.time()


def drop_song(s):
    """The whole song: the files the helper saved for it are deleted, and its folder if that leaves it empty."""
    folder = Path(s["folder"])
    m = manifest(folder) or {}
    names = {Path(t["file"]).name for t in m.get("tracks", []) if isinstance(t.get("file"), str)}
    names |= {Path(t["file"]).name for t in s["tracks"] if t.get("file")}
    if isinstance(m.get("chords"), str):
        names.add(Path(m["chords"]).name)
    for f in list(folder.glob("fretboard-run*.json")):
        names.add(f.name)
    for n in names:
        try:
            (folder / n).unlink(missing_ok=True)
        except OSError:
            pass
    try:
        folder.rmdir()  # only when nothing else is in it
    except OSError:
        pass
    s.update(state="cancelled", why="Deleted", t=time.time())


def close_song_tab(url):
    try:
        port = state["chrome_port"]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3) as r:
            for t in json.load(r):
                if t.get("type") == "page" and t["url"].split("?")[0].split("#")[0] == url:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{t['id']}", timeout=3).read()
    except (OSError, ValueError):
        pass


def drop(url, track=""):
    """Cancel from Fretboard: one file (track), or the whole song (no track)."""
    s = state["songs"].get(url)
    if not track:
        state["jobs"] = [j for j in state["jobs"] if j["url"] != url]
        if url in state["queue"] and not s:  # not started yet: it just leaves the queue
            state["skip"].add(url)
            state["queue"].remove(url)
            close_song_tab(url)
            print(f"Taken out of the queue: {song_name_of(url)}")
            return True, ""
        if url == state["busy"]:  # being saved: the collector stops and takes back what it saved
            from ug_collect import CANCEL_FLAG
            CANCEL_FLAG.write_text("1")
            state["drops"][url] = None
            return True, ""
        if s and in_root(s["folder"]):
            drop_song(s)
            state["skip"].add(url)
            print(f"Deleted: {s['song']}")
            return True, ""
        if s:
            s.update(state="cancelled", t=time.time())
            return True, ""
        return False, "That song isn't in the downloads any more."
    if not s or not in_root(s["folder"]):
        return False, "That song isn't in the downloads any more."
    state["jobs"] = [j for j in state["jobs"] if not (j["url"] == url and j["track"] == track)]
    if url == state["busy"]:  # done once this run ends (it may be writing that file now)
        state["drops"].setdefault(url, set())
        if state["drops"][url] is not None:
            state["drops"][url].add(track)
        return True, ""
    drop_track(s, track)
    print(f"Left out: {s['song']} - {track}")
    return True, ""


def after_run(url):
    """Cancels pressed in Fretboard while that song was being saved."""
    d = state["drops"].pop(url, False)
    s = state["songs"].get(url)
    if d is None and s:  # the whole song: the collector took its files back; anything left goes too
        if in_root(s["folder"]) and s["state"] != "cancelled":
            drop_song(s)
        s.update(state="cancelled", t=time.time())
    elif d and s:
        for track in d:
            drop_track(s, track)


def held_songs(root):
    """Songs saved before with a file that failed (in their fretboard-run.json): they still wait for you."""
    try:
        for d in Path(root).iterdir():
            m = manifest(d) if d.is_dir() else None
            if not m or not m.get("missing") or not isinstance(m.get("url"), str):
                continue
            url = m["url"].split("?")[0]
            tracks = [{"name": t.get("name", ""), "state": "saved", "why": "", "file": t.get("file", "")} for t in m.get("tracks", [])]
            tracks += [{"name": n, "state": "failed", "why": "Not saved", "file": ""} for n in m["missing"]]
            order = m.get("order") or []
            tracks.sort(key=lambda t: order.index(t["name"]) if t["name"] in order else len(order))
            state["songs"][url] = {"url": url, "song": str(m.get("song") or d.name), "artist": str(m.get("artist") or ""),
                                   "folder": str(d), "state": "held", "why": "", "tracks": tracks, "t": time.time()}
    except OSError:
        pass


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
            return self._send(200, {"ok": True, "app": "fretboard-ug-helper", "version": 5,
                                    "chrome": state["chrome"], "busy": state["busy"], "wait": state["wait"], "songs": song_list(), "notation": bool(settings().get("notation"))})
        self._send(404, {"ok": False})

    def do_POST(self):
        if not self._allowed():
            return self._send(403, {"ok": False})
        if self.path.split("?")[0] == "/show":  # the collector window asks too (no Origin: not a web page)
            ok = show_window()
            return self._send(200, {"ok": ok})
        if self.path.split("?")[0] == "/report":  # the collector: each file's state
            if self.headers.get("Origin") is not None:
                return self._send(403, {"ok": False})
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 65536)
                got = json.loads(self.rfile.read(n) or b"{}")
                if not isinstance(got, dict) or not isinstance(got.get("url"), str):
                    raise ValueError
            except (ValueError, AttributeError):
                return self._send(400, {"ok": False})
            reported(got)
            return self._send(200, {"ok": True})
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
        if self.path.split("?")[0] in ("/retry", "/drop"):
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 8192)
                got = json.loads(self.rfile.read(n) or b"{}")
                url, track = str(got.get("url") or ""), got.get("track")
            except (ValueError, AttributeError):
                return self._send(400, {"ok": False})
            if self.path.startswith("/retry"):
                ok, why = retry(url, str(track or ""), bool(got.get("shots")))
            else:
                ok, why = drop(url, str(track) if track else "")
            return self._send(200, {"ok": ok, "why": why})
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


TRAY = {}  # the notification-area icon, so it can be taken away on quit


def tray_icon():
    """An icon by the clock (the notification area), always in the same spot: click it for Show UG
    window and Quit UG helper. Plain Windows calls, nothing to install. Runs on its own thread."""
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes
    u32, sh, gdi, k32 = ctypes.windll.user32, ctypes.windll.shell32, ctypes.windll.gdi32, ctypes.windll.kernel32
    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    u32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    u32.DefWindowProcW.restype = LRESULT
    u32.CreateWindowExW.restype = wintypes.HWND
    u32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
    u32.CreatePopupMenu.restype = wintypes.HMENU
    u32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
    u32.TrackPopupMenu.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.LPVOID]
    u32.DestroyMenu.argtypes = [wintypes.HMENU]
    u32.SetForegroundWindow.argtypes = [wintypes.HWND]
    u32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    gdi.CreateBitmap.restype = wintypes.HBITMAP
    u32.CreateIconIndirect.restype = wintypes.HICON
    k32.GetModuleHandleW.restype = wintypes.HMODULE

    class WNDCLASS(ctypes.Structure):
        _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                    ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE),
                    ("hbrBackground", wintypes.HBRUSH), ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]

    class NOTIFYICONDATA(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND), ("uID", wintypes.UINT), ("uFlags", wintypes.UINT),
                    ("uCallbackMessage", wintypes.UINT), ("hIcon", wintypes.HICON), ("szTip", wintypes.WCHAR * 128),
                    ("dwState", wintypes.DWORD), ("dwStateMask", wintypes.DWORD), ("szInfo", wintypes.WCHAR * 256),
                    ("uVersion", wintypes.UINT), ("szInfoTitle", wintypes.WCHAR * 64), ("dwInfoFlags", wintypes.DWORD),
                    ("guidItem", ctypes.c_ubyte * 16), ("hBalloonIcon", wintypes.HICON)]

    class ICONINFO(ctypes.Structure):
        _fields_ = [("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD), ("yHotspot", wintypes.DWORD),
                    ("hbmMask", wintypes.HBITMAP), ("hbmColor", wintypes.HBITMAP)]

    # The icon: Fretboard's orange disc with a white "UG".
    n = 32
    px = bytearray(n * n * 4)
    letters = ["#..#.####", "#..#.#...", "#..#.#...", "#..#.#.##", "#..#.#..#", "####.####"]
    for y in range(n):
        for x in range(n):
            i = (y * n + x) * 4
            if (x - 15.5) ** 2 + (y - 15.5) ** 2 <= 15.5 ** 2:
                px[i:i + 4] = bytes((0x41, 0xa5, 0xf2, 0xff))  # BGRA of #f2a541
            gx, gy = (x - 7) // 2, (y - 10) // 2
            if 0 <= gy < len(letters) and 0 <= gx < len(letters[0]) and letters[gy][gx] == "#":
                px[i:i + 4] = bytes((0xff, 0xff, 0xff, 0xff))
    info = ICONINFO(True, 0, 0, gdi.CreateBitmap(n, n, 1, 1, bytes(n * n // 8)), gdi.CreateBitmap(n, n, 1, 32, bytes(px)))
    icon = u32.CreateIconIndirect(ctypes.byref(info))

    WM_TRAY, WM_DESTROY, SHOW, QUIT = 0x8001, 0x0002, 1, 2
    restarted = u32.RegisterWindowMessageW("TaskbarCreated")  # Explorer restarted: the icon is put back

    def add(msg=0):  # NIM_ADD 0, NIM_DELETE 2
        sh.Shell_NotifyIconW(msg, ctypes.byref(nid))

    def menu():
        m = u32.CreatePopupMenu()
        u32.AppendMenuW(m, 0, SHOW, "Show UG window")
        u32.AppendMenuW(m, 0x800, 0, None)  # a line
        u32.AppendMenuW(m, 0, QUIT, "Quit UG helper (stops the song being saved)" if state.get("busy") else "Quit UG helper")
        pt = wintypes.POINT()
        u32.GetCursorPos(ctypes.byref(pt))
        u32.SetForegroundWindow(hwnd)  # so the menu closes when you click elsewhere
        pick = u32.TrackPopupMenu(m, 0x0100 | 0x0020, pt.x, pt.y, 0, hwnd, None)  # TPM_RETURNCMD | TPM_BOTTOMALIGN
        u32.PostMessageW(hwnd, 0, 0, 0)
        u32.DestroyMenu(m)
        if pick == SHOW:
            threading.Thread(target=show_window, daemon=True).start()
        elif pick == QUIT:
            print("Quit from its icon by the clock.")
            threading.Thread(target=quit_helper, kwargs={"why": ""}, daemon=True).start()

    def proc(h, msg, wp, lp):
        if msg == WM_TRAY and lp in (0x0202, 0x0205):  # left or right button up
            menu()
            return 0
        if msg == restarted:
            add()
        return u32.DefWindowProcW(h, msg, wp, lp)

    TRAY["proc"] = WNDPROC(proc)  # kept alive: Windows calls it
    hinst = k32.GetModuleHandleW(None)
    wc = WNDCLASS(0, TRAY["proc"], 0, 0, hinst, icon, None, None, None, "FretboardUGHelperTray")
    u32.RegisterClassW(ctypes.byref(wc))
    hwnd = u32.CreateWindowExW(0, "FretboardUGHelperTray", "Fretboard UG helper", 0, 0, 0, 0, 0, None, None, hinst, None)
    nid = NOTIFYICONDATA()
    nid.cbSize, nid.hWnd, nid.uID, nid.uFlags, nid.uCallbackMessage, nid.hIcon = ctypes.sizeof(nid), hwnd, 1, 0x1 | 0x2 | 0x4, WM_TRAY, icon
    nid.szTip = "Fretboard UG helper"
    add()
    TRAY["remove"] = lambda: add(2)
    msg = wintypes.MSG()
    while u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        u32.TranslateMessage(ctypes.byref(msg))
        u32.DispatchMessageW(ctypes.byref(msg))


def quit_helper(why="Stopped from Fretboard."):
    """Stop from Fretboard (never while a song is being saved) or from its icon: its Chrome closes, then the helper ends."""
    if why:
        print(why)
    try:
        TRAY.get("remove", lambda: None)()  # no icon left behind by the clock
    except Exception:
        pass
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
    threading.Thread(target=tray_icon, daemon=True).start()
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
    state["root"] = a.root
    held_songs(a.root)
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
            if state["jobs"]:  # a retry from Fretboard: before the next song
                j = state["jobs"].pop(0)
                s = state["songs"].get(j["url"])
                if s and in_root(s["folder"]):
                    print(f"\n=== Again: {s['song']} - {j['track']}")
                    cmd = [sys.executable, "-u", str(COLLECT), j["url"], "--port", str(a.port), "--root", a.root, "--only", j["track"],
                           "--out", s["folder"], "--yes", "--add"] + (["--shots"] if j["shots"] else [])
                    if settings().get("notation"):
                        cmd.append("--notation")
                    state["busy"], state["retrying"] = j["url"], j["url"]
                    try:
                        code = subprocess.run(cmd).returncode
                    finally:
                        state["busy"] = state["wait"] = state["retrying"] = ""
                    after_run(j["url"])
                    print("Saved." if code == DONE else "Still not saved.")
                continue
            now = time.time()
            if now - state["picking"] < 900:  # a song opened after a search from Fretboard: you picked it
                for u in urls:
                    if u not in seen:
                        state["asked"][u.split("?")[0]] = now
                        if state.get("back_to"):
                            threading.Thread(target=back_to_app, args=(a.port,), daemon=True).start()
            mine = claimed()
            if mine in urls:  # a script is saving this song: leave it (and don't save it later either)
                state["skip"].add(mine)
            seen = {u: seen.get(u, now) for u in urls}
            passed &= set(urls)  # a song closed and opened again is asked again
            state["skip"] &= set(urls)
            state["queue"] = [u for u in urls if (u not in done or now - state["asked"].get(u.split("?")[0], 0) < 120)
                              and u not in passed and u not in state["skip"] and u != state["busy"]]
            for u in urls:
                # saved before and opened again from Fretboard (within the last 2 minutes): a window asks what to do
                again = u in done and now - state["asked"].get(u.split("?")[0], 0) < 120
                if (u in done and not again) or u in passed or u in state["skip"] or now - seen[u] < a.settle:
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
                state["queue"] = [x for x in state["queue"] if x != u]
                try:
                    code = subprocess.run(cmd).returncode
                finally:
                    state["busy"] = state["wait"] = ""
                after_run(u)
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
