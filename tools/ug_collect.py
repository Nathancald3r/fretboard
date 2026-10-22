"""Save every instrument/vocal track of an official Ultimate Guitar Tab Pro song as a PDF,
one per track, named "<Song> - <Artist> - <Instrument>.pdf", into
Downloads\\UG Songs\\<Song> - <Artist> (Key X).

Other UG pages work too, one file each into the same song folder:
  chords and plain tabs   the text shown on the page -> "<Song> - <Artist> - Chords.txt" (or Tab, Bass Tab...)
  Guitar Pro tabs          the page's own "Download (gp)" button -> "<Song> - <Artist> - Guitar Pro.gp"

A small window first shows the song and its tracks (untick any you don't want, then Start or
Skip). While it saves, a window stays on top with the progress and a Cancel button; the computer
can be used meanwhile. Cancel stops it and removes everything this run saved, so nothing is left
half done. Your login is never touched.

Each track's PDF is the score as UG's player shows it (sharp, every lyric complete) set on A4
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
import argparse, base64, ctypes, json, os, queue, re, subprocess, sys, threading, time, urllib.request
from datetime import datetime
from pathlib import Path

PORT = 9222
DIALOG = Path(__file__).with_name("ug_save_dialog.ps1")
DONE, FAILED, SKIPPED, CANCELLED = 0, 1, 2, 3
SECONDS_PER_TRACK = 14  # first guess for the time left; then measured


class Cancelled(Exception):
    pass


def hold(ui):
    """Waits here while the run is paused; stops the run when it's cancelled."""
    paused = getattr(ui, "paused", None)
    ui.beat = time.time()  # still going (the window's watchdog looks at this)
    while paused is not None and paused.is_set() and not ui.cancel.is_set():
        ui.beat = time.time()
        time.sleep(0.25)
    if ui.cancel.is_set():
        raise Cancelled


def park_chrome(cdp, pg):
    """Moves the collector Chrome off the screen while it works, so it doesn't sit in front of you.
    A Chrome the helper didn't start stops drawing out of sight: that one is brought back."""
    try:
        from ug_watch import hide_window, show_window
        hide_window(cdp)
        pg.wait_for_timeout(800)
        if pg.evaluate("document.visibilityState") != "visible":
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
    with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=5) as r:
        return json.load(r)


def print_open():
    return any(t["url"].startswith("chrome://print") for t in targets())


def close_prints(ctx=None):
    """Shut any Print window with its own Cancel button: that frees the song's tab again
    (just closing it would leave the tab stuck). A Save As dialog left open is cancelled too.
    Never fails: with Chrome closed there's nothing to shut, and a Cancel still tidies up."""
    try:
        _close_prints()
    except Exception:
        pass


def _close_prints():
    if DIALOG.exists():
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(DIALOG), "-CancelAll"],
                       capture_output=True, text=True)
    if not print_open():
        return
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        c = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
        for pr in [x for x in c.pages if x.url.startswith("chrome://print")]:
            try:
                pr.locator("cr-button.cancel-button").first.click(no_wait_after=True, timeout=4000)
            except Exception:
                pass
    for _ in range(10):
        if not print_open():
            return
        time.sleep(0.5)
    for t in targets():  # last resort: close the Print window itself (never the song's tab)
        if t["url"].startswith("chrome://print") and t["type"] == "page":
            urllib.request.urlopen(f"http://localhost:{PORT}/json/close/{t['id']}", timeout=5).read()


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
    pg.wait_for_timeout(4000)
    front(pg)
    return pg


def front(pg):
    """The song's tab to the front of its window: Chrome only draws (and so only takes pictures of)
    the tab in front; a picture of a tab behind others never arrives. The window is parked out of
    sight again straight after (park_chrome)."""
    try:
        pg.bring_to_front()
        pg.wait_for_timeout(500)
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
            park_chrome(cdp, pg)
    except Exception:
        pass


def open_instruments(pg):
    """Show the player's Instruments panel (track list) if it's folded away."""
    for _ in range(3):
        shown = pg.evaluate("""()=>{const h=[...document.querySelectorAll('h2')].find(e=>e.innerText.trim()=='Instruments');
          if(h&&h.getBoundingClientRect().width>0&&h.closest('[aria-hidden=true]')==null)return true;
          return false}""")
        if shown:
            return
        try:
            pg.locator('[class*=_0kBTe]').first.click(timeout=3000)  # the |<- tab at the score's right edge
        except Exception:
            pass
        pg.wait_for_timeout(1200)


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
    if "-official-" in url or "-pro-" in url:  # Official and Pro songs: a PDF per instrument
        return "official", ""
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


