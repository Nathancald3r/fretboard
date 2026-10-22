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
import argparse, base64, ctypes, json, queue, re, subprocess, sys, threading, time, urllib.request
from datetime import datetime
from pathlib import Path

PORT = 9222
DIALOG = Path(__file__).with_name("ug_save_dialog.ps1")
DONE, FAILED, SKIPPED, CANCELLED = 0, 1, 2, 3
SECONDS_PER_TRACK = 22  # first guess for the time left; then measured


class Cancelled(Exception):
    pass


def hold(ui):
    """Waits here while the run is paused; stops the run when it's cancelled."""
    paused = getattr(ui, "paused", None)
    while paused is not None and paused.is_set() and not ui.cancel.is_set():
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
    try:
        from ug_watch import show_window
        show_window()
    except Exception:
        pass


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
    (just closing it would leave the tab stuck). A Save As dialog left open is cancelled too."""
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
                return pg
    pg = ctx.new_page()  # the open tab is stuck (or gone): work in a fresh one, leave the user's tab be
    pg.set_viewport_size({"width": 1500, "height": 1000})
    pg.goto(url, wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)
    return pg


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
        self.q.put(("progress", i, n, name, eta, note))

    def finish(self, text, folder=None):
        ev = threading.Event()
        self.q.put(("finish", text, folder, ev))
        self._wait(ev)

    # --- Tk side ---
    def run(self, work):
        t = threading.Thread(target=work, daemon=True)
        t.start()
        self.root.mainloop()
        self.cancel.set()  # window closed: stop the work if it's still going
        t.join(timeout=120)

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
        self.root.title("Found a song")
        self._label(f"{info['song']} — {info['artist']}" + (f"  (Key {info['key']})" if info['key'] else ""), 13, bold=True)
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
        self._label(f"Saves into  {info['out']}\n\n" + (info.get("note") or
                    f"Takes about {mins} min. Chrome works out of sight and a small window shows the progress, "
                    "so you can keep using the computer. Pause it any time, or Cancel (it then removes what it saved).\n\n"
                    "Afterwards, in Fretboard: Import files (it opens in this folder), select all, check the tracks, Create song."),
                    9, color=self.MUTED)
        row = tk.Frame(self.body, bg=self.BG)
        row.pack(fill="x", pady=(6, 0))

        def answer(names):
            box["names"] = names
            ev.set()

        self._button(row, "Start", lambda: answer([n for n, v in vars_ if v.get()] or None), primary=True)
        self._button(row, "Skip this song", lambda: answer(None))
        self._on_close = lambda: answer(None)
        self._place()
        self.root.lift()
        self.root.focus_force()

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
            self._button(row, "Show UG window", lambda: threading.Thread(target=show_chrome, daemon=True).start())
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
            "x": v["x"] * z, "y": v["y"] * z, "width": v["w"] * z, "height": v["h"] * z, "scale": 1}})
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


def save_single(ui, a, result, pg, kind, label):
    """A chord sheet / plain tab (as text) or a Guitar Pro tab (its download): one file."""
    song, artist = song_name(pg)
    info = page_text(pg) if kind == "text" else {}
    if kind == "text" and not info.get("text", "").strip():
        raise RuntimeError("Couldn't find the tab's text on this page. Wait until it has loaded and open it again.")
    key = (info.get("key") or "").replace("\u266d", "b").replace("\u266f", "#")
    out = (Path(a.out) if a.out else song_folder(a.root, song, artist, key)).resolve()
    what = (f"Save this {label.lower()} sheet as a text file?" if kind == "text"
            else "Save this Guitar Pro tab with the page's Download button?")
    names = [label] if a.yes or (a.auto_official and kind == "gp") else ui.ask({"song": song, "artist": artist, "key": key, "names": [label], "out": str(out), "what": what,
                                          "note": "One file, saved in a few seconds. Then Fretboard's library offers it (Review & create)."})
    if not names:
        result["code"] = SKIPPED
        ui.finish(f"Skipped {song}. Nothing was saved.")
        return
    stem = " - ".join(x for x in (song, artist, label) if x)
    run = Run(out, a.root, set_latest=not a.out)
    try:
        run.start()
        ui.progress(0, 1, label)
        hold(ui)
        if kind == "text":
            head = " · ".join(x for x in (label, info["key"] and f"Key: {info['key']}", info["capo"] and f"Capo: {info['capo']}",
                                          info["tuning"] and f"Tuning: {info['tuning']}") if x)
            dest = free_name(out, stem, ".txt")
            dest.write_text(f"{song} - {artist}\n{head}\nFrom: {a.url}\n\n{info['text'].rstrip()}\n", encoding="utf-8")
            run.files.append(dest)
        else:
            wait_idle(ui, 0, 1, label, 5)
            dest = save_gp(pg, out, stem)
            if not dest:
                raise RuntimeError("The download didn't arrive (the page may need you to be logged in). Nothing was kept.")
            run.files.append(dest)
        hold(ui)
        man = free_name(out, "fretboard-run-" + label.lower().replace(" ", "-"), ".json")
        write_manifest(out, man.name, {"song": song, "artist": artist, "key": key, "url": a.url, "kind": kind,
                                       "tracks": [{"name": label, "file": dest.name}], "missing": []})
        run.files.append(man)
    except Cancelled:
        run.undo()
        result["code"] = CANCELLED
        ui.finish("Cancelled. Nothing from this run was kept.")
        return
    except Exception:
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
        if not names:
            raise RuntimeError("Couldn't read the Instruments list. Open the song's player page, show the Instruments panel, and try again.")
        only = [s.strip().lower() for s in a.only.split(",") if s.strip()]
        if only:
            names = [x for x in names if x.lower() in only]
        out = (Path(a.out) if a.out else song_folder(a.root, song, artist, key)).resolve()
        names = names if a.yes or a.auto_official else ui.ask({"song": song, "artist": artist, "key": key, "names": names, "out": str(out)})
        if not names:
            result["code"] = SKIPPED
            ui.finish(f"Skipped {song}. Nothing was saved.")
            return
        run = Run(out, a.root, set_latest=not a.out)
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
        ui.progress(len(names), len(names), "done", 0)
        write_manifest(out, "fretboard-run.json", {"song": song, "artist": artist, "key": key, "url": a.url,
                                                    "tracks": saved, "missing": missing})
        result["code"] = DONE if saved else FAILED
        text = (f"Done: saved {len(saved)} of {len(names)} tracks of {song} into\n{out}"
                + (f"\n\nNot saved: {', '.join(missing)} (open the song again later to fetch them)." if missing else "")
                + "\n\nNext, in Fretboard: Import files (it opens in this folder), select all, check the tracks, Create song.")
        print(text)
        ui.finish(text, out)
    except Cancelled:
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
        result["code"] = FAILED
        print(f"Failed: {err}")
        try:
            close_prints()
        except Exception:
            pass
        ui.finish(f"Something went wrong, so it stopped:\n{err}\n\nFiles already saved were kept.", run.out if run else None)


def main():
    global PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default="", help="exact folder to save into")
    ap.add_argument("--root", default=str(Path.home() / "Downloads" / "UG Songs"), help="parent of the per-song folders")
    ap.add_argument("--gap", type=float, default=10, help="seconds to wait between tracks")
    ap.add_argument("--no-ui", action="store_true", help="no windows: ask nothing, report in the console")
    ap.add_argument("--yes", action="store_true", help="start without asking which tracks")
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
    else:
        work(ConsoleUI(), a, result)
    sys.exit(result["code"])


if __name__ == "__main__":
    main()
