"""Save every instrument/vocal track of an official Ultimate Guitar Tab Pro song as a PDF,
one per track, named "<Song> - <Artist> - <Instrument>.pdf", into
Downloads\\UG Songs\\<Song> - <Artist> (Key X).

A small window first shows the song and its tracks (untick any you don't want, then Start or
Skip). While it saves, a window stays on top with the progress and a Cancel button: please don't
use the mouse or keyboard until it says Done (it pauses by itself if you do). Cancel stops it and
removes everything this run saved, so nothing is left half done. Your login is never touched.

1. Start Chrome with a debugging port (ug_watch.py does this for you):
     & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\ug-chrome"
   Log in to UG Pro in that window once, and open the song page.
2. pip install playwright
3. python tools/ug_collect.py "<song url>"     (--only "Lead Guitar,Piano" to pick tracks, --no-ui for text only)

Then in Fretboard: Import files (it opens in this song's folder), select all, check, Create song.
Exit codes: 0 done, 1 failed, 2 skipped, 3 cancelled.
"""
import argparse, ctypes, json, queue, re, subprocess, sys, threading, time, urllib.request
from datetime import datetime
from pathlib import Path

PORT = 9222
DIALOG = Path(__file__).with_name("ug_save_dialog.ps1")
DONE, FAILED, SKIPPED, CANCELLED = 0, 1, 2, 3
SECONDS_PER_TRACK = 26  # first guess for the time left; then measured