def official_chords(pg):
    """An official song's Chords view: its chords over the words, in the song's own order. "" when it has none."""
    try:
        b = pg.get_by_role("button", name="Chords", exact=True)
        if not b.count():
            return ""
        b.first.click(timeout=5000)
        text = ""
        for _ in range(16):
            pg.wait_for_timeout(500)
            text = pg.evaluate("()=>[...document.querySelectorAll('pre')].filter(p=>p.offsetParent!==null).map(p=>p.innerText).join('\n').trim()")
            if text:
                break
        return text.replace("\r\n", "\n")
    except Exception:
        return ""
    finally:
        try:
            pg.get_by_role("button", name="Tab", exact=True).first.click(timeout=5000)
            pg.wait_for_timeout(800)
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
    for _ in range(20):
        url = pg.evaluate(CHORDS_JS, [q, type])
        if url is not None:
            break
        pg.wait_for_timeout(500)
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
            urllib.request.urlopen(f"http://localhost:{PORT}/json/close/{t['id']}", timeout=5).read()
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
        for _ in range(20):
            pg.wait_for_timeout(500)
            info = page_text(pg)
            if info.get("text", "").strip():
                break
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


def free_name(folder, stem, ext):
    """<stem><ext>, or "<stem> (2)<ext>"... when that's taken: nothing is ever replaced."""
    dest, k = folder / f"{stem}{ext}", 2
    while dest.exists():
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


# ---------- an official track as a PDF: the score as UG shows it, laid out on A4 ----------
# UG's own Print cuts the lyrics off the last line of each of its pages (whatever the zoom), so the
# score is taken from the player itself instead: drawn on a tall, sharp screen (2x pixels), cut
# into lines between the gaps (a line keeps its name, bar numbers and lyrics), and set on A4 pages,
# which this Chrome writes to the PDF straight away (no Print or Save As window).

SHOT_W, SHOT_H, SHOT_DSF = 1536, 7000, 2

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
SHOW_JS = r"""()=>{ for (const [e, v] of (window.__fbHidden || []).reverse()) e.style.visibility = v; window.__fbHidden = []; }"""

PAGES_JS = r"""async ({ shot, title, lines }) => {
  const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = shot; });
  const w = img.width, h = img.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
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
    return { src: k.toDataURL('image/png'), h: e - s };
  });
  // A4, 12 mm margins: 186 x 273 mm to fill
  const pageW = 186, pageH = 272, mm = pageW / (x1 - x0);
  document.title = title;
  const st = document.createElement('style');
  st.textContent = '@page{size:A4;margin:12mm}body{margin:0;font-family:Georgia,"Times New Roman",serif;color:#000}'
    + '.pg{height:' + pageH + 'mm;overflow:hidden;break-after:page}.pg:last-child{break-after:auto}'
    + 'h1{font-size:22pt;text-align:center;margin:0 0 1mm;font-weight:normal}.sub{text-align:center;font-size:13pt;margin:0 0 3mm}'
    + '.info{font-size:10pt;margin:0 0 2mm}img{display:block;width:' + pageW + 'mm}';
  document.head.append(st);
  let page = document.createElement('div'); page.className = 'pg'; document.body.append(page);
  const head = [['h1', lines[0]], ['p.sub', lines[1]], ['p.info', lines[2]]];
  for (const [t, text] of head) {
    if (!text) continue;
    const [tag, cls] = t.split('.'); const el = document.createElement(tag); if (cls) el.className = cls; el.textContent = text; page.append(el);
  }
  let used = page.lastChild ? (page.lastChild.getBoundingClientRect().bottom - page.getBoundingClientRect().top) * 25.4 / 96 + 2 : 0;  // mm the heading takes
  let pages = 1;
  for (const p of parts) {
    const hh = Math.min(p.h * mm, pageH);
    if (used + hh > pageH && used > 0) { page = document.createElement('div'); page.className = 'pg'; document.body.append(page); used = 0; pages++; }
    const el = document.createElement('img'); el.src = p.src; el.style.height = hh + 'mm'; page.append(el); used += hh;
  }
  await Promise.all([...document.images].map((i) => i.decode()));
  return { lines: parts.length, pages, full: last >= h - 3 };
}"""


