"""YouTube search for the song worker (scripts/songworker.mjs): the videos for a song, as JSON on stdout.

    python tests/yt2gp5/ytfind.py "Artist Title official" [-n 10]

Prints [{"id", "title", "author", "seconds", "verified"}, ...]. Nothing is downloaded. The worker ranks the
list with js/ytsearch.js (the same ranking Fretboard uses: the artist's own channel and "official" first,
never covers, lessons or karaoke).
"""
import json
import subprocess
import sys
from pathlib import Path

VENV = Path.home() / ".fretboard" / "yt2gp5-venv" / "Scripts" / "python.exe"  # yt-dlp lives there (PLAN.md)
if VENV.exists() and Path(sys.executable).resolve() != VENV.resolve() and __name__ == "__main__":
    sys.exit(subprocess.run([str(VENV), __file__, *sys.argv[1:]]).returncode)


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
    n = int(a[a.index("-n") + 1]) if "-n" in a else 10
    import yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True}) as y:
        r = y.extract_info(f"ytsearch{n}:{a[0]}", download=False)
    out = [{"id": e["id"], "title": e.get("title") or "", "author": e.get("channel") or e.get("uploader") or "",
            "seconds": e.get("duration"), "verified": bool(e.get("channel_is_verified"))}
           for e in (r.get("entries") or []) if e and e.get("id")]
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
