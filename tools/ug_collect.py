"""Save an official Ultimate Guitar song into Downloads\\UG Songs\\<Song> - <Artist> (Key X):
every instrument/vocal track as a PDF, named "<Song> - <Artist> - <Instrument>.pdf", which
Fretboard reads into playable tracks (--gp: its Guitar Pro version instead, when UG has one). Tabs runs leave behind in the collector Chrome are closed afterwards.

Other UG pages work too, one file each into the same song folder:
  chords and plain tabs   the text shown on the page -> "<Song> - <Artist> - Chords.txt" (or Tab, Bass Tab...)
  Guitar Pro tabs          the page's own "Download (gp)" button -> "<Song> - <Artist> - Guitar Pro.gp"

A small window first shows the song and its tracks (untick any you don't want, then Start or
Skip). While it saves, a window stays on top with the progress and a Cancel button; the computer
can be used meanwhile. Cancel stops it and removes everything this run saved, so nothing is left
half done. Your login is never touched.

Each track's PDF is the score as UG's player shows it (sharp, every lyric complete) set on Letter
pages, written by Chrome directly: no Print or Save As window. (UG's own Print button cuts the
lyrics off the last line of each page.)

1. Start Chrome with a debugging port (ug_watch.py does this for you):
     & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\ug-chrome"
   Log in to UG Pro in that window once, and open the song page.
2. pip install playwright
3. python tools/ug_collect.py "<song url>"     (--only "Lead Guitar,Piano" to pick tracks, --no-ui for text only)

Then in Fretboard: Import files (it opens in this song's folder), select all, check, Create song.
Exit codes: 0 done, 1 failed, 2 skipped, 3 cancelled.
"""
import argparse, base64, ctypes, json, os, queue, re, subprocess, sys, threading, time, urllib.parse, urllib.request
from datetime import datetime
from pathlib import Path

PORT = 9222
# --notation: fretted tracks also get their "Standard + Tablature" pages (Fretboard reads only the
# dynamics and words from them). Off, a save is ~15 s quicker: those are the longest prints.
NOTATION = False
SHOTS = False  # --shots: pictures of the score, not UG's Print (the other way, for a track Print gets wrong)
HELPER = f"http://127.0.0.1:{os.environ.get('FB_HELPER_PORT') or 9231}"
CANCEL_FLAG = Path(__file__).with_name("cancel.flag")  # the helper's Cancel song (from Fretboard)
DIALOG = Path(__file__).with_name("ug_save_dialog.ps1")
DONE, FAILED, SKIPPED, CANCELLED = 0, 1, 2, 3
SECONDS_PER_TRACK = 14  # first guess for the time left; then measured


class Cancelled(Exception):
    pass


def hold(ui):
    """Waits here while the run is paused; stops the run when it's cancelled."""
    paused = getattr(ui, "paused", None)
    ui.beat = time.time()  # still going (the window's watchdog looks at this)
    if CANCEL_FLAG.exists():
        ui.cancel.set()
    while paused is not None and paused.is_set() and not ui.cancel.is_set():
        ui.beat = time.time()
        time.sleep(0.25)
    if ui.cancel.is_set():
        raise Cancelled


def park_chrome(cdp, pg, check=False):
    """Moves the collector Chrome off the screen while it works, so it doesn't sit in front of you.
    A Chrome the helper didn't start stops drawing out of sight: with check, that one is brought back
    (only pictures of the screen need the drawing; UG's Print works out of sight)."""
    try:
        from ug_watch import hide_window, show_window
        hide_window(cdp)
        if check:
            pg.wait_for_timeout(800)
        if check and pg.evaluate("document.visibilityState") != "visible":
            show_window(activate=False)
            print("  (This Chrome wasn't started by the UG helper, so it stays on the screen while it works.)")
    except Exception:
        pass


def show_chrome():
    """Brings the parked Chrome up; returns its windows (to park again with back_from_chrome)."""
    try:
        from ug_watch import show_window, offscreen_windows
        hs = offscreen_windows()
        show_window()
        return hs
    except Exception:
        return []


def back_from_chrome(hs, last):
    """Parks Chrome off the screen again, without the focus, and brings back the window you were using."""
    try:
        from ug_watch import _win32, OFF_LEFT
        _, _, u32, _ = _win32()
        for h in hs:
            if u32.IsWindow(h):
                u32.ShowWindow(h, 4)  # SW_SHOWNOACTIVATE: out of maximized, without the focus
                u32.SetWindowPos(h, 0, OFF_LEFT, 0, 1500, 1000, 0x0004 | 0x0010)  # NOZORDER | NOACTIVATE
        if last and u32.IsWindow(last):
            focus_window(last)
    except Exception:
        pass


def focus_window(h):
    """Windows only lets the window you're using hand the focus over: borrow its input for a moment."""
    from ug_watch import _win32
    ctypes_, _, u32, _ = _win32()
    k32 = ctypes_.windll.kernel32
    if u32.IsIconic(h):
        u32.ShowWindow(h, 9)  # SW_RESTORE
    fg = u32.GetForegroundWindow()
    them, me = u32.GetWindowThreadProcessId(fg, None), k32.GetCurrentThreadId()
    joined = them and them != me and u32.AttachThreadInput(me, them, True)
    u32.BringWindowToTop(h)
    u32.SetForegroundWindow(h)
    if joined:
        u32.AttachThreadInput(me, them, False)


def foreground_window():
    try:
        return ctypes.windll.user32.GetForegroundWindow()
    except Exception:
        return 0


# ---------- the computer: is someone using it? ----------

class _LastInput(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]


def idle_seconds():
    """Seconds since the last real mouse or keyboard input (what this script does doesn't count)."""
    try:
        li = _LastInput(ctypes.sizeof(_LastInput), 0)
        ctypes.windll.user32.GetLastInputInfo(ctypes.byref(li))
        return ((ctypes.windll.kernel32.GetTickCount() & 0xFFFFFFFF) - li.dwTime) / 1000.0
    except Exception:
        return 999


# ---------- Chrome ----------

def targets():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
        return json.load(r)


def print_open():
    return any(t["url"].startswith("chrome://print") for t in targets())


def close_prints(ctx=None, dialog=True):
    """Shut any Print window with its own Cancel button: that frees the song's tab again
    (just closing it would leave the tab stuck). A Save As dialog left open is cancelled too.
    Never fails: with Chrome closed there's nothing to shut, and a Cancel still tidies up."""
    try:
        _close_prints(dialog)
    except Exception:
        pass


def save_as_open():
    try:
        return bool(ctypes.windll.user32.FindWindowW("#32770", "Save As"))
    except Exception:
        return True


def _close_prints(dialog=True):
    if dialog and DIALOG.exists() and save_as_open():
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(DIALOG), "-CancelAll"],
                       capture_output=True, text=True)
    if not print_open():
        return
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        c = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}").contexts[0]
        for pr in [x for x in c.pages if x.url.startswith("chrome://print")]:
            try:
                pr.locator("cr-button.cancel-button").first.click(no_wait_after=True, timeout=4000)
            except Exception:
                pass
    for _ in range(50):
        if not print_open():
            return
        time.sleep(0.1)
    for t in targets():  # last resort: close the Print window itself (never the song's tab)
        if t["url"].startswith("chrome://print") and t["type"] == "page":
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/close/{t['id']}", timeout=5).read()


def set_a4(pr):
    """Paper size A4 (Letter cuts words off the page edge). It sits under 'More settings'."""
    try:
        more = pr.get_by_text("More settings", exact=True)
        if more.count() and more.first.is_visible():
            more.first.click(timeout=3000)
            pr.wait_for_timeout(600)
    except Exception:
        pass
    sels = pr.locator("select")
    for i in range(sels.count()):
        s = sels.nth(i)
        if s.evaluate("e=>[...e.options].some(o=>o.text.trim()=='A4')"):
            s.select_option(label=next(t for t in s.evaluate("e=>[...e.options].map(o=>o.text)") if t.strip() == "A4"))
            pr.wait_for_timeout(2000)  # preview re-renders
            return True
    return False


def responsive(pg):
    try:
        return pg.evaluate("1") == 1
    except Exception:
        return False


def song_page(ctx, url):
    for pg in reversed(ctx.pages):
        if pg.url.split("?")[0] == url.split("?")[0] and not pg.is_closed():
            pg.set_default_timeout(15000)
            if responsive(pg):
                front(pg)
                return pg
    pg = ctx.new_page()  # the open tab is stuck (or gone): work in a fresh one, leave the user's tab be
    pg.set_viewport_size({"width": 1500, "height": 1000})
    pg.goto(url, wait_until="domcontentloaded")
    try:  # on once the player is up (its Print button shows)
        pg.wait_for_function(PLAYER_JS, timeout=15000, polling=100)
    except Exception:
        pass
    front(pg)
    return pg


PLAYER_JS = "() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() == 'Print')"

# UG's "Love this tab?" box (stars to rate it) comes up now and then over the song. It hides the rest of
# the page from the helper (aria-hidden: "Couldn't read the Instruments list") and blocks clicks, so it's
# closed with its own X: the button at the box's top, beside the heading. The stars are never pressed.
# "closed", "esc" (no X found: Escape closes it), or "" (no box).
POPUP_JS = r"""() => {
  const head = [...document.querySelectorAll('h1,h2,h3,h4,h5,p,div,span')].find((e) =>
    e.childElementCount === 0 && /^love this (tab|song)\??$/i.test(e.textContent.trim()) && e.getClientRects().length);
  if (!head) return '';
  const top = head.getBoundingClientRect();
  for (let box = head.parentElement; box && box !== document.body; box = box.parentElement) {
    const buttons = [...box.querySelectorAll('button,[role=button]')];
    const x = buttons.find((b) => /close|dismiss/i.test(b.getAttribute('aria-label') || ''))
      || buttons.find((b) => { const r = b.getBoundingClientRect();
        return !b.textContent.trim() && r.width && r.top < top.bottom && r.left >= top.right - 2; }); // beside it, not under it
    if (x) { x.click(); return 'closed'; }
    if (box.matches('[role=dialog],[aria-modal=true]')) break;
  }
  return 'esc';
}"""
# The same, watched for in the page itself (every 0.5 s) for as long as the run works in it
POPUP_WATCH_JS = "() => { if (!window.__fbPopups) window.__fbPopups = setInterval(() => { try { (" + POPUP_JS + ")(); } catch (e) {} }, 500); }"


def close_popups(pg):
    """Closes UG's rating box if it's up (see POPUP_JS); never fails."""
    try:
        if pg.evaluate(POPUP_JS) == "esc":
            pg.keyboard.press("Escape")
    except Exception:
        pass


def watch_popups(pg):
    try:
        pg.evaluate(POPUP_WATCH_JS)
    except Exception:
        pass
CHECK_JS = """() => /just a moment|verify you are human|checking your browser/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 2000))
  || !!document.querySelector('iframe[src*="challenges.cloudflare.com"]')"""