def shoot(cdp, pg):
    """The score as it shows now, as a PNG data URL (at the sharp screen's full pixels)."""
    try:
        v = pg.evaluate(VISIBLE_JS)
        if not v or v["h"] < 50:
            raise RuntimeError("Couldn't find the score on the page.")
        pg.wait_for_timeout(300)
        z = v["dpr"] / SHOT_DSF  # the site's own zoom in this Chrome
        shot = cdp.send("Page.captureScreenshot", {"format": "png", "clip": {
            "x": v["x"] * z, "y": v["y"] * z, "width": v["w"] * z, "height": v["h"] * z, "scale": 1}, "optimizeForSpeed": True})  # same pixels, quicker to pack
    finally:
        pg.evaluate(SHOW_JS)
    return "data:image/png;base64," + shot["data"]


def sharp_screen(cdp, pg, height=SHOT_H, dsf=SHOT_DSF):
    cdp.send("Emulation.setDeviceMetricsOverride", {"width": SHOT_W, "height": height, "deviceScaleFactor": dsf, "mobile": False})
    pg.wait_for_timeout(3000)


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
    b = pg.get_by_text(n, exact=True)
    if b.count() > k and b.nth(k).is_visible():
        b.nth(k).click(timeout=8000)
        return
    if not pg.evaluate(PRESS_JS, [n, k]):  # the list folded away: its button pressed all the same
        raise RuntimeError(f"Couldn't find the track {n} in Instruments.")


def save_track(ui, ctx, pg, cdp, n, dest, label, lines, k=0):
    """One track: show it, take the score once it has stopped changing, write the PDF."""
    pick_track(pg, n, k)
    pg.wait_for_timeout(2500)
    if showing(pg, n, k) is False:  # something else switched the track: the right one is picked again
        pick_track(pg, n, k)
        pg.wait_for_timeout(2500)
        if showing(pg, n, k) is False:
            raise RuntimeError(f"The player wouldn't show {n}.")
    # the track's tuning, as text under its name: Fretboard reads it to find a bass's 4-line staff
    tuning = pg.evaluate(r"((document.body.innerText.match(/Tuning:\s*([A-G][^\n]*?)\s*(?=Key:|Capo:|\n|$)/) || [])[1] || '').trim()")
    shot, last = None, None
    for _ in range(8):  # drawn when two looks in a row agree
        hold(ui)
        shot = shoot(cdp, pg)
        if shot == last:
            break
        last = shot
        pg.wait_for_timeout(1000)
    if showing(pg, n, k) is False:  # the track changed while it was being taken: this picture isn't n
        raise RuntimeError(f"The track changed while {n} was being saved.")
    out = ctx.new_page()
    try:
        res = out.evaluate(PAGES_JS, {"shot": shot, "title": label, "lines": [lines[0], lines[1], f"{n}  ·  Tuning: {tuning}" if tuning else n]})
        if res.get("error"):
            return False, res["error"], res
        hold(ui)
        pdf = ctx.new_cdp_session(out).send("Page.printToPDF", {"preferCSSPageSize": True, "printBackground": True})
    finally:
        out.close()
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(base64.b64decode(pdf["data"]))
    if dest.exists():  # appeared meanwhile: never replaced
        tmp.unlink()
        return False, "a file with that name appeared", res
    tmp.rename(dest)
    return True, "", res


