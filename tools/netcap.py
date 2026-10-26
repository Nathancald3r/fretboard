"""Download speed limit shared by datasets.py and datafactory.py.

Home network: a steady 80% of the line. The line is measured once per network (a 6 s test against Google
storage) and kept in fretboard-data/net.json for 7 days.
Public network: Windows marks every new cafe/hotel Wi-Fi "Public" unless you mark it Private. There the cap is
low (1 MB/s over 2 connections), so the download doesn't stand out.
The network is checked again every minute, so moving to a cafe mid-download slows it down at once.

Overrides: FRETBOARD_NET=home|public, FRETBOARD_CAP_MBS=<MB/s>, FRETBOARD_PUBLIC_MBS=<MB/s> (default 1).
"""
import json, os, subprocess, sys, threading, time, urllib.request
from pathlib import Path

DATA = Path(os.environ.get("FRETBOARD_DATA", Path.home() / "fretboard-data"))
SHARE = 0.8
PUBLIC_CONNS = 2
UA = {"User-Agent": "fretboard-datasets/1.0"}
TEST_URL = "https://storage.googleapis.com/magentadata/datasets/groove/groove-v1.0.0.zip"
TEST_SIZE = 5111599714


def say(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def network():
    """(name, 'home' | 'public')."""
    force = os.environ.get("FRETBOARD_NET", "").lower()
    if force in ("home", "public"):
        return force, force
    if sys.platform != "win32":
        return "default", "home"  # Colab, Linux: no profiles to read
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              'Get-NetConnectionProfile | ForEach-Object { "$($_.Name)|$($_.NetworkCategory)" }'],
                             capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return "unknown", "public"  # can't tell: be careful
    rows = [l.strip().split("|", 1) for l in out.splitlines() if "|" in l]
    if not rows:
        return "unknown", "public"
    return ",".join(sorted(r[0] for r in rows)), "public" if any(r[1] == "Public" for r in rows) else "home"


def speedtest(secs=6, conns=8):
    """Bytes/s this line gives: conns readers over Google storage for secs; the first second (ramp-up) is skipped."""
    lock, got, stop = threading.Lock(), [0], time.time() + secs
    piece = 256 << 20

    def one(k):
        while time.time() < stop:
            a = (k * piece) % (TEST_SIZE - piece)
            try:
                req = urllib.request.Request(TEST_URL, headers={**UA, "Range": f"bytes={a}-{a + piece - 1}"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    while time.time() < stop and (c := r.read(1 << 18)):
                        with lock:
                            got[0] += len(c)
            except Exception:
                time.sleep(0.5)
            k += conns

    ts = [threading.Thread(target=one, args=(k,), daemon=True) for k in range(conns)]
    for t in ts:
        t.start()
    time.sleep(1)
    with lock:
        g0, t0 = got[0], time.time()
    for t in ts:
        t.join(secs + 25)
    return (got[0] - g0) / max(0.5, time.time() - t0)


def line_rate(name):
    p = DATA / "net.json"
    try:
        saved = json.loads(p.read_text())
    except Exception:
        saved = {}
    s = saved.get(name)
    if s and time.time() - s["when"] < 7 * 86400:
        return s["bps"]
    say(f"measuring this network's speed ({name}), 6 s ...")
    bps = speedtest()
    if bps < 1e6:  # test failed: assume a modest line
        return 10e6
    saved[name] = {"bps": bps, "when": time.time()}
    DATA.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(saved, indent=1))
    say(f"line: {bps / 1e6:.0f} MB/s ({bps * 8 / 1e6:.0f} Mbps)")
    return bps


class Limit:
    """One steady rate for every download thread: a token bucket refilled at `cap` bytes/s."""

    def __init__(self):
        self.lock = threading.Lock()
        self.tokens, self.t = 0.0, time.monotonic()
        self.bytes = 0  # all bytes read, for rate checks
        self.mode = self.name = None
        self.cap, self.conns = 10e6, None
        self.checked = 0.0
        self.refresh()

    def refresh(self):
        name, mode = network()
        self.checked = time.time()
        if (name, mode) == (self.name, self.mode):
            return
        if mode == "public":
            cap, conns = float(os.environ.get("FRETBOARD_PUBLIC_MBS", 1)) * 1e6, PUBLIC_CONNS
        else:
            env = os.environ.get("FRETBOARD_CAP_MBS")
            cap, conns = (float(env) * 1e6 if env else SHARE * line_rate(name)), None
        with self.lock:
            self.name, self.mode, self.cap, self.conns = name, mode, cap, conns
        say(f"network: {mode} ({name}); cap {cap / 1e6:.1f} MB/s" + (f", {conns} connections" if conns else ""))

    @property
    def public(self):
        return self.mode == "public"

    def take(self, n):
        if time.time() - self.checked > 60:
            with self.lock:
                due, self.checked = time.time() - self.checked > 60, time.time()
            if due:
                threading.Thread(target=self.refresh, daemon=True).start()
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.cap * 0.25, self.tokens + (now - self.t) * self.cap)  # at most 0.25 s of burst
            self.t = now
            self.tokens -= n
            self.bytes += n
            wait = -self.tokens / self.cap if self.tokens < 0 else 0
        if wait:
            time.sleep(wait)

    def read(self, r, n=1 << 18):
        c = r.read(n)
        if c:
            self.take(len(c))
        return c


_limit = None


def limit():
    global _limit
    if _limit is None:
        _limit = Limit()
    return _limit


if __name__ == "__main__":
    L = limit()
    print(f"{L.mode} network '{L.name}': cap {L.cap / 1e6:.1f} MB/s")