def to_helper(path, body):
    try:
        req = urllib.request.Request(HELPER + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass  # run without the helper: nobody to tell


def tell_helper(text):
    """What the run waits on, for Fretboard's UG helper line ("" when it isn't waiting)."""
    to_helper("/wait", {"text": text})


class Report:
    """Each file's state, sent to the helper for Fretboard's downloads panel (and its Retry / Cancel):
    waiting, saving, saved, failed. The song: saving, done, held (a file failed: it waits for you), failed, cancelled."""
    def __init__(self, url):
        self.d = {"url": url, "song": "", "artist": "", "folder": "", "state": "saving", "why": "", "tracks": []}

    def song(self, song, artist, folder, names, state="waiting"):
        self.d.update(song=song, artist=artist, folder=str(folder))
        self.d["tracks"] = [{"name": n, "state": state, "why": "", "file": ""} for n in names]
        self.send()

    def track(self, i, state, why="", file=""):
        if 0 <= i < len(self.d["tracks"]):
            self.d["tracks"][i].update(state=state, why=why, file=file)
            self.send()

    def end(self, state, why=""):
        self.d.update(state=state, why=why)
        self.send()

    def send(self):
        to_helper("/report", self.d)


def wait_player(ui, pg, limit=300):
    """UG's player can hang while it loads the song: UG (Cloudflare) holds pages back on some networks,
    public wifi above all. The UG window then comes up, so you can see why and finish UG's check yourself;
    the run carries on by itself once the player shows. Nothing is clicked or got round for you."""
    if "-official-" not in pg.url:
        return
    try:
        pg.wait_for_function(PLAYER_JS, timeout=15000, polling=200)
        return
    except Exception:
        pass
    try:
        check = pg.evaluate(CHECK_JS)
    except Exception:
        check = False
    text = (("UG is checking this network before it shows the song (common on public wifi). "
             "The UG window is open: finish UG's check there.") if check else
            ("UG's player isn't loading the song. On public wifi UG often holds pages back. "
             "The UG window is open: if UG shows a check, finish it there, or reload the page.")) \
        + " Saving carries on by itself once the song shows."
    print("  " + text)
    show_chrome()
    ui.waiting(text)
    tell_helper(text)
    try:
        end = time.time() + limit
        while time.time() < end:
            hold(ui)
            if pg.is_closed():
                raise RuntimeError("The song's tab was closed while UG was loading it.")
            try:
                if pg.evaluate(PLAYER_JS):
                    return
            except Exception:
                pass  # reloading
            pg.wait_for_timeout(500)
        raise RuntimeError("UG's player didn't load the song in 5 minutes. UG may be holding back this network "
                           "(common on public wifi): try another network, such as your phone's hotspot, and open the song again.")
    finally:
        tell_helper("")


def front(pg):
    """The song's tab to the front of its window: Chrome only draws (and so only takes pictures of)
    the tab in front; a picture of a tab behind others never arrives. The window is parked out of
    sight again straight after (park_chrome)."""
    try:
        pg.bring_to_front()
    except Exception:
        pass


FPS_JS = """()=>new Promise((res)=>{let n=0;const t0=performance.now();
  const f=()=>{n++;if(performance.now()-t0<300)requestAnimationFrame(f);else res(n)};
  requestAnimationFrame(f);setTimeout(()=>res(n),1000)})"""


def keep_drawing(cdp, pg):
    """Chrome draws only the tab in front of a window that isn't minimized, and every picture of the
    score waits for a drawing: a tab clicked meanwhile or the window minimized slows each track to a
    crawl. Behind other windows or off the screen it draws at full speed, so only those two are put right."""
    try:
        minimized = cdp.send("Browser.getWindowForTarget")["bounds"].get("windowState") == "minimized"
        if not minimized and pg.evaluate(FPS_JS) >= 5:
            return
        front(pg)
        if minimized:
            park_chrome(cdp, pg, check=True)
    except Exception:
        pass


INSTRUMENTS_JS = """()=>{const h=[...document.querySelectorAll('h2')].find(e=>e.innerText.trim()=='Instruments');
  return !!(h&&h.getBoundingClientRect().width>0&&h.closest('[aria-hidden=true]')==null)}"""


def open_instruments(pg):
    """Show the player's Instruments panel (track list) if it's folded away."""
    for _ in range(3):
        close_popups(pg)
        if pg.evaluate(INSTRUMENTS_JS):
            return
        try:
            # the |<- tab at the score's right edge, pressed with a plain mouse click at its middle: a
            # locator click is reported as blocked (it lands all the same) and waits out its timeout,
            # and a click() from the page doesn't open it
            at = pg.evaluate("(()=>{const e=document.querySelector('[class*=_0kBTe]');if(!e)return null;"
                             "const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
            if at:
                pg.mouse.click(*at)
            pg.wait_for_function(INSTRUMENTS_JS, timeout=2000, polling=50)
        except Exception:
            pass


NOTATION_JS = r"""() => {
  const b = [...document.querySelectorAll('button')].find((e) => /^Notation/.test(e.textContent.trim()));
  return b ? b.textContent.trim().replace(/^Notation/, '') : null;
}"""


# Settings > Notation > want, each press as soon as its menu shows. The choice before ("St. + Tab",
# "Tablature"...) once the button shows label, the new choice's short name; null when a step didn't come.
SWITCH_JS = r"""async ([want, label]) => {
  const wait = async (f) => { const end = Date.now() + 3000; for (;;) { const v = f(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 20)); } };
  const now = () => { const b = [...document.querySelectorAll('button')].find((e) => /^Notation/.test(e.textContent.trim())); return b ? b.textContent.trim().replace(/^Notation/, '') : null; };
  const close = () => document.querySelectorAll('button[aria-label=Dismiss]').forEach((b) => b.click());
  try {
    const gear = document.querySelector('button[aria-label=Settings]');
    if (!gear) return null;
    gear.click();
    const was = await wait(now);
    if (!was || was === label) return was;
    [...document.querySelectorAll('button')].find((e) => /^Notation/.test(e.textContent.trim())).click();
    const op = await wait(() => [...document.querySelectorAll('[role=option]')].find((e) => e.textContent.trim() === want));
    if (!op) return null;
    op.click();
    return (await wait(() => now() === label)) ? was : null;
  } finally { close(); }
}"""


def notation(pg, want=None):
    """The player's Settings > Notation choice ("St. + Tab", "Tablature"...). With want ("Tablature",
    "Standard + Tablature"), picks it first. Tablature alone draws each note's length under the tab,
    which Fretboard reads; under a music staff the lengths are only in the staff. None: not found."""
    if want:  # pressed from the page (~0.1 s); the pointer clicks below are the fallback (~0.5-1.4 s)
        try:
            was = pg.evaluate(SWITCH_JS, [want, {NOTES_VIEW: "St. + Tab"}.get(want, want)])
            if was:
                return was
        except Exception:
            pass
    gear = pg.locator("button[aria-label=Settings]").first
    dismiss = "() => document.querySelectorAll('button[aria-label=Dismiss]').forEach((b) => b.click())"
    try:
        gear.click(timeout=4000)
        # each step goes on as soon as the menu shows what it needs (no fixed waits)
        pg.wait_for_function(f"({NOTATION_JS})() !== null", timeout=4000, polling=100)
        now = pg.evaluate(NOTATION_JS)
        if want and now is not None and now != {NOTES_VIEW: "St. + Tab"}.get(want, want):
            pg.locator("button", has_text="Notation").first.click(timeout=4000)
            pg.locator("[role=option]", has_text=want).filter(has_text=re.compile(rf"^\s*{re.escape(want)}\s*$")).first.click(timeout=4000)
        return now
    except Exception:
        return None
    finally:
        try:
            pg.evaluate(dismiss)
        except Exception:
            pass


def track_names(pg):
    return pg.evaluate("""()=>{const h=[...document.querySelectorAll('h2')].find(e=>e.innerText.trim()=='Instruments');
      if(!h)return [];const root=h.closest('[class*=ivABo]')||h.parentElement.parentElement;
      return root.innerText.split('\\n').map(s=>s.trim()).filter(s=>s&&!['Instruments','Pin','Unpin','C','L','R','S','M'].includes(s)&&!/^\\d+%$/.test(s))}""")


def song_name(pg):
    """("Champion", "Bethel Music") from the page heading "Official Champion Tab by Bethel Music"."""
    h1, link = pg.evaluate("[document.querySelector('h1')?.innerText||'', document.querySelector('a[href*=\"/artist/\"]')?.innerText||'']")
    t = re.sub(r"^Official\s+", "", h1.strip(), flags=re.I)
    song, _, artist = t.partition(" by ")
    # the heading sometimes loads without "by <artist>": use the artist link, else the URL (/tab/bethel-music/...)
    artist = artist or link.strip() or pg.url.split("/tab/")[-1].split("/")[0].replace("-", " ").title()
    clean = lambda x: re.sub(r'[\\/:*?"<>|]+', " ", x).strip()
    song = re.sub(r"\s*\(ver\s*\d+\)\s*$", "", song.strip(), flags=re.I)
    song = re.sub(r"\s+(?:Ukulele Chords|Bass Tab|Drum Tab|Guitar Pro|Tabs?|Chords|Pro|Bass|Drums?)$", "", song, flags=re.I)
    return clean(song) or "Song", clean(artist.split(" @")[0])


# What kind of UG page: an official song (PDF per track), a Guitar Pro tab (its Download button),
# or chords / a plain tab (the text shown on the page). The URL says it; the page settles the rest.
TEXT_KINDS = [("-chords-", "Chords"), ("-ukulele-", "Ukulele Chords"), ("-bass-", "Bass Tab"),
              ("-drums-", "Drum Tab"), ("-tabs-", "Tab"), ("-power-", "Tab")]


def page_kind(pg):
    url = pg.url.split("?")[0]
    if "-official-" in url:  # official songs: a PDF per instrument
        return "official", ""
    if "-pro-" in url:  # Pro and Guitar Pro tabs: just the .gp file from their Download button
        return "gp", "Guitar Pro"
    if gp_button(pg) is not None:
        return "gp", "Guitar Pro"
    if pg.evaluate("[...document.querySelectorAll('h2')].some(e=>e.innerText.trim()=='Instruments')"):
        return "official", ""  # the song player with its Instruments list, whatever the URL says
    for part, label in TEXT_KINDS:
        if part in url:
            return "text", label
    t = pg.evaluate("document.title").lower()
    return "text", "Chords" if "chords" in t else "Tab"


def gp_button(pg):
    """The visible 'Download (gp)' button of a Guitar Pro tab page, or None."""
    b = pg.locator("button", has_text=re.compile(r"^\s*Download\s*\((gp\w*)\)\s*$", re.I))
    for i in range(b.count()):
        if b.nth(i).is_visible():
            return b.nth(i)
    return None


def page_text(pg):
    """The tab or chord sheet exactly as the page shows it (the visible text, nothing hidden),
    with the Tuning / Key / Capo line above it."""
    return pg.evaluate("""()=>{const ps=[...document.querySelectorAll('pre')].filter(p=>p.offsetParent!==null&&p.innerText.trim());
      ps.sort((a,b)=>b.innerText.length-a.innerText.length);const t=document.body.innerText;
      const m=(re)=>((t.match(re)||[])[1]||'').trim();
      return {text:(ps[0]?.innerText||'').replace(/\\r\\n?/g,'\\n'),tuning:m(/Tuning:\\s*([^\\n]*?)\\s*(?=Key:|Capo:|\\n|$)/),
        key:m(/Key:\\s*([A-G][#b\u266d\u266f]?m?)/),capo:m(/Capo:\\s*(?:\\n\\s*)?([^\\n]*)/)}}""")


# ---------- the song's chords (over the words) and its linked video ----------

def page_video(pg):
    """The YouTube video UG links to this song (its recording), or ""."""
    try:
        v = pg.evaluate("()=>JSON.stringify(window.UGAPP?.store?.page?.data?.tab?.recording?.video_urls||'')")
    except Exception:
        return ""
    m = re.search(r"(?:youtube\.com/(?:watch\?v=|embed/)|youtu\.be/|^\W*)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])", v or "")
    return m.group(1) if m else ""


# The video in a chords page's Video panel: its thumbnail is the only place the id shows.
THUMB_JS = r"""() => {
  for (const e of document.querySelectorAll('[style*="ytimg.com/vi"]')) {
    const m = /ytimg\.com\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\//.exec(e.style.backgroundImage);
    if (m) return m[1];
  }
  return '';
}"""


def panel_video(pg):
    """The video in UG's Video panel (chords and tab pages), or "". A closed panel is opened for
    the moment it takes and closed again."""
    try:
        v = pg.evaluate(THUMB_JS)
        if v:
            return v
        b = pg.get_by_role("button", name="Video", exact=True)
        if not b.count():
            return ""
        b.first.click(timeout=3000)
        try:
            pg.wait_for_function(THUMB_JS, timeout=4000)
            v = pg.evaluate(THUMB_JS)
        except Exception:
            v = ""
        b.first.click(timeout=3000)  # closed again, as it was
        return v
    except Exception:
        return ""


def page_strum(pg):
    """The page's strumming patterns: [{part, bpm, per (notes per bar: 8, 16), triplet, strokes}].
    A stroke is UG's number: 1 down, 101 up, 3 / 103 accented, 2 / 102 muted, 0 none."""
    try:
        got = pg.evaluate("()=>window.UGAPP?.store?.page?.data?.tab_view?.strummings||[]")
    except Exception:
        return []
    out = []
    for x in got if isinstance(got, list) else []:
        strokes = [m.get("measure") for m in x.get("measures") or [] if isinstance(m, dict) and isinstance(m.get("measure"), int)]
        if strokes:
            out.append({"part": str(x.get("part") or ""), "bpm": int(x.get("bpm") or 0), "per": int(x.get("denuminator") or 0),
                        "triplet": bool(x.get("is_triplet")), "strokes": strokes})
    return out


def official_chords(pg):
    """An official song's Chords view: its chords over the words, in the song's own order. "" when it has none."""
    pressed = False
    try:
        b = pg.get_by_role("button", name="Chords", exact=True)
        if not b.count():
            return ""
        pressed = True
        b.first.click(timeout=5000)
        text = ""
        for _ in range(80):
            text = pg.evaluate("()=>[...document.querySelectorAll('pre')].filter(p=>p.offsetParent!==null).map(p=>p.innerText).join('\\n').trim()")
            if text:
                break
            pg.wait_for_timeout(100)
        return text.replace("\r\n", "\n")
    except Exception:
        return ""
    finally:
        try:
            if pressed:
                pg.get_by_role("button", name="Tab", exact=True).first.click(timeout=5000)
        except Exception:
            pass


# The best page of a kind ("Chords", or "Pro" for Guitar Pro) in UG's search results for a song:
# the closest name, then rating and votes.
CHORDS_JS = r"""([q, type]) => {
  const r = window.UGAPP?.store?.page?.data?.results;
  if (!Array.isArray(r)) return null;
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const words = norm(q).split(' ').filter(Boolean);
  let best = null, top = -1;
  for (const x of r) {
    if (!x || x.type !== type || !/^https:\/\/tabs\.ultimate-guitar\.com\/tab\//.test(x.tab_url || '')) continue;
    const hay = ' ' + norm(`${x.artist_name} ${x.song_name}`) + ' ';
    const m = words.filter((w) => hay.includes(` ${w} `)).length / Math.max(1, words.length);
    const score = m * 100 + (x.rating || 0) * 4 + Math.min(9, Math.log10(1 + (x.votes || 0)) * 2);
    if (score > top) { top = score; best = { url: x.tab_url, m }; }
  }
  return best && best.m >= 0.6 ? best.url : '';
}"""


def search_url(pg, song, artist, type, code):
    """The best result of a kind for the song on UG's search page, opened in pg; "" when there's none."""
    import urllib.parse
    q = f"{artist} {song}".strip()
    pg.goto("https://www.ultimate-guitar.com/search.php?" + urllib.parse.urlencode({"search_type": "title", "value": q, "type": code}),
            wait_until="domcontentloaded", timeout=30000)
    url = None
    for _ in range(100):
        url = pg.evaluate(CHORDS_JS, [q, type])
        if url is not None:
            break
        pg.wait_for_timeout(100)
    return url or ""


def search_gp(ctx, song, artist):
    """The song's best Guitar Pro page on UG, or "". Looked up in a tab of its own, closed again."""
    pg = None
    try:
        pg = ctx.new_page()
        return search_url(pg, song, artist, "Pro", 500)
    except Exception as e:
        print(f"  (No Guitar Pro version: {str(e).splitlines()[0][:100]})")
        return ""
    finally:
        if pg:
            try:
                pg.close()
            except Exception:
                pass


def official_gp(pg):
    """The Guitar Pro version an official song's page links to ("best Pro tab"), or ""."""
    try:
        u = pg.evaluate("()=>window.UGAPP?.store?.page?.data?.tab?.best_pro_tab_url||''")
    except Exception:
        return ""
    return u if re.match(r"^https://tabs\.ultimate-guitar\.com/tab/", u or "") else ""


def official_as_gp(ui, a, result, ctx, pg, gp_url, song, key, n):
    """An official song saved as its Guitar Pro file (plus the official chords). False when that
    page has no Download button (then the PDFs are saved as before)."""
    chords = official_chords(pg)
    gpg = ctx.new_page()
    try:
        gpg.set_default_timeout(15000)
        gpg.goto(gp_url, wait_until="domcontentloaded", timeout=30000)
        for _ in range(20):
            if gp_button(gpg) is not None:
                break
            gpg.wait_for_timeout(500)
        else:
            return False
        save_single(ui, a, result, gpg, "gp", "Guitar Pro", key=key, url=gp_url, chords=chords,
                    what=f"UG has a Guitar Pro file of {song}: every track as a real score, which Fretboard "
                         f"plays far more accurately than the {n} PDFs of the official player. Save it?")
        return True
    finally:
        try:
            gpg.close()
        except Exception:
            pass


def tidy_tabs(keep_url=""):
    """Closes the tabs runs leave behind in the collector Chrome: blank tabs, UG's home page and
    second copies of a song. One tab of each song stays (this run's song first), as does any page
    that isn't UG's and a search you may still be picking from; Chrome always keeps a tab."""
    base = lambda u: u.split("?")[0].split("#")[0].rstrip("/")
    try:
        ts = [t for t in targets() if t["type"] == "page"]
    except Exception:
        return
    keep = base(keep_url)
    ts.sort(key=lambda t: base(t["url"]) != keep)  # this run's song tab is the copy that stays
    seen, close = set(), []
    for t in ts:
        u = base(t["url"])
        ug = re.match(r"^https://(www\.|tabs\.)?ultimate-guitar\.com(/|$)", u + "/")
        if u in ("about:blank", "chrome://newtab", "chrome://new-tab-page") or (ug and u.count("/") <= 2):
            close.append(t)
        elif ug and "/tab/" in u and u in seen:
            close.append(t)
        else:
            seen.add(u)
    if len(close) == len(ts):
        close = close[1:]
    for t in close:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/close/{t['id']}", timeout=5).read()
        except Exception:
            pass


def search_chords(ctx, song, artist):
    """The song's best Chords page on UG: (text, video id). ("", "") when there's none. Opened in a
    tab of its own, which is closed again."""
    pg = None
    try:
        pg = ctx.new_page()
        url = search_url(pg, song, artist, "Chords", 300)
        if not url:
            return "", ""
        pg.goto(url, wait_until="domcontentloaded", timeout=30000)
        info = {}
        for _ in range(100):
            info = page_text(pg)
            if info.get("text", "").strip():
                break
            pg.wait_for_timeout(100)
        return info.get("text", "").strip(), page_video(pg)
    except Exception as e:
        print(f"  (No chords page: {str(e).splitlines()[0][:100]})")
        return "", ""
    finally:
        if pg:
            try:
                pg.close()
            except Exception:
                pass


def save_chords(out, song, artist, text, run, replace=False):
    """The chord sheet next to the song's other files. Returns its file name, or ""."""
    if not text.strip():
        return ""
    stem = " - ".join(x for x in (song, artist, "Chords") if x)
    dest = free_name(out, stem, ".txt")
    dest.write_text(text.rstrip() + "\n", encoding="utf-8")
    run.files.append(dest)
    return take_place(dest, out / f"{stem}.txt") if replace else dest.name


def song_folder(root, song, artist, key):
    """Downloads\\UG Songs\\<Song> - <Artist> (Key X). A folder already made for this song (under any
    key, e.g. by its official PDFs) is used again, so a song's files stay together."""
    base = " - ".join(x for x in (song, artist) if x)
    root = Path(root)
    if root.is_dir():
        same = sorted(d for d in root.iterdir() if d.is_dir() and (d.name == base or d.name.startswith(base + " (Key ")))
        if same:
            return same[0]
    return root / (base + (f" (Key {key})" if key else ""))


def free_name(folder, stem, ext, taken=()):
    """<stem><ext>, or "<stem> (2)<ext>"... when that's taken (or in taken: names about to be written)."""
    dest, k = folder / f"{stem}{ext}", 2
    while dest.exists() or dest in taken:
        dest = folder / f"{stem} ({k}){ext}"
        k += 1
    return dest


def base_pdf(out, song, artist, n):
    return out / (f"{song} - {artist} - {n}.pdf" if artist else f"{song} - {n}.pdf")


def take_place(new, old):
    """Replace: the new file (just saved in full, as "... (2).pdf") takes the old one's name. Returns its name."""
    if new == old or not new.exists():
        return new.name
    try:
        if old.exists():
            old.unlink()
        new.rename(old)
        return old.name
    except OSError:
        return new.name  # the old one is open somewhere: both are kept


def merge_run(out, saved, missing, every):
    """--add: the tracks just saved go into the song's fretboard-run.json (taking a failed one's place,
    or an old copy's); (tracks, missing, the rest of the old manifest)."""
    try:
        old = json.loads((out / "fretboard-run.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        old = {}
    order = old.get("order") or every
    got = {t["name"]: t for t in old.get("tracks", [])}
    for t in saved:
        got[t["name"]] = t
    gone = set(old.get("missing", [])) | set(missing)
    tracks = sorted(got.values(), key=lambda t: order.index(t["name"]) if t["name"] in order else len(order))
    still = [n for n in order if n in gone and n not in got] + [n for n in gone if n not in order and n not in got]
    keep = {k: v for k, v in old.items() if k in ("chords", "video", "key", "dropped")}
    return tracks, still, keep


def write_manifest(out, name, data):
    """What Fretboard reads to offer the song for import (fretboard-run*.json in the song folder)."""
    data = {"app": "fretboard-ug-collect", "version": 1, **data, "finished": datetime.now().isoformat(timespec="seconds")}
    f = out / name
    hide_file(f, False)  # a hidden file can't be written over
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    hide_file(f)


def hide_file(f, hidden=True):
    """Windows' hidden mark, so the file stays out of the way when you pick the song's files
    (Fretboard still finds it)."""
    try:
        import ctypes
        k = ctypes.windll.kernel32
        attrs = k.GetFileAttributesW(str(f))
        if attrs == 0xFFFFFFFF:
            return
        k.SetFileAttributesW(str(f), (attrs | 0x2) if hidden else (attrs & ~0x2))
    except Exception:
        pass


# ---------- windows ----------

class ConsoleUI:
    """--no-ui: the same steps, told in the console."""
    def __init__(self):
        self.cancel = threading.Event()
        self.paused = threading.Event()

    def ask(self, info):
        print(f"{info['song']} - {info['artist']}: {len(info['names'])} tracks -> {', '.join(info['names'])}\n"
              f"Saving into {info['out']}.\n")
        return info["names"]

    def progress(self, i, n, name, eta=None, note=""):
        if i < n:
            print(f"  [{i + 1}/{n}] {name}{' - ' + note if note else ''}")

    def waiting(self, text):
        pass  # wait_player prints it

    def finish(self, text, folder=None):
        print(text)


class TkUI:
    """The windows: 'Found a song' (pick tracks, Start / Skip), then a small always-on-top
    progress window with Cancel, then Done. Tk lives on the main thread; the work on another."""
    BG, FG, MUTED, ACCENT = "#1d1f24", "#eceff4", "#9aa3b2", "#f5a623"

    def __init__(self):
        import tkinter as tk
        from tkinter import ttk
        self.tk, self.ttk = tk, ttk
        self.cancel = threading.Event()
        self.paused = threading.Event()
        self.closed = False
        self.aborted, self.working, self.beat, self.code = False, False, time.time(), FAILED
        self.q = queue.Queue()
        self.root = tk.Tk()
        self.root.title("UG song collector")
        self.root.configure(bg=self.BG)
        self.root.attributes("-topmost", True)
        self.root.protocol("WM_DELETE_WINDOW", self._close)
        self.root.resizable(False, False)
        self.body = tk.Frame(self.root, bg=self.BG, padx=18, pady=14)
        self.body.pack(fill="both", expand=True)
        self._label("Looking at the song…", 12, bold=True)
        self.root.after(100, self._pump)
        self.root.after(1000, self._watch)

    # --- called from the worker thread ---
    def _wait(self, ev):
        while not ev.wait(0.2) and not self.closed:
            pass

    def ask(self, info):
        ev, box = threading.Event(), {}
        self.q.put(("ask", info, ev, box))
        self._wait(ev)
        return box.get("names")

    def progress(self, i, n, name, eta=None, note=""):
        self.working, self.beat = True, time.time()
        self.q.put(("progress", i, n, name, eta, note))

    def waiting(self, text):
        self.q.put(("waiting", text))

    def finish(self, text, folder=None):
        self.working = False
        ev = threading.Event()
        self.q.put(("finish", text, folder, ev))
        self._wait(ev)

    # --- Tk side ---
    def run(self, work):
        t = self.thread = threading.Thread(target=work, daemon=True)
        t.start()
        self.root.mainloop()
        self.cancel.set()  # window closed: stop the work if it's still going
        if not self.aborted:
            t.join(timeout=120)

    # --- the watchdog: Chrome can stop answering in the middle of a step, and the work then waits forever ---
    STALL = 240  # seconds without a sign of life (the slowest step, the first picture, takes under a minute)

    def _watch(self):
        if self.closed:
            return
        # the window you're using (not this one, not the collector Chrome): where "Back to my window" goes
        fg = foreground_window()
        if fg and fg != self._own_hwnd() and fg not in getattr(self, "_chrome_hs", []):
            self._last_fg = fg
        t = getattr(self, "thread", None)
        if t is not None and not t.is_alive() and self.working and not self.aborted:
            self._abort(self.cancel.is_set())  # the work ended without a word (an error it didn't expect)
        elif t is not None and t.is_alive() and self.working and not self.aborted:
            if self.cancel.is_set():
                if time.time() - getattr(self, "cancel_at", time.time()) > 15:
                    self._abort(True)  # Cancel pressed, but the work is stuck in a step
            elif not self.paused.is_set() and time.time() - self.beat > self.STALL:
                self._abort(False)
        self.root.after(1000, self._watch)

    def _abort(self, cancelled):
        """The work is stuck waiting on Chrome: tidied up from here instead, then the run ends."""
        self.aborted = True
        self.cancel.set()  # should the work ever wake up, it stops at its next step
        self.code = CANCELLED if cancelled else FAILED
        run = getattr(self, "run_obj", None)
        if run:
            p = getattr(run, "pending", None)
            if p:
                try:
                    p.with_name(p.name + ".part").unlink(missing_ok=True)
                except OSError:
                    pass
                if cancelled and p.exists() and p not in run.files:
                    run.files.append(p)
            if cancelled:
                run.undo()
        if cancelled:
            text = "Cancelled. Everything this run saved was removed; your other files weren't touched."
        else:
            text = ("Chrome stopped answering, so it stopped.\nThe tracks already saved were kept"
                    + (" (your earlier files weren't replaced)" if getattr(self, "mode", "") == "replace" else "")
                    + ".\n\nOpen the song again to try once more.")
        print(text, flush=True)
        self._finish(text, run.out if run and not cancelled else None, threading.Event())

    def _pump(self):
        try:
            while True:
                msg = self.q.get_nowait()
                getattr(self, "_" + msg[0])(*msg[1:])
        except queue.Empty:
            pass
        if not self.closed:
            self.root.after(100, self._pump)

    def _clear(self):
        for w in self.body.winfo_children():
            w.destroy()

    def _label(self, text, size=10, bold=False, color=None, wrap=420):
        lb = self.tk.Label(self.body, text=text, bg=self.BG, fg=color or self.FG, justify="left", anchor="w",
                           wraplength=wrap, font=("Segoe UI", size, "bold" if bold else "normal"))
        lb.pack(fill="x", pady=(0, 6))
        return lb

    def _button(self, parent, text, cmd, primary=False):
        b = self.tk.Button(parent, text=text, command=cmd, relief="flat", padx=14, pady=5, cursor="hand2",
                           bg=self.ACCENT if primary else "#33363d", fg="#1d1f24" if primary else self.FG,
                           activebackground="#ffbf47" if primary else "#454952", font=("Segoe UI", 10, "bold" if primary else "normal"))
        b.pack(side="left", padx=(0, 8))
        return b

    def _place(self, corner=False):
        self.root.update_idletasks()
        w, h = self.root.winfo_reqwidth(), self.root.winfo_reqheight()
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        x, y = ((sw - w - 24, sh - h - 100) if corner else ((sw - w) // 2, (sh - h) // 3))
        self.root.geometry(f"+{x}+{y}")

    def _ask(self, info, ev, box):
        tk = self.tk
        self._clear()
        self.root.title("Already saved" if info.get("again") else "Found a song")
        self._label(f"{info['song']} — {info['artist']}" + (f"  (Key {info['key']})" if info['key'] else ""), 13, bold=True)
        if info.get("again"):
            self._label("You've saved this song before: it's already in your UG Songs folder (and in Fretboard, if you imported it). "
                        "Replace it with a fresh copy, or keep both?", 10, bold=True, color=self.ACCENT)
        self._label(info.get("what") or f"Save its {len(info['names'])} tracks as PDFs? Untick any you don't want.", 10, color=self.MUTED)
        grid = tk.Frame(self.body, bg=self.BG)
        grid.pack(fill="x", pady=(0, 8))
        vars_ = []
        for k, n in enumerate(info["names"]):
            v = tk.BooleanVar(value=True)
            tk.Checkbutton(grid, text=n, variable=v, bg=self.BG, fg=self.FG, selectcolor="#33363d", activebackground=self.BG,
                           activeforeground=self.FG, anchor="w", font=("Segoe UI", 10)).grid(row=k // 2, column=k % 2, sticky="w", padx=(0, 18))
            vars_.append((n, v))
        mins = max(1, round(len(info["names"]) * SECONDS_PER_TRACK / 60))
        self._label(f"Saves into  {info['out']}\n\n" + ("Replace: the new files are saved first, and only once they're all done "
                    "do they take the old ones' place (in the folder and in Fretboard, where the song keeps its practice "
                    "history). A new copy is kept beside the old one, with \"(2)\" in its name.\n\n" if info.get("again") else "") + (info.get("note") or
                    f"Takes about {mins} min. Chrome works out of sight and a small window shows the progress, "
                    "so you can keep using the computer. Pause it any time, or Cancel (it then removes what it saved).\n\n"
                    "Afterwards, in Fretboard: Import files (it opens in this folder), select all, check the tracks, Create song."),
                    9, color=self.MUTED)
        row = tk.Frame(self.body, bg=self.BG)
        row.pack(fill="x", pady=(6, 0))

        def answer(names, mode=""):
            self.mode = mode
            box["names"] = names
            if names:
                self._starting(len(names))  # at once, so the press shows; the progress takes over when the first track starts
            ev.set()

        picked = lambda: [n for n, v in vars_ if v.get()] or None
        if info.get("again"):
            self._button(row, "Replace the old files", lambda: answer(picked(), "replace"), primary=True)
            self._button(row, "Save a new copy", lambda: answer(picked(), "copy"))
            self._button(row, "Skip", lambda: answer(None))
        else:
            self._button(row, "Start", lambda: answer(picked()), primary=True)
            self._button(row, "Skip this song", lambda: answer(None))
        self._on_close = lambda: answer(None)
        self._place()
        self.root.lift()
        self.root.focus_force()

    def _own_hwnd(self):
        try:
            return int(self.root.wm_frame(), 16)
        except Exception:
            return 0

    def _starting(self, n):
        """Shown the moment Start or Replace is pressed: Chrome takes a while to open the song."""
        self._clear()
        self.root.title("Saving PDFs")
        self._label("Getting ready…", 11, bold=True, color=self.ACCENT)
        self._label(f"Opening the song in Chrome to save {n} track{'s' if n > 1 else ''}. "
                    "This takes a few seconds; the progress shows here.", 9, color=self.MUTED)
        style = self.ttk.Style(self.root)
        style.theme_use("default")
        style.configure("fb.Horizontal.TProgressbar", background=self.ACCENT, troughcolor="#33363d", thickness=10)
        busy = self.ttk.Progressbar(self.body, style="fb.Horizontal.TProgressbar", length=380, mode="indeterminate")
        busy.pack(fill="x", pady=(2, 8))
        busy.start(12)
        self._place(corner=True)

    def _waiting(self, text):
        """UG's player hasn't come up (wait_player): why, with Cancel."""
        self._clear()
        self.root.title("Waiting for UG")
        self._label("Waiting for UG to show the song", 11, bold=True, color=self.ACCENT)
        self._now = self._label(text, 9, color=self.MUTED)
        row = self.tk.Frame(self.body, bg=self.BG)
        row.pack(fill="x")
        self._cancel_btn = self._button(row, "Cancel", self._cancel)
        self._on_close = self._cancel
        self._place(corner=True)

    def _toggle_chrome(self):
        """Show UG window, and from there back to the window you were using."""
        if getattr(self, "_chrome_hs", None):
            hs, self._chrome_hs = self._chrome_hs, []
            self._show_btn.configure(text="Show UG window")
            threading.Thread(target=back_from_chrome, args=(hs, getattr(self, "_last_fg", 0)), daemon=True).start()
            return
        self._show_btn.configure(text="Back to my window")

        def show():
            self._chrome_hs = show_chrome()
            if not self._chrome_hs:  # nothing was parked (a Chrome the helper didn't start): just a show
                self.q.put(("show_btn_text", "Show UG window"))
        threading.Thread(target=show, daemon=True).start()

    def _show_btn_text(self, text):
        if getattr(self, "_show_btn", None) and self._show_btn.winfo_exists():
            self._show_btn.configure(text=text)

    def _progress(self, i, n, name, eta, note):
        ttk = self.ttk
        if not getattr(self, "_bar", None) or not self._bar.winfo_exists():
            self._clear()
            self.root.title("Saving PDFs")
            self._label("Saving PDFs in the background", 11, bold=True, color=self.ACCENT)
            self._label("Keep using the computer, or Pause while you need it.", 9, color=self.MUTED)
            self._now = self._label("", 10)
            style = ttk.Style(self.root)
            style.theme_use("default")
            style.configure("fb.Horizontal.TProgressbar", background=self.ACCENT, troughcolor="#33363d", thickness=10)
            self._bar = ttk.Progressbar(self.body, style="fb.Horizontal.TProgressbar", length=380, maximum=n)
            self._bar.pack(fill="x", pady=(2, 8))
            self._eta = self._label("", 9, color=self.MUTED)
            row = self.tk.Frame(self.body, bg=self.BG)
            row.pack(fill="x")
            self._pause_btn = self._button(row, "Pause", self._pause, primary=True)
            self._cancel_btn = self._button(row, "Cancel", self._cancel)
            self._show_btn = self._button(row, "Show UG window", self._toggle_chrome)
            self._on_close = self._cancel
            self._place(corner=True)
        self._bar["value"] = i
        self._now["text"] = f"Track {min(i + 1, n)} of {n}: {name}"
        left = f"About {max(1, round(eta / 60))} min left." if eta else ""
        self._eta["text"] = " ".join(x for x in (note, left) if x)
        self._eta_text = self._eta["text"]
        if self.paused.is_set():
            self._eta["text"] = "Paused after this step. Press Resume when you're done."

    def _pause(self):
        if self.cancel.is_set():
            return
        if self.paused.is_set():
            self.paused.clear()
            self._pause_btn.configure(text="Pause")
            self._eta["text"] = getattr(self, "_eta_text", "")
        else:
            self.paused.set()
            self._pause_btn.configure(text="Resume")
            self._eta["text"] = "Paused after this step. Press Resume when you're done."

    def _cancel(self):
        if self.cancel.is_set():
            return
        self.cancel.set()
        self.cancel_at = time.time()
        self.paused.clear()
        self._now["text"] = "Cancelling: finishing this step, then removing what this run saved…"
        self._cancel_btn.configure(state="disabled")

    def _finish(self, text, folder, ev):
        self._clear()
        self.root.title("UG song collector")
        self._label(text, 10, wrap=440)
        row = self.tk.Frame(self.body, bg=self.BG)
        row.pack(fill="x", pady=(6, 0))
        if folder and Path(folder).is_dir():
            self._button(row, "Open folder", lambda: subprocess.Popen(["explorer", str(folder)]))
        self._button(row, "Close", self._close, primary=True)
        self._on_close = self._close
        self._place()
        self.root.after(60000, self._close)  # don't wait forever when the watcher is running unattended
        ev.set()

    def _close(self):
        cb = getattr(self, "_on_close", None)
        if cb and cb != self._close:
            cb()
            if cb == self._cancel:
                return  # the work cleans up, then shows its result
        self.closed = True
        self.root.destroy()


# ---------- the run ----------

class Run:
    """What this run made, so Cancel can take it all back: the files saved, the folder if it
    was new, and Downloads\\UG Songs\\latest.txt as it was."""
    def __init__(self, out, root, set_latest):
        self.out, self.root = out, Path(root)
        self.made_folder = not out.exists()
        self.latest = self.root / "latest.txt"
        self.latest_before = self.latest.read_text(encoding="utf-8") if self.latest.exists() else None
        self.set_latest = set_latest
        self.files = []

    def start(self):
        self.out.mkdir(parents=True, exist_ok=True)
        if self.set_latest:  # Fretboard's "Import files" opens in the newest song folder
            self.latest.write_text(self.out.name, encoding="utf-8")

    def undo(self):
        for f in self.files:
            try:
                f.unlink(missing_ok=True)
            except OSError:
                pass
        if self.made_folder:
            try:
                self.out.rmdir()  # only when it's empty: anything else in it stays
            except OSError:
                pass
        if self.set_latest:
            if self.latest_before is None:
                self.latest.unlink(missing_ok=True)
            else:
                self.latest.write_text(self.latest_before, encoding="utf-8")


def wait_idle(ui, i, n, name, eta):
    """Wait until nobody has touched the mouse or keyboard for 3 seconds (a click or key press
    could land in the Save As window)."""
    told = False
    while idle_seconds() < 3:
        hold(ui)
        if not told:
            ui.progress(i, n, name, eta, "Paused: waiting until the mouse and keyboard are left alone.")
            told = True
        time.sleep(0.5)


# ---------- an official track as a PDF: the score as UG shows it, laid out on Letter ----------
# UG's own Print cuts the lyrics off the last line of each of its pages (whatever the zoom), so the
# score is taken from the player itself instead: drawn on a tall, sharp screen (2x pixels), cut
# into lines between the gaps (a line keeps its name, bar numbers and lyrics), and set on Letter pages,
# which this Chrome writes to the PDF straight away (no Print or Save As window).

SHOT_W, SHOT_H, SHOT_DSF = 1536, 7000, 2
PRINT_H = 6000  # taller than Print's 10000 px page (at 2x), so the canvas has the words and notes of each page's last line (GRAB_JS)

# Where the score's drawing is on the page. Anything lying over it (the player's bars, the
# Instruments panel) is hidden for the moment of the picture, then shown again (SHOW_JS).
VISIBLE_JS = r"""()=>{
  const c = document.querySelector('#xtz_canvas');
  if (!c) return null;
  if (c.getBoundingClientRect().y < 0) scrollBy(0, c.getBoundingClientRect().y);  // its top in view
  const r = c.getBoundingClientRect(), bottom = Math.min(r.bottom, innerHeight);
  const hidden = window.__fbHidden = window.__fbHidden || [];
  const hide = (e) => { if (e.style.visibility !== 'hidden') { hidden.push([e, e.style.visibility]); e.style.visibility = 'hidden'; } };
  for (let y = Math.max(r.y, 0) + 1; y < bottom; y += 16) for (let x = r.x + 1; x < r.right; x += 32) {
    for (const e of document.elementsFromPoint(x, y)) {
      if (e === c || e.contains(c)) break;
      hide(e);
    }
  }
  // bars pinned over the score that the pointer passes through (a ticking banner among them)
  for (const e of document.querySelectorAll('body *')) {
    if (e === c || e.contains(c) || c.contains(e)) continue;
    const pos = getComputedStyle(e).position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const b = e.getBoundingClientRect();
    if (b.width && b.height && b.right > r.x && b.x < r.right && b.bottom > r.y && b.y < bottom) hide(e);
  }
  return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: bottom - r.y, dpr: devicePixelRatio };  // on the page, as the picture counts
}"""
# The page's top, or (end) as far down as the score scrolls in its frame: the frame stays put
# while the page scrolls a little, then leaves the screen; its top is kept on the screen.
SCROLL_JS = r"""(end) => {
  const y = scrollY;
  scrollTo(0, end ? document.documentElement.scrollHeight : 0);
  const c = document.querySelector('#xtz_canvas');
  if (end && c && c.getBoundingClientRect().y < 0) scrollBy(0, c.getBoundingClientRect().y);
  return Math.abs(scrollY - y) > 1;
}"""
SHOW_JS = r"""()=>{ for (const [e, v] of (window.__fbHidden || []).reverse()) e.style.visibility = v; window.__fbHidden = []; }"""

PAGES_JS = r"""async ({ shots, title, lines, notes, printed, notesPrinted }) => {
  // the pictures of one view joined top to bottom and cut into lines of music
  const cut = async (shots) => {
  const imgs = await Promise.all(shots.map((s) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = s; })));
  // a song longer than the screen comes in pictures taken further down: each one is put where
  // its rows (ink per row) match the ones before it
  const rows = (img) => {
    const k = document.createElement('canvas'); k.width = img.width; k.height = img.height;
    const kg = k.getContext('2d', { willReadFrequently: true }); kg.drawImage(img, 0, 0);
    const p = kg.getImageData(0, 0, img.width, img.height).data, r = new Float32Array(img.height);
    for (let y = 0; y < img.height; y++) { let n = 0; for (let x = 0, i = y * img.width * 4; x < img.width; x++, i += 4) if (p[i] + p[i + 1] + p[i + 2] < 600) n++; r[y] = n; }
    return r;
  };
  const at = [0];
  let h = imgs[0].height;
  const r0 = rows(imgs[0]);
  for (const img of imgs.slice(1)) {
    const r = rows(img), n = 3000;
    let best = null;
    for (let s = 0; s + n <= r0.length && s < r0.length; s += 1) {
      let e = 0; for (let y = 0; y < n; y++) e += Math.abs(r0[s + y] - r[y]);
      if (!best || e < best.e) best = { s, e };
    }
    if (!best || best.e / n > img.width * 0.05) break;  // no clear match: the first picture alone
    at.push(best.s); h = Math.max(h, best.s + img.height);
  }
  const w = imgs[0].width;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  at.forEach((y, i) => g.drawImage(imgs[i], 0, y));
  const d = g.getImageData(0, 0, w, h), px = d.data;
  // the player's play cursor (red) is painted out; a line it crossed is joined up again
  const red = (i) => px[i] > 110 && px[i] - px[i + 1] > 25 && px[i] - px[i + 2] > 20;
  const pink = (i) => px[i] - px[i + 1] > 6 && px[i] - px[i + 2] > 6;  // its soft edges
  const dark = (i) => i >= 0 && px[i] + px[i + 1] + px[i + 2] < 600;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (!red(row + x * 4)) continue;
      let s0 = x; while (s0 > 0 && pink(row + (s0 - 1) * 4)) s0--;
      let e = x; while (e < w && pink(row + e * 4)) e++;
      const l = s0 > 0 ? row + (s0 - 1) * 4 : -1, r = e < w ? row + e * 4 : -1;
      const fill = dark(l) && dark(r) ? [(px[l] + px[r]) >> 1, (px[l + 1] + px[r + 1]) >> 1, (px[l + 2] + px[r + 2]) >> 1] : [255, 255, 255];
      for (let k = s0; k < e; k++) { const i = row + k * 4; px[i] = fill[0]; px[i + 1] = fill[1]; px[i + 2] = fill[2]; }
      x = e;
    }
  }
  const isInk = (i) => px[i] + px[i + 1] + px[i + 2] < 600;
  const ink = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) if (isInk(i)) n++;
    ink[y] = n;
  }
  // a solid dark band (the site's own bar drawn over the score's edge) is no part of the score:
  // a staff line is a few rows thick, a band many
  for (let y = 0; y < h;) {
    if (ink[y] <= w * 0.5) { y++; continue; }
    const s = y; while (y < h && ink[y] > w * 0.5) y++;
    if (y - s >= 12) { px.fill(255, s * w * 4, y * w * 4); ink.fill(0, s, y); }
  }
  g.putImageData(d, 0, 0);
  let x0 = w, x1 = 0;
  for (let y = 0; y < h; y++) if (ink[y]) {
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) if (isInk(i)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  }
  // rows with ink, in blocks; a block with a long line across is a staff
  const blocks = [];
  for (let y = 0; y < h;) {
    if (!ink[y]) { y++; continue; }
    const s = y; let staff = false;
    while (y < h && ink[y]) { if (ink[y] > w * 0.5) staff = true; y++; }
    blocks.push({ s, e: y, staff });
  }
  if (!blocks.some((b) => b.staff)) return { error: 'no score on the page' };
  // a line's staves (notation + tab) are joined at the left by one upright line: rows where the
  // staves' left edge is drawn belong to the same line
  let sx = w;
  for (const b of blocks) if (b.staff) for (let y = b.s; y < b.e; y++) if (ink[y] > w * 0.5) {
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) if (isInk(i)) { if (x < sx) sx = x; break; }
  }
  const edge = (y) => { for (let x = sx; x < sx + 4; x++) if (isInk((y * w + x) * 4)) return true; return false; };
  const spans = [];
  for (let y = 0; y < h;) {
    if (!edge(y)) { y++; continue; }
    const s = y; let gap = 0, e = y;
    while (y < h && gap <= 2) { if (edge(y)) { e = y + 1; gap = 0; } else gap++; y++; }
    if (blocks.some((b) => b.staff && b.s < e && b.e > s)) spans.push({ s, e });
  }
  // every block joins the line it overlaps; the rest (lyrics, a section's name, bar numbers)
  // join a line one by one, the closest first, so a name above a line's bar numbers goes with that line
  let left = [];
  for (const b of blocks) {
    const hit = spans.find((p) => b.s < p.e && b.e > p.s);
    if (hit) { hit.s = Math.min(hit.s, b.s); hit.e = Math.max(hit.e, b.e); } else left.push(b);
  }
  while (left.length) {
    let best = null;
    for (const b of left) for (const p of spans) {
      const gap = p.e <= b.s ? b.s - p.e : b.e <= p.s ? p.s - b.e : 0;
      if (!best || gap < best.gap) best = { b, p, gap };
    }
    best.p.s = Math.min(best.p.s, best.b.s); best.p.e = Math.max(best.p.e, best.b.e);
    left = left.filter((b) => b !== best.b);
  }
  spans.sort((a, b) => a.s - b.s);
  const units = [];
  for (const p of spans) { const l = units[units.length - 1]; if (l && p.s < l.e) l.e = Math.max(l.e, p.e); else units.push({ ...p }); }
  const last = blocks[blocks.length - 1].e;
  x0 = Math.max(0, x0 - 6); x1 = Math.min(w, x1 + 8);
  const pad = Math.round(w * 0.004);
  const parts = units.map((u) => {
    const s = Math.max(0, u.s - pad), e = Math.min(h, u.e + pad);
    const k = document.createElement('canvas'); k.width = x1 - x0; k.height = e - s;
    k.getContext('2d').drawImage(c, x0, s, x1 - x0, e - s, 0, 0, x1 - x0, e - s);
    return { src: k.toDataURL('image/png'), h: e - s, mm: 191.9 / (x1 - x0) };
  });
  return { parts, full: last >= h - 3, pictures: at.length };
  };
  // UG's own Print already comes cut into lines, one picture each
  // UG's Print can cut a line's picture off right through its bottom staff line (a line with nothing
  // under the staff): only a faint trace of it is left in the last row, so Fretboard sees five lines,
  // not six, and loses the line. That line is drawn back in, one staff space under the one above.
  const mend = (img) => {
    const w = img.width, h = img.height, c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g2 = c.getContext('2d', { willReadFrequently: true });
    g2.drawImage(img, 0, 0);
    const d = g2.getImageData(0, 0, w, h).data, lum = (i) => (d[i + 3] < 128 ? 255 : d[i]);  // see-through is paper
    const dark = (y, lim) => { let k = 0; for (let x = 0; x < w; x += 2) if (lum((y * w + x) * 4) < lim) k++; return k > 0.2 * w; };
    if (!dark(h - 1, 245) || dark(h - 1, 160)) return img.src;
    const rows = [];
    for (let y = 0; y < h - 1; y++) if (dark(y, 160)) { if (rows.length && y - rows[rows.length - 1][1] <= 1) rows[rows.length - 1][1] = y; else rows.push([y, y]); }
    if (rows.length < 5) return img.src;
    const [a, b] = rows.slice(-2), gap = b[0] - a[0];
    if (gap < 8 || Math.abs(h - 1 - b[0] - gap) > 2) return img.src;
    let x0 = 0, x1 = w - 1;
    while (x0 < w && lum((b[0] * w + x0) * 4) >= 160) x0++;
    while (x1 > x0 && lum((b[0] * w + x1) * 4) >= 160) x1--;
    const out = document.createElement('canvas'), t = b[1] - b[0] + 1;
    out.width = w; out.height = b[0] + gap + Math.round(gap / 2);
    const o = out.getContext('2d');
    o.fillStyle = '#fff'; o.fillRect(0, 0, w, out.height);
    o.drawImage(img, 0, 0);
    o.fillStyle = '#000'; o.fillRect(x0, b[0] + gap, x1 - x0 + 1, t);
    return out.toDataURL('image/png');
  };
  const load = (s) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = s; });
  // The rows a print picture has ink in: the blank paper above and below is left off the page
  // (Print spreads a page's lines out over the whole page, so its pictures can be half blank).
  const pixels = (img) => {
    const w = img.width, h = img.height, c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g2 = c.getContext('2d', { willReadFrequently: true });
    g2.drawImage(img, 0, 0);
    const d = g2.getImageData(0, 0, w, h).data, on = (x, y) => { const i = (y * w + x) * 4; return d[i + 3] >= 128 && d[i] < 200; };
    const count = new Int32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) count[y]++;
    return { w, h, on, count };
  };
  const inked = ({ h, count }, from = 0, to = h) => {
    let top = from, bottom = to - 1;
    while (top < to && count[top] <= 1) top++;
    while (bottom > top && count[bottom] <= 1) bottom--;
    return top < to ? [top, bottom + 1] : [from, to];
  };
  // The last line on a page can run on into the top of the next line (Print's cut, carried on by
  // GRAB_JS), and the next page then starts with that line drawn whole. Where a picture ends with
  // the rows the next one starts with, it is cut off there (dropped when it is nothing else).
  const repeats = (a, b) => {
    if (a.px.w !== b.px.w) return -1;
    const ca = a.px.count, cb = b.px.count, [at, ab] = a.ink, [bt, bb] = b.ink;
    for (let t = at; t < ab - 2; t++) {
      const m = ab - t;
      if (m > bb - bt) continue;
      let r = 0;
      for (; r < m; r++) if (Math.abs(ca[t + r] - cb[bt + r]) > 2 + 0.02 * Math.max(ca[t + r], cb[bt + r])) break;
      if (r < m) continue;
      let all = 0, off = 0;
      for (r = 0; r < m; r++) for (let x = 0; x < a.px.w; x += 2) {
        const p = a.px.on(x, t + r), q = b.px.on(x, bt + r);
        if (p || q) { all++; if (p !== q) off++; }
      }
      if (all >= 20 && off <= 0.02 * all) return t;
    }
    return -1;
  };
  const given = async (srcs) => {
    const imgs = await Promise.all(srcs.map(async (s) => { const i = await load(s), m = mend(i); return m === i.src ? i : load(m); }));
    const ps = imgs.map((i) => { const px = pixels(i); return { src: i.src, h: i.height, mm: 191.9 / i.width, ink: inked(px), px }; });
    const parts = [];
    ps.forEach((p, i) => {
      const t = ps[i + 1] ? repeats(p, ps[i + 1]) : -1;
      if (t >= 0) {
        const left = inked(p.px, p.ink[0], t);
        if (left[1] - left[0] < 20) return;
        p.ink = left;
      }
      parts.push(p);
    });
    parts.forEach((p) => delete p.px);
    return { parts, full: false, pictures: 0 };
  };
  const tab = printed ? await given(printed) : await cut(shots);
  if (tab.error) return tab;
  // A take gone wrong (the score not cut into its lines) comes out as one or a few tall pieces,
  // squashed onto a page: the whole song's bars blur together and Fretboard misreads them.
  const tall = tab.parts.filter((p) => p.h * p.mm > 254).length;
  const glitch = !printed && (tall > 0 || (tab.parts.length === 1 && tab.parts[0].h * tab.parts[0].mm > 90));
  // the same score with its music staff (Standard + Tablature): Fretboard reads only the dynamics and
  // the words ("w/sustainer", "let ring") from these pages, which come after a page headed "Notation"
  let more = null;
  if (notesPrinted && notesPrinted.length) more = await given(notesPrinted);
  else if (notes && notes.length) { try { more = await cut(notes); } catch (e) { more = null; } }
  if (more && more.error) more = null;
  // Letter, 12 mm margins: 191.9 x 255.4 mm to fill. The score is set 5 mm in from each side (side): what
  // it has at its very edges (a bar line, the first bar's number) isn't on the page's edge.
  const pageW = 191.9, pageH = 254, side = 5, k = (pageW - 2 * side) / pageW;
  // a picture on the page, with a little paper over and under its ink (a print picture's own
  // blank rows are left off)
  const place = (p) => {
    const w = 191.9 / p.mm;
    const [t, b] = p.ink || [0, p.h], y0 = p.ink ? Math.max(0, t - Math.round(0.02 * w)) : 0, y1 = p.ink ? Math.min(p.h, b + Math.round(0.02 * w)) : p.h;
    const hh = Math.min((y1 - y0) * p.mm * k, pageH);
    const box = document.createElement('div'); box.className = 'pic'; box.style.height = hh + 'mm';
    const el = document.createElement('img'); el.src = p.src; el.style.marginTop = (-y0 * p.mm * k) + 'mm';
    box.append(el);
    return [box, hh];
  };
  document.title = title;
  const st = document.createElement('style');
  st.textContent = '@page{size:letter;margin:12mm}body{margin:0;font-family:Georgia,"Times New Roman",serif;color:#000}'
    + '.pg{height:' + pageH + 'mm;overflow:hidden;break-after:page}.pg:last-child{break-after:auto}'
    + 'h1{font-size:22pt;text-align:center;margin:0 0 1mm;font-weight:normal}.sub{text-align:center;font-size:13pt;margin:0 0 3mm}'
    + '.info{font-size:10pt;margin:0 0 2mm}.pic{overflow:hidden;margin:0 ' + side + 'mm}img{display:block;width:' + (pageW - 2 * side) + 'mm}';
  document.head.append(st);
  let page = document.createElement('div'); page.className = 'pg'; document.body.append(page);
  const head = [['h1', lines[0]], ['p.sub', lines[1]], ['p.info', lines[2]]];
  for (const [t, text] of head) {
    if (!text) continue;
    const [tag, cls] = t.split('.'); const el = document.createElement(tag); if (cls) el.className = cls; el.textContent = text; page.append(el);
  }
  let used = page.lastChild ? (page.lastChild.getBoundingClientRect().bottom - page.getBoundingClientRect().top) * 25.4 / 96 + 2 : 0;  // mm the heading takes
  let pages = 1;
  for (const p of tab.parts) {
    const [el, hh] = place(p);
    if (used + hh > pageH && used > 0) { page = document.createElement('div'); page.className = 'pg'; document.body.append(page); used = 0; pages++; }
    page.append(el); used += hh;
  }
  if (more) {
    page = document.createElement('div'); page.className = 'pg'; document.body.append(page); pages++;
    const el = document.createElement('p'); el.className = 'info'; el.textContent = 'Notation'; page.append(el);
    used = (el.getBoundingClientRect().bottom - page.getBoundingClientRect().top) * 25.4 / 96 + 2;
    for (const p of more.parts) {
      const [el, hh] = place(p);
      if (used + hh > pageH && used > 0) { page = document.createElement('div'); page.className = 'pg'; document.body.append(page); used = 0; pages++; }
      page.append(el); used += hh;
    }
  }
  await Promise.all([...document.images].map((i) => i.decode()));
  return { lines: tab.parts.length, pages, full: tab.full, pictures: tab.pictures, notation: !!more, glitch };
}"""


def shoot(cdp, pg, end=False):
    """The score as a PNG data URL (at the sharp screen's full pixels): its top, or (end) as far
    down as the page scrolls it."""
    try:
        if pg.evaluate(SCROLL_JS, end):
            pg.wait_for_timeout(700)  # redrawn where it scrolled to (steady() checks it's done)
        v = pg.evaluate(VISIBLE_JS)
        if not v or v["h"] < 50:
            raise RuntimeError("Couldn't find the score on the page.")
        pg.wait_for_timeout(150)
        z = v["dpr"] / SHOT_DSF  # the site's own zoom in this Chrome
        shot = cdp.send("Page.captureScreenshot", {"format": "png", "clip": {
            "x": v["x"] * z, "y": v["y"] * z, "width": v["w"] * z, "height": v["h"] * z, "scale": 1}, "optimizeForSpeed": True})  # same pixels, quicker to pack
    finally:
        pg.evaluate(SHOW_JS)
    return "data:image/png;base64," + shot["data"]


def sharp_screen(cdp, pg, height=SHOT_H, dsf=SHOT_DSF):
    cdp.send("Emulation.setDeviceMetricsOverride", {"width": SHOT_W, "height": height, "deviceScaleFactor": dsf, "mobile": False})
    # on once the player has laid itself out for the new screen: its score the same size twice running
    size = "(()=>{const c=document.querySelector('#xtz_canvas');return c?[c.width,c.height,innerWidth].join():''})()"
    last = None
    for _ in range(15):
        pg.wait_for_timeout(200)
        now = pg.evaluate(size)
        if now and now == last and now.endswith(f",{SHOT_W}"):
            break
        last = now


def normal_screen(cdp):
    try:
        cdp.send("Emulation.clearDeviceMetricsOverride")
    except Exception:
        pass


PRESS_JS = r"""([n, k]) => {
  const b = [...document.querySelectorAll('button')].filter((e) => e.textContent.trim() === n)[k];
  if (!b) return false;
  b.click();
  return true;
}"""


# Which track the player shows: its row in Instruments is the one with a shaded background.
# [[name, k], ...] (k: the k-th track of that name); [] when it can't be told.
SHOWN_JS = r"""() => {
  const h = [...document.querySelectorAll('h2')].find((e) => e.innerText.trim() == 'Instruments');
  if (!h) return [];
  const root = h.closest('[class*=ivABo]') || h.parentElement.parentElement;
  const seen = {}, shown = [];
  for (const b of root.querySelectorAll('button')) {
    const t = b.textContent.trim();
    if (!t || ['Pin', 'Unpin', 'C', 'L', 'R', 'S', 'M'].includes(t) || /^\d+%$/.test(t)) continue;
    const k = seen[t] = (seen[t] ?? -1) + 1;
    for (let e = b, i = 0; e && e !== root && i < 4; e = e.parentElement, i++) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) { shown.push([t, k]); break; }
    }
  }
  return shown;
}"""


def showing(pg, n, k=0):
    """True: the player shows track n; False: another one; None: it can't be told (the check is then skipped)."""
    try:
        shown = pg.evaluate(SHOWN_JS)
    except Exception:
        return None
    if len(shown) != 1:
        return None
    return shown[0] == [n, k]


def pick_track(pg, n, k=0):
    """Show track n (the k-th of that name) in the player, as clicking its name in Instruments does."""
    close_popups(pg)
    b = pg.get_by_text(n, exact=True)
    if b.count() > k and b.nth(k).is_visible():
        b.nth(k).click(timeout=8000)
        return
    if not pg.evaluate(PRESS_JS, [n, k]):  # the list folded away: its button pressed all the same
        raise RuntimeError(f"Couldn't find the track {n} in Instruments.")


# UG's Print button draws the shown track one picture per line (PNG data URLs) into a frame of
# its own, then asks Chrome to print the frame (document.execCommand("print")). While a take is
# wanted (__fbWant), that call hands the frame's pictures over instead: no Print window opens,
# and any other Print still prints. The frame's window is reached through the iframe's
# contentWindow, which UG's code reads right before it prints.
GRAB_JS = r"""() => {
  if (!window.__fbHooked) {
    window.__fbHooked = true;
    const take = (d) => { window.__fbImgs = [...d.images].map((i) => i.src).filter((s) => s.startsWith('data:image/')); };
    const patch = (w) => {
      try {
        if (!w || w === window || w.__fbPatched) return;
        w.__fbPatched = true;
        const d = w.document, ex = d.execCommand, pr = w.print;
        d.execCommand = function (c, ...a) {
          if (window.__fbWant && String(c).toLowerCase() === 'print') { window.__fbWant = false; take(w.document); return true; }
          return ex.call(this, c, ...a);
        };
        w.print = function () { if (window.__fbWant) { window.__fbWant = false; take(w.document); return; } return pr.call(w); };
      } catch (e) {}
    };
    const cw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get() { const w = cw.get.call(this); patch(w); return w; } });
  }
  // Print draws the score on its canvas (#canvas_print, as tall as the screen), lays it out in pages
  // of up to 10000 px, and cuts each line out of a copy of it (getImageData, full width). The last
  // line on a page comes out cut through its notes or words, though the canvas has them when it
  // runs on below the page (a screen taller than 5000 px, see PRINT_H). While a take is wanted, a
  // cut that ends on ink is carried on down to the next blank gap, and the line's picture is made
  // tall enough to hold it.
  if (!window.__fbSlices) {
    window.__fbSlices = true;
    const P = CanvasRenderingContext2D.prototype, gi = P.getImageData, pi = P.putImageData;
    P.getImageData = function (x, y, w, h, ...r) {
      const c = this.canvas, end = Math.round(y + h), most = Math.min(c.height, end + Math.round(h)), W = c.width * 4;
      if (!window.__fbWant || x !== 0 || Math.round(w) !== c.width || h < 20 || most - end < 2) return gi.call(this, x, y, w, h, ...r);
      // one read for the line and the rows under it (each read of Print's canvas costs ~0.1 s)
      const top = Math.floor(y), all = gi.call(this, 0, top, c.width, most - top, ...r), d = all.data;
      const ink = (row) => { for (let i = row * W + 3; i < (row + 1) * W; i += 4) if (d[i] > 128 && d[i - 3] < 200) return true; return false; };
      let rows = Math.trunc(h);
      if (ink(end - 1 - top)) {
        let row = end - top, blank = 0;
        for (; row < most - top && blank < 8; row++) blank = ink(row) ? 0 : blank + 1;
        rows = row;
      }
      return new ImageData(new Uint8ClampedArray(d.buffer, 0, rows * W), c.width, rows);
    };
    P.putImageData = function (im, dx, dy, ...r) {
      if (window.__fbWant && !dx && !dy && !r.length && im.height > this.canvas.height) this.canvas.height = im.height;
      return pi.call(this, im, dx, dy, ...r);
    };
  }
  const b = [...document.querySelectorAll('button')].find((e) => e.innerText.trim() == 'Print');
  if (!b) return false;
  window.__fbImgs = null; window.__fbWant = true;
  b.click();
  return true;
}"""


def printed_lines(ui, pg):
    """The shown track, in the player's Notation view now, as UG's own Print draws it: one picture
    per line (PNG data URLs, about 2200 px wide on the sharp screen). About 2 s for tab alone,
    4 s with the music staff. Works with the tab behind others. None when UG has no Print button
    or its print went another way (a Print window that opened anyway is cancelled)."""
    if not pg.evaluate(GRAB_JS):
        return None
    t0 = time.time()
    try:
        while time.time() - t0 < 30:
            hold(ui)
            if pg.evaluate("!!(window.__fbImgs && window.__fbImgs.length)"):
                return pg.evaluate("window.__fbImgs")
            if time.time() - t0 > 2 and print_open():  # printed without the frame's own call
                cancel_print()
                return None
            pg.wait_for_timeout(25)
        return None
    finally:
        pg.evaluate("window.__fbWant = false; window.__fbImgs = null")


def cancel_print():
    """The Print window's own Cancel: that frees the song's tab at once. Playwright's open
    connection never sees a Print window opened after it connected, so a fresh one in its
    own process clicks Cancel (a second connection can't run in this one)."""
    if print_open():
        subprocess.run([sys.executable, "-c", "import ug_collect; ug_collect.close_prints(dialog=False)"],
                       cwd=str(Path(__file__).parent), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)


NOTES_VIEW = "Standard + Tablature"
NO_TAB = re.compile(r"drum|perc|shaker|tambourine|vocal|voice|sing|choir|piano|key|organ|synth(?!\s*bass)|pad|string|violin|cello|horn|sax|trumpet|flute", re.I)


def save_track(ui, ctx, pg, cdp, n, dest, label, lines, k=0, view=None, writer=None):
    """One track: show it, take the score, write the PDF.
    view: [the player's Notation view now, the track before's Print pictures]; kept up to date for the next track.
    writer: a PdfWriter, which writes the PDF while the next track is taken; (None, "", {}) comes back
    at once and the writer reports the outcome. Without it the PDF is written here: (ok, why, res)."""
    view = view if view is not None else ["Tablature", None]
    pick_track(pg, n, k)
    for _ in range(16):  # on as soon as the player shows it (steady() then waits for the drawing)
        if showing(pg, n, k):
            break
        pg.wait_for_timeout(150)
    if showing(pg, n, k) is False:  # something else switched the track: the right one is picked again
        pick_track(pg, n, k)
        pg.wait_for_timeout(2500)
        if showing(pg, n, k) is False:
            raise RuntimeError(f"The player wouldn't show {n}.")
    # the track's tuning, as text under its name: Fretboard reads it to find a bass's 4-line staff
    tuning = pg.evaluate(r"((document.body.innerText.match(/Tuning:\s*([A-G][^\n]*?)\s*(?=Key:|Capo:|\n|$)/) || [])[1] || '').trim()")
    # and its capo: each track has its own (Trust In God: the acoustic guitars 6th fret, the piano none),
    # and the tab's frets count from it
    capo = pg.evaluate(r"((document.body.innerText.match(/Capo:\s*([^\n]*)/) || [])[1] || '').trim()")
    capo = re.sub(r"(?i)^no capo$", "none", capo)
    def steady(end):
        shot, last = None, None
        for _ in range(8):  # drawn when two looks in a row agree
            hold(ui)
            shot = shoot(cdp, pg, end)
            if shot == last:
                break
            last = shot
            pg.wait_for_timeout(400)
        return shot

    def lay_out(shots, notes, printed=None, notes_printed=None):  # what PAGES_JS sets on the pages
        return {"shots": shots, "notes": notes, "printed": printed, "notesPrinted": notes_printed, "title": label,
                "lines": [lines[0], lines[1], "  ·  ".join([n] + ([f"Tuning: {tuning}"] if tuning else [])
                                                     + ([f"Capo: {capo}"] if capo and fretted else []))]}

    fretted = not NO_TAB.search(n)  # by the name: UG shows a Tuning line under every track, drums too
    noted = fretted and NOTATION  # also gets the pages with the music staff

    def shots_pdf():
        front(pg)
        park_chrome(cdp, pg, check=True)
        keep_drawing(cdp, pg)
        sharp_screen(cdp, pg)  # tall: as much of the score in one picture as it takes
        try:
            notes = notes_pages() if noted and view[0] == NOTES_VIEW else None
            if view[0] != "Tablature" and not switch("Tablature"):
                raise RuntimeError("Couldn't switch the player to Tablature.")
            # the score from its top, then scrolled down as far as it goes: a song longer than the screen
            # ends below the first picture (it may end in the gap between two lines, so it's always taken)
            shots = [steady(False), steady(True)]
            if notes is None:
                notes = notes_pages() if noted else []
            if notes == shots:
                notes = []
            pg.evaluate("scrollTo(0, 0)")
            return lay_out(shots, notes)
        finally:
            sharp_screen(cdp, pg, height=PRINT_H)

    def switch(to):
        pg.evaluate("scrollTo(0, 0)")
        if notation(pg, to) is None:
            return False
        view[0] = to
        pg.wait_for_timeout(700)
        return showing(pg, n, k) is not False

    # the same score with its music staff too: only there does the player draw the dynamics (mf, f)
    # and words like "w/sustainer". Fretboard reads just those from these extra pages. A track with
    # no tab staff (vocals, drums, keys) looks the same either way and gets none.
    def notes_pages():
        try:
            if view[0] != NOTES_VIEW and not switch(NOTES_VIEW):
                return []
            return [steady(False), steady(True)]
        except Cancelled:
            raise
        except Exception as err:
            print(f"  (No notation pages for {n}: {str(err).splitlines()[0][:80]})")
            return []

    # UG's own Print pictures: tab view (the notes' lengths), then for a fretted track the view with
    # its music staff (dynamics, words). Each track starts in the view the one before ended in, so
    # the view switches once per track, not twice. No waits: Print draws the new view or track at once.
    def printed(want):
        if view[0] != want:
            if notation(pg, want) is None:
                return None
            view[0] = want
        return printed_lines(ui, pg)
    order = [NOTES_VIEW, "Tablature"] if noted and view[0] == NOTES_VIEW else ["Tablature", NOTES_VIEW]
    got = {}
    for v in ([] if SHOTS else order):
        if v == NOTES_VIEW and not noted:
            continue
        got[v] = printed(v)
        if v == "Tablature" and not got[v]:
            break
    tab, notes = got.get("Tablature"), got.get(NOTES_VIEW) or []
    if tab and tab == view[1] and showing(pg, n, k) is not True:  # still the track before's: once more
        pick_track(pg, n, k)
        tab = printed("Tablature")
    if tab:
        view[1] = tab
        job = lay_out(None, [], tab, notes if notes != tab else [])
    else:
        if not SHOTS:
            print(f"  ({n}: UG's Print gave no pictures; taking pictures of the score instead)")
        job = shots_pdf()
    if showing(pg, n, k) is False:  # the track changed while it was being taken: this picture isn't n
        raise RuntimeError(f"The track changed while {n} was being saved.")
    if writer and tab:
        writer.add(job, dest)
        return None, "", {}
    return write_pdf(job, dest)


class Cdp:
    """One DevTools target over a websocket of its own (standard library only). Playwright's sync API
    serves one thing at a time, so the PDFs are written over this, in a thread beside it."""
    def __init__(self, url, timeout=120):
        import socket
        u = urllib.parse.urlparse(url)
        self.s = socket.create_connection((u.hostname, u.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            c = self.s.recv(65536)
            if not c:
                raise ConnectionError("DevTools closed the connection")
            self.buf += c
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError("DevTools refused the connection")
        self.id = 0

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.s.close()

    def _need(self, n):
        while len(self.buf) < n:
            c = self.s.recv(1 << 20)
            if not c:
                raise ConnectionError("DevTools closed the connection")
            self.buf += c

    def _frame(self):
        self._need(2)
        fin, op, n, o = self.buf[0] & 0x80, self.buf[0] & 0x0F, self.buf[1] & 0x7F, 2
        if n == 126:
            self._need(4); n = int.from_bytes(self.buf[2:4], "big"); o = 4
        elif n == 127:
            self._need(10); n = int.from_bytes(self.buf[2:10], "big"); o = 10
        self._need(o + n)
        data, self.buf = self.buf[o:o + n], self.buf[o + n:]
        return fin, op, data

    def send(self, method, params=None):
        self.id += 1
        msg = json.dumps({"id": self.id, "method": method, "params": params or {}}).encode()
        n, mask = len(msg), os.urandom(4)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + n.to_bytes(2, "big") if n < 65536
                                else bytes([0xFF]) + n.to_bytes(8, "big"))
        keys = (mask * (n // 4 + 1))[:n]  # masked all at once, as one big number (a byte loop takes seconds)
        self.s.sendall(head + mask + (int.from_bytes(msg, "big") ^ int.from_bytes(keys, "big")).to_bytes(n, "big"))
        while True:
            parts = []
            while True:
                fin, op, data = self._frame()
                if op == 8:
                    raise ConnectionError("DevTools closed the connection")
                if op in (0, 1, 2):
                    parts.append(data)
                if fin and op in (0, 1, 2):
                    break
            r = json.loads(b"".join(parts))
            if r.get("id") == self.id:
                if "error" in r:
                    raise RuntimeError(f"{method}: {r['error'].get('message', r['error'])}")
                return r.get("result", {})


def write_pdf(job, dest):
    """One track's PDF: PAGES_JS sets its pictures on Letter pages in a background tab of this Chrome,
    which writes them to the PDF (no Print or Save As window). (ok, why, res)"""
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=5) as r:
        browser = json.load(r)["webSocketDebuggerUrl"]
    with Cdp(browser) as b:
        tid = b.send("Target.createTarget", {"url": "about:blank", "background": True})["targetId"]
        try:
            with Cdp(f"ws://127.0.0.1:{PORT}/devtools/page/{tid}") as c:
                r = c.send("Runtime.evaluate", {"expression": f"({PAGES_JS})({json.dumps(job)})", "awaitPromise": True, "returnByValue": True})
                if r.get("exceptionDetails"):
                    return False, "the pages couldn't be laid out", {}
                res = r["result"]["value"]
                if res.get("error"):
                    return False, res["error"], res
                if res.get("glitch"):  # the pictures came out jumbled: the whole track is tried again (work())
                    return False, "the pictures came out jumbled", res
                pdf = c.send("Page.printToPDF", {"preferCSSPageSize": True, "printBackground": True})
        finally:
            try:
                b.send("Target.closeTarget", {"targetId": tid})
            except Exception:
                pass
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(base64.b64decode(pdf["data"]))
    if dest.exists():  # appeared meanwhile: never replaced
        tmp.unlink()
        return False, "a file with that name appeared", res
    tmp.rename(dest)
    return True, "", res


class PdfWriter:
    """Writes the tracks' PDFs one after another in a thread of its own while the next track is taken
    (setting one on pages and writing it takes 1 to 4 s, about as long as taking a track).
    done(dest, ok, why, res) is called from that thread when each one is written."""
    def __init__(self, done):
        from concurrent.futures import ThreadPoolExecutor
        self.pool, self.done, self.jobs = ThreadPoolExecutor(1), done, []

    def add(self, job, dest):
        self.jobs.append(self.pool.submit(self._write, job, dest))

    def _write(self, job, dest):
        try:
            r = write_pdf(job, dest)
        except Exception as err:
            r = (False, str(err).splitlines()[0][:120], {})
        try:
            self.done(dest, *r)
        except Exception as err:
            print(f"  ({dest.name}: {err})")

    def finish(self):
        """Waits until every PDF handed over is written."""
        for f in self.jobs:
            f.result()
        self.jobs = []


def save_gp(pg, out, stem):
    """Click the page's own Download button, the file going into a fresh folder inside the song
    folder; then it's moved to its name (never over an existing file) and that folder removed.
    Chrome's download setting is put back afterwards."""
    tmp = free_name(out, ".download", "")
    tmp.mkdir(parents=True)
    cdp = pg.context.browser.new_browser_cdp_session()
    try:
        cdp.send("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(tmp)})
        btn = None
        for _ in range(40):  # the button can show up a few seconds after the page
            btn = gp_button(pg)
            if btn:
                break
            time.sleep(0.25)
        if not btn:
            return None
        btn.click(timeout=5000)
        got = None
        for _ in range(120):  # up to a minute
            files = [f for f in tmp.iterdir() if f.is_file()]
            done = [f for f in files if not f.name.endswith((".crdownload", ".tmp"))]
            if done and len(done) == len(files):
                got = done[0]
                break
            time.sleep(0.5)
        if not got:
            return None
        ext = got.suffix.lower() if re.fullmatch(r"\.gp\w*", got.suffix.lower()) else ".gp"
        dest = free_name(out, stem, ext)
        got.rename(dest)
        return dest
    finally:
        try:
            cdp.send("Browser.setDownloadBehavior", {"behavior": "default"})
        except Exception:
            pass
        for f in (tmp.iterdir() if tmp.exists() else []):
            try:
                f.unlink()
            except OSError:
                pass
        try:
            tmp.rmdir()
        except OSError:
            pass


def save_single(ui, a, result, pg, kind, label, key="", url=None, chords=None, what=None):
    """A chord sheet / plain tab (as text) or a Guitar Pro tab (its download): one file.
    An official song's Guitar Pro version comes here too, with the official page's key and chords."""
    song, artist = song_name(pg)
    url = url or a.url
    info = page_text(pg) if kind == "text" else {}
    if kind == "text" and not info.get("text", "").strip():
        raise RuntimeError("Couldn't find the tab's text on this page. Wait until it has loaded and open it again.")
    key = key or (info.get("key") or "").replace("\u266d", "b").replace("\u266f", "#")
    out = (Path(a.out) if a.out else song_folder(a.root, song, artist, key)).resolve()
    what = what or (f"Save this {label.lower()} sheet as a text file?" if kind == "text"
                    else "Save this Guitar Pro tab with the page's Download button?")
    names = [label] if a.yes or a.auto_official else ui.ask({"song": song, "artist": artist, "key": key, "names": [label], "out": str(out), "what": what,
                                          **({"again": True} if a.again else {}),
                                          "note": "One file, saved in a few seconds. Then Fretboard's library offers it (Review & create)."})
    if not names:
        result["code"] = SKIPPED
        ui.finish(f"Skipped {song}. Nothing was saved.")
        return
    stem = " - ".join(x for x in (song, artist, label) if x)
    run = ui.run_obj = Run(out, a.root, set_latest=not a.out)
    report = getattr(ui, "report", None) or Report(url)
    try:
        run.start()
        report.song(song, artist, out, [label], "saving")
        ui.progress(0, 1, label)
        hold(ui)
        if kind == "text":
            head = " · ".join(x for x in (label, info["key"] and f"Key: {info['key']}", info["capo"] and f"Capo: {info['capo']}",
                                          info["tuning"] and f"Tuning: {info['tuning']}") if x)
            dest = free_name(out, stem, ".txt")
            dest.write_text(f"{song} - {artist}\n{head}\nFrom: {url}\n\n{info['text'].rstrip()}\n", encoding="utf-8")
            run.files.append(dest)
        else:  # straight into the folder (no Save As window), so it needn't wait for the mouse
            dest = save_gp(pg, out, stem)
            if not dest:
                raise RuntimeError("The download didn't arrive (the page may need you to be logged in). Nothing was kept.")
            run.files.append(dest)
        hold(ui)
        replace = a.again and getattr(ui, "mode", "") == "replace"
        extra = {}
        video = page_video(pg)
        if kind == "text":  # the strumming pattern (with its bpm) and the Video panel's video, for perform mode
            strum = page_strum(pg)
            if strum:
                extra["strum"] = strum
            video = video or panel_video(pg)
        if kind == "gp":  # its chords over the words, from the song's Chords page
            ui.progress(0, 1, "chords")
            text, v2 = (chords, "") if chords else search_chords(pg.context, song, artist)
            hold(ui)
            name = save_chords(out, song, artist, text, run, replace)
            if name:
                extra["chords"] = name
            video = video or v2
        if video:
            extra["video"] = video
        man = free_name(out, "fretboard-run-" + label.lower().replace(" ", "-"), ".json")
        if replace:
            name = take_place(dest, out / f"{stem}{dest.suffix}")
            dest = out / name
            man = out / ("fretboard-run-" + label.lower().replace(" ", "-") + ".json")
        write_manifest(out, man.name, {"song": song, "artist": artist, "key": key, "url": url, "kind": kind,
                                       "tracks": [{"name": label, "file": dest.name}], "missing": [], **extra, **({"replace": True} if replace else {})})
        run.files.append(man)
        report.track(0, "saved", "", dest.name)
    except Cancelled:
        if getattr(ui, "aborted", False):  # the window's watchdog already tidied up
            if ui.code == CANCELLED:
                run.undo()
            return
        run.undo()
        result["code"] = CANCELLED
        ui.finish("Cancelled. Nothing from this run was kept.")
        return
    except Exception:
        if not getattr(ui, "aborted", False) or ui.code == CANCELLED:
            run.undo()
        raise
    ui.progress(1, 1, "done", 0)
    result["code"] = DONE
    text = f"Saved {dest.name} into\n{out}\n\nNext: Fretboard's library offers it (Review & create)."
    print(text)
    ui.finish(text, out)


def work(ui, a, result):
    from playwright.sync_api import sync_playwright
    run = p = None
    rep = ui.report = Report(a.url)
    try:
        close_prints()
        p = sync_playwright().start()  # one connection for the whole run (each new one costs ~0.4 s)
        ctx = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}").contexts[0]
        pg = song_page(ctx, a.url)
        watch_popups(pg)
        close_popups(pg)
        if "login" in pg.url.lower():
            raise RuntimeError("Not logged in: log in to UG Pro in that Chrome window and open the song again.")
        wait_player(ui, pg)
        kind, label = page_kind(pg)
        if kind != "official":
            save_single(ui, a, result, pg, kind, label)
            rep.end({DONE: "done", SKIPPED: "cancelled", CANCELLED: "cancelled"}.get(result["code"], "failed"))
            return
        open_instruments(pg)
        names = track_names(pg)
        song, artist = song_name(pg)
        has_chords = pg.get_by_role("button", name="Chords", exact=True).count() > 0
        # original key from the "Tuning: ... · Key: Bb · Capo: ..." line
        km = re.search(r"Key:\s*([A-G][#b♭♯]?m?)", pg.evaluate("document.body.innerText"))
        key = km.group(1).replace("♭", "b").replace("♯", "#") if km else ""
        # --gp: its Guitar Pro version instead of the PDFs, when UG has one
        if not a.only.strip() and a.gp:
            gp_url = official_gp(pg) or search_gp(ctx, song, artist)
            if gp_url:
                done = official_as_gp(ui, a, result, ctx, pg, gp_url, song, key, len(names))
                if done:
                    return
                print("  (The Guitar Pro version has no Download button: saving the PDFs instead.)")
        if not names:  # a box over the page (UG's rating) hides the list: closed, and read once more
            close_popups(pg)
            open_instruments(pg)
            names = track_names(pg)
        if not names:
            raise RuntimeError("Couldn't read the Instruments list. Open the song's player page, show the Instruments panel, and try again.")
        every = list(names)  # all the song's tracks (a replaced song keeps the ones not saved again)
        only = [s.strip().lower() for s in a.only.split(",") if s.strip()]
        if only:
            names = [x for x in names if x.lower() in only]
        out = (Path(a.out) if a.out else song_folder(a.root, song, artist, key)).resolve()
        names = names if a.yes or a.auto_official else ui.ask({"song": song, "artist": artist, "key": key, "names": names, "out": str(out),
                                                              **({"again": True} if a.again else {})})
        replace = a.again and getattr(ui, "mode", "") == "replace"
        if not names:
            result["code"] = SKIPPED
            ui.finish(f"Skipped {song}. Nothing was saved.")
            return
        run = ui.run_obj = Run(out, a.root, set_latest=not a.out)
        run.start()
        rep.song(song, artist, out, names)
        saved, missing, took = [], [], []
        chords = {}
        if a.add:  # a retry of some tracks: the song's chords and video are there already
            has_chords = True

        def find_chords():  # in a connection of its own: the run's can't be used from another thread
            try:
                with sync_playwright() as p2:
                    chords["found"] = search_chords(p2.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}").contexts[0], song, artist)
            except Exception:
                pass
        hunt = None if has_chords else threading.Thread(target=find_chords, daemon=True)
        if hunt:
            hunt.start()
        pg = song_page(ctx, a.url)
        cdp = ctx.new_cdp_session(pg)
        park_chrome(cdp, pg)
        was = None
        view = [None, None]
        done, writing, lock = {}, {}, threading.Lock()  # track i: its outcome / its PDF being written

        def written(dest, ok, why, res):  # from the writer's thread
            i, n = writing[dest]
            with lock:
                if dest.exists() and dest not in run.files:
                    run.files.append(dest)
                done[i] = (ok, why, dest, res)
            print(f"  {dest.name}: saved ({res.get('pages')} pages)" if ok else f"  {dest.name}: NOT saved ({why})")
            rep.track(i, "saved" if ok else "failed", why, dest.name if ok else "")
        writer = run.writer = PdfWriter(written)
        try:
            sharp_screen(cdp, pg, height=PRINT_H)
            was = notation(pg)
            view[0] = {"St. + Tab": NOTES_VIEW}.get(was, was)
            open_instruments(pg)

            def take(i, n, attempt, w, step):
                label = f"{song} - {artist} - {n}" if artist else f"{song} - {n}"
                dest = free_name(out, label, ".pdf", writing)  # an existing file is never replaced
                run.pending = dest
                eta = (sum(took) / len(took) if took else SECONDS_PER_TRACK) * (len(names) - step)
                hold(ui)
                ui.progress(step, len(names), n, eta, "" if attempt == 1 else "Trying this track again.")
                t0 = time.time()
                writing[dest] = (i, n)
                rep.track(i, "saving")
                try:
                    ok, why, res = save_track(ui, ctx, pg, cdp, n, dest, label, (song, artist), names[:i].count(n), view, w)
                except Cancelled:
                    raise
                except Exception as err:
                    ok, why, res = False, str(err).splitlines()[0][:120], {}
                finally:
                    if dest.exists() and dest not in run.files:
                        run.files.append(dest)
                took.append(time.time() - t0 + a.gap)
                if ok is not None:  # written here (not by the writer)
                    done[i] = (ok, why, dest, res)
                    print(f"  {dest.name}: saved ({res.get('pages')} pages)" if ok else f"  {dest.name}: NOT saved ({why})")
                    rep.track(i, "saved" if ok else "failed", why, dest.name if ok else "")

            # the tracks without tab first, then the fretted ones: each of those needs both views, so
            # taken in this order the player's view changes once per fretted track and no more
            order = sorted(range(len(names)), key=lambda i: not NO_TAB.search(names[i]))
            for step, i in enumerate(order):
                take(i, names[i], 1, writer, step)
                if step + 1 < len(names):
                    end = time.time() + a.gap  # unhurried pace
                    while time.time() < end:
                        hold(ui)
                        time.sleep(0.25)
            hold(ui)
            ui.progress(len(names), len(names), "chords", 0)
            chords_text = official_chords(pg) if has_chords and not a.add else ""  # while the last PDFs are written
            writer.finish()
            for i, n in enumerate(names):  # a track that didn't save is tried once more
                if not done.get(i, (False,))[0]:
                    writing.pop(done.get(i, (0, 0, None))[2], None)  # its name is free again
                    take(i, n, 2, None, i)
            for i, n in enumerate(names):
                ok, why, dest, res = done.get(i, (False, "", None, {}))
                if ok:
                    saved.append({"name": n, "file": dest.name})
                    if res.get("full"):
                        print(f"  {dest.name}: the song is very long; its end may be missing")
                else:
                    missing.append(n)
        finally:
            normal_screen(cdp)  # the song's tab back as it was
            back = {"St. + Tab": NOTES_VIEW}.get(was, was)
            if was and back != view[0]:  # the player's own notation choice back
                notation(pg, back)
        video = page_video(pg)
        if not chords_text and not a.add:
            if hunt:
                hunt.join()
            chords_text, v2 = chords.get("found") or search_chords(ctx, song, artist)
            video = video or v2
        hold(ui)
        ui.progress(len(names), len(names), "done", 0)
        if replace:  # everything saved: only now do the new files take the old ones' place
            placed = set()
            for s in saved:
                if s["name"] in placed:  # a second track of the same name keeps its own file
                    continue
                placed.add(s["name"])
                s["file"] = take_place(out / s["file"], base_pdf(out, song, artist, s["name"]))
            # the tracks not saved again stay in the song as they were
            saved += [{"name": n, "file": base_pdf(out, song, artist, n).name} for n in dict.fromkeys(every)
                      if n not in placed and base_pdf(out, song, artist, n).exists()]
        extra = {"order": every}
        if a.add:  # a retry: into the song's list, in the song's own track order (the first part sets the bar count)
            saved, missing, old = merge_run(out, saved, missing, every)
            extra = {**old, **extra}
        try:
            name = save_chords(out, song, artist, chords_text, run, replace)
            if name:
                extra["chords"] = name
        except OSError as err:
            print(f"  (Chords not saved: {err})")
        if video:
            extra["video"] = video
        write_manifest(out, "fretboard-run.json", {"song": song, "artist": artist, "key": key, "url": a.url,
                                                    "tracks": saved, "missing": missing, **extra, **({"replace": True} if replace else {})})
        result["code"] = DONE if saved else FAILED
        rep.end("held" if missing else "done", f"{len(missing)} not saved" if missing else "")
        text = (f"Done: saved {len(saved)} of {len(names)} tracks of {song} into\n{out}"
                + (f"\n\nNot saved: {', '.join(missing)} (open the song again later to fetch them)." if missing else "")
                + "\n\nNext, in Fretboard: Import files (it opens in this folder), select all, check the tracks, Create song.")
        print(text)
        ui.finish(text, out)
    except Cancelled:
        if getattr(ui, "aborted", False):  # the window's watchdog already tidied up
            if run and ui.code == CANCELLED:
                run.undo()
            return
        close_prints()
        if run and getattr(run, "writer", None):
            run.writer.finish()  # the PDFs being written are done, so they can go too
        if run:
            p = getattr(run, "pending", None)  # the track being saved: its half-written copy goes too
            if p:
                part = p.with_name(p.name + ".part")
                if part.exists():
                    part.unlink()
                if p.exists() and p not in run.files:
                    run.files.append(p)
            run.undo()
        result["code"] = CANCELLED
        rep.end("cancelled")
        print("Cancelled: everything this run saved was removed.")
        ui.finish("Cancelled. Everything this run saved was removed; your other files weren't touched.")
    except Exception as err:
        if getattr(ui, "aborted", False):
            if run and ui.code == CANCELLED:
                run.undo()
            return
        result["code"] = FAILED
        rep.end("failed", str(err).splitlines()[0][:200])
        print(f"Failed: {err}")
        try:
            close_prints()
        except Exception:
            pass
        ui.finish(f"Something went wrong, so it stopped:\n{err}\n\nFiles already saved were kept.", run.out if run else None)
    finally:
        if p:
            try:
                p.stop()
            except Exception:
                pass
        tidy_tabs(a.url)


# A script's save (tests/yt2gp5/fromlink.py) claims its song here; the UG helper (ug_watch.py) skips a claimed song.
# Two saves of one song in one Chrome switch each other's tracks ("The track changed while ... was saved").
CLAIM = Path.home() / ".fretboard" / "ug-claim.json"


def main():
    global PORT, NOTATION, SHOTS
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default="", help="exact folder to save into")
    ap.add_argument("--root", default=str(Path.home() / "Downloads" / "UG Songs"), help="parent of the per-song folders")
    ap.add_argument("--gap", type=float, default=0, help="extra seconds between tracks (switching tracks asks nothing of UG's servers, and each track already takes several seconds)")
    ap.add_argument("--no-ui", action="store_true", help="no windows: ask nothing, report in the console")
    ap.add_argument("--yes", action="store_true", help="start without asking which tracks")
    ap.add_argument("--again", action="store_true", help="saved before: ask whether to replace it or save a new copy")
    ap.add_argument("--notation", action="store_true", help="fretted tracks: also the pages with the music staff (dynamics, words); a slower save")
    ap.add_argument("--add", action="store_true", help="with --only and --out: a retry, the tracks go into the song's fretboard-run.json")
    ap.add_argument("--shots", action="store_true", help="pictures of the score instead of UG's Print (the other way, for a retry)")
    ap.add_argument("--gp", action="store_true", help="official songs: their Guitar Pro version instead of the PDFs, when UG has one")
    ap.add_argument("--auto-official", action="store_true", help="Official / Pro songs and Guitar Pro tabs: save without asking (chords and plain tabs still ask)")
    ap.add_argument("--claim", action="store_true", help="a script's save: the UG helper leaves this song alone while it runs (CLAIM)")
    a = ap.parse_args()
    if a.claim:  # before the song's tab opens, so the helper never starts a second save of it
        CLAIM.parent.mkdir(parents=True, exist_ok=True)
        CLAIM.write_text(json.dumps({"url": a.url.split("?")[0].split("#")[0], "pid": os.getpid(), "time": time.time()}), encoding="utf-8")
        import atexit
        atexit.register(lambda: CLAIM.unlink(missing_ok=True))
    PORT = a.port
    NOTATION = a.notation
    SHOTS = a.shots
    CANCEL_FLAG.unlink(missing_ok=True)
    result = {"code": FAILED}
    ui = None
    if not a.no_ui:
        try:
            ui = TkUI()
        except Exception as err:  # no display / no Tk: carry on in the console
            print(f"(no windows: {err})")
    if ui:
        ui.run(lambda: work(ui, a, result))
        if ui.aborted:  # the work is still stuck on Chrome: end here (Chrome drops this run's screen size itself)
            sys.stdout.flush()
            os._exit(ui.code)
    else:
        work(ConsoleUI(), a, result)
    sys.exit(result["code"])


if __name__ == "__main__":
    main()