def save_gp(pg, out, stem):
    """Click the page's own Download button, the file going into a fresh folder inside the song
    folder; then it's moved to its name (never over an existing file) and that folder removed.
    Chrome's download setting is put back afterwards."""
    tmp = free_name(out, ".download", "")
    tmp.mkdir(parents=True)
    cdp = pg.context.browser.new_browser_cdp_session()
    try:
        cdp.send("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(tmp)})
        gp_button(pg).click(timeout=5000)
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
    try:
        run.start()
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
    run = None
    try:
        close_prints()
        with sync_playwright() as p:
            ctx = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
            pg = song_page(ctx, a.url)
            if "login" in pg.url.lower():
                raise RuntimeError("Not logged in: log in to UG Pro in that Chrome window and open the song again.")
            kind, label = page_kind(pg)
            if kind != "official":
                return save_single(ui, a, result, pg, kind, label)
            open_instruments(pg)
            names = track_names(pg)
            song, artist = song_name(pg)
            # original key from the "Tuning: ... · Key: Bb · Capo: ..." line
            km = re.search(r"Key:\s*([A-G][#b♭♯]?m?)", pg.evaluate("document.body.innerText"))
            key = km.group(1).replace("♭", "b").replace("♯", "#") if km else ""
            # its Guitar Pro version first: a real score (every note, rhythm and track as written),
            # where PDFs of the official player come out as pictures to read back
            if not a.only.strip() and not a.pdfs:
                gp_url = official_gp(pg) or search_gp(ctx, song, artist)
                if gp_url:
                    done = official_as_gp(ui, a, result, ctx, pg, gp_url, song, key, len(names))
                    if done:
                        return
                    print("  (The Guitar Pro version has no Download button: saving the PDFs instead.)")
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
        saved, missing, took = [], [], []
        sizes = [(SHOT_H, SHOT_DSF), (11000, 1.4)]  # a song longer than the screen: a taller one
        with sync_playwright() as p:
            ctx = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
            pg = song_page(ctx, a.url)
            cdp = ctx.new_cdp_session(pg)
            park_chrome(cdp, pg)
            size = 0
            try:
                sharp_screen(cdp, pg, *sizes[size])
                open_instruments(pg)
                for i, n in enumerate(names):
                    label = f"{song} - {artist} - {n}" if artist else f"{song} - {n}"
                    for attempt in (1, 2):  # a track that didn't save is tried once more
                        dest = free_name(out, label, ".pdf")  # an existing file is never replaced
                        run.pending = dest
                        eta = (sum(took) / len(took) if took else SECONDS_PER_TRACK) * (len(names) - i)
                        hold(ui)
                        ui.progress(i, len(names), n, eta, "" if attempt == 1 else "Trying this track again.")
                        t0 = time.time()
                        try:
                            keep_drawing(cdp, pg)
                            ok, why, res = save_track(ui, ctx, pg, cdp, n, dest, label, (song, artist), names[:i].count(n))
                            while ok and res.get("full") and size + 1 < len(sizes):
                                dest.unlink()  # its end was below the screen: again, on a taller one
                                size += 1
                                sharp_screen(cdp, pg, *sizes[size])
                                ok, why, res = save_track(ui, ctx, pg, cdp, n, dest, label, (song, artist), names[:i].count(n))
                            if ok and res.get("full"):
                                print(f"  {dest.name}: the song is very long; its end may be missing")
                        except Cancelled:
                            raise
                        except Exception as err:
                            ok, why = False, str(err).splitlines()[0][:120]
                        finally:
                            if dest.exists() and dest not in run.files:
                                run.files.append(dest)
                        if ok:
                            saved.append({"name": n, "file": dest.name})
                            took.append(time.time() - t0 + a.gap)
                            print(f"  {dest.name}: saved ({res.get('pages')} pages)")
                            break
                        print(f"  {dest.name}: NOT saved ({why})")
                    else:
                        missing.append(n)
                    if i + 1 < len(names):
                        end = time.time() + a.gap  # unhurried pace
                        while time.time() < end:
                            hold(ui)
                            time.sleep(0.25)
            finally:
                normal_screen(cdp)  # the song's tab back as it was
            hold(ui)
            ui.progress(len(names), len(names), "chords", 0)
            chords_text = official_chords(pg)
            video = page_video(pg)
            if not chords_text:
                chords_text, v2 = search_chords(ctx, song, artist)
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
        extra = {}
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
        print("Cancelled: everything this run saved was removed.")
        ui.finish("Cancelled. Everything this run saved was removed; your other files weren't touched.")
    except Exception as err:
        if getattr(ui, "aborted", False):
            if run and ui.code == CANCELLED:
                run.undo()
            return
        result["code"] = FAILED
        print(f"Failed: {err}")
        try:
            close_prints()
        except Exception:
            pass
        ui.finish(f"Something went wrong, so it stopped:\n{err}\n\nFiles already saved were kept.", run.out if run else None)
    finally:
        tidy_tabs(a.url)


def main():
    global PORT
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
    ap.add_argument("--pdfs", action="store_true", help="official songs: the PDFs of the official player, even when a Guitar Pro version exists")
    ap.add_argument("--auto-official", action="store_true", help="Official / Pro songs and Guitar Pro tabs: save without asking (chords and plain tabs still ask)")
    a = ap.parse_args()
    PORT = a.port
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
