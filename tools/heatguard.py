"""Heat guard: pauses heavy jobs when the PC runs too hot or too busy, and lets them go again when it cools.

  python tools/heatguard.py [--match datafactory,truthbench] [--cpu 85] [--gpu 80]

The user's limits (2026-10-28): the CPU at most 85% busy, the GPU at most 80 C.
Every few seconds it reads the whole PC's CPU load (a 30 s average, so a short spike doesn't pause anything)
and the GPU temperature (nvidia-smi). Above a limit it suspends every process whose command line holds one of
the --match words (and their children); below the resume level (CPU 70%, GPU 74 C) it resumes them.
Downloads (datasets.py) are never matched: they use almost no CPU, and a stalled connection only costs time.
A job started while paused is picked up on the next look.
State goes to %USERPROFILE%\\fretboard-data\\heatguard.json (readable by anything) and changes to heatguard.log.
CPU temperature can't be read on this Windows PC without admin tools, so the CPU limit is the load.
"""
import argparse, json, os, subprocess, sys, time
from collections import deque
from pathlib import Path

import psutil

DATA = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "fretboard-data"
STATE, LOG = DATA / "heatguard.json", DATA / "heatguard.log"
SELF = os.getpid()


def gpu_temp():
    try:
        out = subprocess.check_output(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
                                      text=True, timeout=10, creationflags=0x08000000 if os.name == "nt" else 0)
        return max(int(x) for x in out.split())
    except Exception:
        return None


def jobs(words):
    found = []
    for p in psutil.process_iter(["pid", "cmdline", "name"]):
        try:
            if p.pid == SELF:
                continue
            line = " ".join(p.info["cmdline"] or [])
            if "heatguard" in line:
                continue
            if any(w in line for w in words):
                found.append(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return found


def set_paused(procs, paused):
    n = 0
    for p in procs:
        try:
            for q in [p] + p.children(recursive=True):
                try:
                    if paused and q.status() != psutil.STATUS_STOPPED:
                        q.suspend(); n += 1
                    elif not paused:
                        q.resume(); n += 1
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return n


def say(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    print(line, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", default="datafactory,truthbench", help="comma list of command-line words")
    ap.add_argument("--cpu", type=float, default=85, help="pause above this % busy (30 s average)")
    ap.add_argument("--gpu", type=float, default=80, help="pause at or above this temperature in C")
    ap.add_argument("--every", type=float, default=5, help="seconds between looks")
    a = ap.parse_args()
    words = [w for w in a.match.split(",") if w]
    cpu_resume, gpu_resume = a.cpu - 15, a.gpu - 6
    DATA.mkdir(parents=True, exist_ok=True)
    window = deque(maxlen=max(1, int(30 / a.every)))
    psutil.cpu_percent(None)
    paused, why = False, ""
    say(f"guard on: CPU {a.cpu:.0f}% (30 s average), GPU {a.gpu:.0f} C; watching {', '.join(words)}")
    while True:
        time.sleep(a.every)
        window.append(psutil.cpu_percent(None))
        cpu, gt = sum(window) / len(window), gpu_temp()
        full = len(window) == window.maxlen
        too_hot = gt is not None and gt >= a.gpu
        too_busy = full and cpu > a.cpu
        if not paused and (too_hot or too_busy):
            why = f"GPU {gt} C" if too_hot else f"CPU {cpu:.0f}%"
            n = set_paused(jobs(words), True)
            paused = True
            say(f"PAUSE ({why}): {n} processes stopped")
        elif paused:
            cool = (gt is None or gt <= gpu_resume) and cpu <= cpu_resume
            if cool:
                n = set_paused(jobs(words), False)
                paused = False
                say(f"RESUME (CPU {cpu:.0f}%, GPU {gt} C): {n} processes continued")
            else:
                set_paused(jobs(words), True)  # a job started meanwhile joins the pause
        try:
            STATE.write_text(json.dumps({"cpu_avg": round(cpu, 1), "gpu_c": gt, "paused": paused, "why": why if paused else "",
                                         "limits": {"cpu": a.cpu, "gpu": a.gpu}, "at": time.time()}), encoding="utf-8")
        except OSError:
            pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
