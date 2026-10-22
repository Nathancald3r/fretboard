"""Sets up the UG helper on this Windows computer, so Fretboard's Start UG helper button works.

Run by "Set up UG helper.cmd" (download it from Fretboard: Find tabs online). It
  - copies the helper (ug_watch.py, ug_collect.py) from the Fretboard site into
    %USERPROFILE%\\Fretboard UG helper,
  - installs Playwright for Python if it's missing (it drives the helper's own Chrome window),
  - registers the fretboard-helper: link for this Windows user only, so the button can start
    the helper. The link only ever runs start.cmd in that folder; anything after
    "fretboard-helper:" is ignored.
Run it again any time; nothing else on the computer is changed.

  python ug_helper_setup.py            set up (or repair)
  python ug_helper_setup.py --refresh  only fetch the newest helper (start.cmd does this each start)
"""
import os, subprocess, sys, urllib.request
from pathlib import Path

SITE = "https://nathancald3r.github.io/fretboard/tools/"
FILES = ["ug_watch.py", "ug_collect.py", "ug_helper_setup.py"]
# Not under AppData: the Microsoft Store's Python keeps its own private copy of that folder.
HOME = Path.home() / "Fretboard UG helper"
SCHEME = "fretboard-helper"
CHROME = [Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
          Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
          Path.home() / r"AppData\Local\Google\Chrome\Application\chrome.exe"]


def fetch(quiet=False):
    """The newest helper files from the site. A file that can't be fetched keeps its old copy."""
    HOME.mkdir(parents=True, exist_ok=True)
    ok = True
    for name in FILES:
        try:
            with urllib.request.urlopen(SITE + name, timeout=15) as r:
                data = r.read()
            if not data.strip():
                raise OSError("empty file")
            tmp = HOME / (name + ".new")
            tmp.write_bytes(data)
            os.replace(tmp, HOME / name)
        except OSError as e:
            ok = False
            if not quiet:
                print(f"  couldn't fetch {name}: {e}")
    return ok and all((HOME / n).exists() for n in FILES)


def ensure_playwright():
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        pass
    print("Installing Playwright for Python (one time, about a minute)...")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "--user", "--upgrade", "playwright"])
    return r.returncode == 0


def write_start():
    py = Path(sys.executable)
    (HOME / "start.cmd").write_text(
        "@echo off\r\n"
        "title Fretboard UG helper\r\n"
        'cd /d "%~dp0"\r\n'
        f'"{py}" ug_helper_setup.py --refresh\r\n'
        f'"{py}" ug_watch.py\r\n'
        "if errorlevel 1 pause\r\n", encoding="utf-8")


def register():
    import winreg
    comspec = os.environ.get("ComSpec") or r"C:\Windows\System32\cmd.exe"
    start = HOME / "start.cmd"
    cmd = f'"{comspec}" /c ""{start}""'
    base = rf"Software\Classes\{SCHEME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:Fretboard UG helper")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, cmd)


def main():
    if "--refresh" in sys.argv:
        fetch(quiet=True)
        return 0
    print(f"Setting up the UG helper in {HOME}\n")
    if not fetch():
        print("\nCouldn't download the helper. Check the internet connection and run this again.")
        return 1
    print("  helper files: ok")
    if not ensure_playwright():
        print("\nPlaywright didn't install. Run this again, or run:  python -m pip install --user playwright")
        return 1
    print("  Playwright: ok")
    write_start()
    register()
    print("  Start UG helper button: ok")
    if not any(c.exists() for c in CHROME):
        print("\nGoogle Chrome isn't installed. The helper uses its own Chrome window: install Chrome, then it's ready.")
    print("\nDone. In Fretboard press Start UG helper (Chrome asks once whether to open it: tick Always allow).\n"
          "The first time, log in to Ultimate Guitar in the helper's Chrome window (Official songs need your account;\n"
          "Guitar Pro tabs don't).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