class Cancelled(Exception):
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
      return root.innerText.split('\\n').map(s=>s.trim()).filter(s=>s&&!['Instruments','Pin','Unpin','C','S','M'].includes(s)&&!/^\\d+%$/.test(s))}""")


def song_name(pg):
    """("Champion", "Bethel Music") from the page heading "Official Champion Tab by Bethel Music"."""
    h1, link = pg.evaluate("[document.querySelector('h1')?.innerText||'', document.querySelector('a[href*=\"/artist/\"]')?.innerText||'']")
    t = re.sub(r"^Official\s+", "", h1.strip(), flags=re.I)
    song, _, artist = t.partition(" by ")
    # the heading sometimes loads without "by <artist>": use the artist link, else the URL (/tab/bethel-music/...)
    artist = artist or link.strip() or pg.url.split("/tab/")[-1].split("/")[0].replace("-", " ").title()
    clean = lambda x: re.sub(r'[\\/:*?"<>|]+', " ", x).strip()
    return clean(re.sub(r"\s+(Tab|Chords|Pro)\b.*$", "", song, flags=re.I)) or "Song", clean(artist.split(" @")[0])


# ---------- windows ----------

class ConsoleUI:
    """--no-ui: the same steps, told in the console."""
    def __init__(self):
        self.cancel = threading.Event()

    def ask(self, info):
        print(f"{info['song']} - {info['artist']}: {len(info['names'])} tracks -> {', '.join(info['names'])}\n"
              f"Saving into {info['out']}; keep hands off keyboard and mouse until it says Done.\n")
        return info["names"]

    def progress(self, i, n, name, eta=None, note=""):
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
        self._label(f"Save its {len(info['names'])} tracks as PDFs? Untick any you don't want.", 10, color=self.MUTED)
        grid = tk.Frame(self.body, bg=self.BG)
        grid.pack(fill="x", pady=(0, 8))
        vars_ = []
        for k, n in enumerate(info["names"]):
            v = tk.BooleanVar(value=True)
            tk.Checkbutton(grid, text=n, variable=v, bg=self.BG, fg=self.FG, selectcolor="#33363d", activebackground=self.BG,
                           activeforeground=self.FG, anchor="w", font=("Segoe UI", 10)).grid(row=k // 2, column=k % 2, sticky="w", padx=(0, 18))
            vars_.append((n, v))
        mins = max(1, round(len(info["names"]) * SECONDS_PER_TRACK / 60))
        self._label(f"Saves into  {info['out']}\n\nTakes about {mins} min. Please don't use the mouse or keyboard while it "
                    "runs; a small window shows the progress and you can Cancel any time (it then removes what it saved).\n\n"
                    "Afterwards, in Fretboard: Import files (it opens in this folder), select all, check the tracks, Create song.",
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
            self._label("Saving PDFs — please don't use the mouse or keyboard", 11, bold=True, color=self.ACCENT)
            self._now = self._label("", 10)
            style = ttk.Style(self.root)
            style.theme_use("default")
            style.configure("fb.Horizontal.TProgressbar", background=self.ACCENT, troughcolor="#33363d", thickness=10)
            self._bar = ttk.Progressbar(self.body, style="fb.Horizontal.TProgressbar", length=380, maximum=n)
            self._bar.pack(fill="x", pady=(2, 8))
            self._eta = self._label("", 9, color=self.MUTED)
            row = self.tk.Frame(self.body, bg=self.BG)
            row.pack(fill="x")
            self._cancel_btn = self._button(row, "Cancel", self._cancel)
            self._on_close = self._cancel
            self._place(corner=True)
        self._bar["value"] = i
        self._now["text"] = f"Track {min(i + 1, n)} of {n}: {name}"
        left = f"About {max(1, round(eta / 60))} min left." if eta else ""
        self._eta["text"] = " ".join(x for x in (note, left) if x)

    def _cancel(self):
        if self.cancel.is_set():
            return
        self.cancel.set()
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
        if ui.cancel.is_set():
            raise Cancelled
        if not told:
            ui.progress(i, n, name, eta, "Paused: waiting until the mouse and keyboard are left alone.")
            told = True
        time.sleep(0.5)


def save_track(ui, a, n, dest, label):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        ctx = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
        pg = song_page(ctx, a.url)
        open_instruments(pg)
        pg.get_by_text(n, exact=True).first.click()
        pg.wait_for_timeout(2500)
        # window.print runs after this call returns, so the driver isn't stuck behind the dialog
        pg.evaluate("""l=>{document.title=l;setTimeout(()=>[...document.querySelectorAll('button')]
            .find(b=>b.innerText.trim()=='Print').click(),200)}""", label)
    time.sleep(4)
    with sync_playwright() as p:
        ctx = p.chromium.connect_over_cdp(f"http://localhost:{PORT}").contexts[0]
        pr = [x for x in ctx.pages if x.url.startswith("chrome://print")][-1]
        pr.locator("select").first.select_option("Save as PDF/local/")
        pr.wait_for_timeout(2500)
        set_a4(pr)
        if ui.cancel.is_set():  # last moment to stop before anything is saved
            raise Cancelled
        pr.locator("cr-button.action-button").first.click(no_wait_after=True, timeout=5000)
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(DIALOG), str(dest)],
                       capture_output=True, text=True)
    for _ in range(40):  # Chrome writes the file a moment after Save
        if dest.exists():
            break
        time.sleep(0.5)
    for _ in range(30):
        if not print_open():
            break
        time.sleep(1)
    return dest.exists(), (r.stdout.strip() or r.stderr.strip()[:80])


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
        folder = " - ".join(x for x in (song, artist) if x) + (f" (Key {key})" if key else "")
        out = (Path(a.out) if a.out else Path(a.root) / folder).resolve()
        names = names if a.yes else ui.ask({"song": song, "artist": artist, "key": key, "names": names, "out": str(out)})
        if not names:
            result["code"] = SKIPPED
            ui.finish(f"Skipped {song}. Nothing was saved.")
            return
        run = Run(out, a.root, set_latest=not a.out)
        run.start()
        saved, missing, took = [], [], []
        for i, n in enumerate(names):
            label = f"{song} - {artist} - {n}" if artist else f"{song} - {n}"
            for attempt in (1, 2):  # a track that didn't save is tried once more
                dest = out / f"{label}.pdf"
                k = 2
                while dest.exists():  # an existing file is never replaced: the new one gets "(2)", "(3)"...
                    dest = out / f"{label} ({k}).pdf"
                    k += 1
                run.pending = dest
                eta = (sum(took) / len(took) if took else SECONDS_PER_TRACK) * (len(names) - i)
                if ui.cancel.is_set():
                    raise Cancelled
                wait_idle(ui, i, len(names), n, eta)
                ui.progress(i, len(names), n, eta, "" if attempt == 1 else "Trying this track again.")
                t0 = time.time()
                try:
                    ok, why = save_track(ui, a, n, dest, label)
                finally:
                    if dest.exists() and dest not in run.files:
                        run.files.append(dest)
                    close_prints()  # a Print window left open would freeze the next track
                if ok:
                    saved.append({"name": n, "file": dest.name})
                    took.append(time.time() - t0 + a.gap)
                    print(f"  {dest.name}: saved")
                    break
                print(f"  {dest.name}: NOT saved ({why})")
            else:
                missing.append(n)
            if i + 1 < len(names):
                end = time.time() + a.gap  # unhurried pace, about what printing by hand takes
                while time.time() < end:
                    if ui.cancel.is_set():
                        raise Cancelled
                    time.sleep(0.25)
        ui.progress(len(names), len(names), "done", 0)
        # what Fretboard reads to offer this song for import
        (out / "fretboard-run.json").write_text(json.dumps({
            "app": "fretboard-ug-collect", "version": 1, "song": song, "artist": artist, "key": key, "url": a.url,
            "tracks": saved, "missing": missing, "finished": datetime.now().isoformat(timespec="seconds"),
        }, indent=2, ensure_ascii=False), encoding="utf-8")
        result["code"] = DONE if saved else FAILED
        text = (f"Done: saved {len(saved)} of {len(names)} tracks of {song} into\n{out}"
                + (f"\n\nNot saved: {', '.join(missing)} (open the song again later to fetch them)." if missing else "")
                + "\n\nNext, in Fretboard: Import files (it opens in this folder), select all, check the tracks, Create song.")
        print(text)
        ui.finish(text, out)
    except Cancelled:
        close_prints()
        if run:
            p = getattr(run, "pending", None)  # a save that was just pressed: let it finish writing, then remove it too
            for _ in range(10):
                if not p or p.exists():
                    break
                time.sleep(0.5)
            if p and p.exists() and p not in run.files:
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
