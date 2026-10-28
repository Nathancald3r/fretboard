"""The song list for the YouTube → GP5 test and for the Colab notebook: songs.json beside this file.

Each song pairs a Guitar Pro file (the known notes) with the YouTube recording of the same song.
With both, run.py can score the notebook on real recordings, not just Fretboard's synth.

    python tests/yt2gp5/songdb.py scan [FOLDER ...]   add every Guitar Pro file found (default: Downloads)
                     --official                       they were made from UG "official" tabs (ug_to_gp.py)
    python tests/yt2gp5/songdb.py find [--official]   suggest a YouTube video for each song that has none
    python tests/yt2gp5/songdb.py set NAME URL        use this video for the song (NAME: any part of its name)
    python tests/yt2gp5/songdb.py report              out/match/report.html: a picture of how each video follows the tab
    python tests/yt2gp5/songdb.py verify [NAME] [--official]
                                                      download the suggestions in the user's order (official
                                                      audio first), line each up with the tab, and confirm the
                                                      first that matches all the way through (real.whole_match)
    python tests/yt2gp5/songdb.py ok NAME             the suggested video is right
    python tests/yt2gp5/songdb.py skip NAME           leave this song out
    python tests/yt2gp5/songdb.py add URL             a song with only a YouTube link (for Colab, not scored)
    python tests/yt2gp5/songdb.py check               are the videos still there, and the right length?
    python tests/yt2gp5/songdb.py list                the table
    python tests/yt2gp5/songdb.py export              colab_batch.txt: the links to paste into the notebook

`find` searches YouTube with yt-dlp (titles and lengths only, nothing is downloaded) and picks
the studio recording: the length matches the tab, the title matches, and live, cover, lesson,
karaoke or remix versions score lower. "- Topic" channels (the label's own audio) score higher.
A suggestion counts once you `ok` it, or straight away when its confidence is high.
"""
import base64
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB = HERE / "songs.json"
UG_FOLDERS = (Path.home() / "Downloads" / "UG Songs", HERE / "cache" / "ug-pdf")  # where the UG helper saves a song's folder
GP_EXT = {".gp", ".gpx", ".gp3", ".gp4", ".gp5"}
BAD = {"live": 25, "cover": 30, "lesson": 40, "tutorial": 40, "karaoke": 40, "instrumental": 25, "remix": 30,
       "slowed": 40, "reverb": 15, "sped": 40, "8d": 40, "reaction": 40, "drum cam": 40, "how to play": 40,
       "backing track": 35, "performance track": 40, "multitrack": 40, "stems": 30, "guitar only": 30, "acoustic": 12, "piano": 15, "lyrics": 3, "1 hour": 40, "loop": 20}
GOOD = {"official audio": 12, "audio": 3}
# the user's order: the artist's official audio ("Artist - Topic", "Provided to YouTube by ..."), then the
# artist's own audio upload, then their music video (it often has an intro or a skit, and another length)
# words that mark another recording of the song
OTHER_VERSION = ("live", "acoustic", "radio", "remix", "session", "demo", "instrumental", "karaoke", "cover", "edit)",
                 "sped", "slowed", "version", "mix)", "anniversary", "lesson", "tutorial", "chords", "reaction", "world edition")
VIDEO = ("official music video", "official video", "music video", "official lyric video", "lyric video", "visualizer")


def tier(v, song):
    """The user's order, best first: 0 the artist's own audio from the label ("Artist - Topic"), 1 an "Official
    Audio" upload by the artist or label, 2 another upload by them, 3 their music or lyric video, 4 anyone
    else's (someone else's Topic channel is another artist's version), 5 another song or another version
    (live, acoustic, radio edit, ...), never tried."""
    title, channel = (v.get("title") or "").lower(), (v.get("channel") or "").lower()
    want = song.get("title") or song["name"]
    if not words(want) <= words(title) or any(k in title and k not in want.lower() for k in OTHER_VERSION):
        return 5
    squash = lambda t: re.sub(r"[^a-z0-9]", "", t.lower())
    own = (bool(song.get("artist")) and squash(song["artist"]) in squash(channel)) or "vevo" in channel or "records" in channel
    if not own:
        return 4
    if channel.endswith("- topic"):
        return 0
    if "official audio" in title or "(audio)" in title:
        return 1
    return 3 if any(k in title for k in VIDEO) else 2


def load():
    return json.loads(DB.read_text(encoding="utf-8")) if DB.exists() else {"songs": []}


def save(db):
    db["songs"].sort(key=lambda s: s["name"].lower())
    DB.write_text(json.dumps(db, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def words(text):
    return set(re.findall(r"[a-z0-9']+", (text or "").lower())) - {"the", "a", "and", "of", "official", "video", "audio", "ft", "feat"}


def clean_name(stem):
    """'Relient K-Forget And Not Slow Down-10-16-2025' → 'Relient K - Forget And Not Slow Down'."""
    s = re.sub(r"[-_ ]\d{1,2}-\d{1,2}-\d{4}$", "", stem)
    s = re.sub(r"\s*\((?:Key|Capo)[^)]*\)|\s*-\s*Guitar Pro$", "", s, flags=re.I)
    s = re.sub(r"(?<=\S)-(?=\S)", " - ", s, count=1) if " - " not in s else s
    return s.strip()


def find_one(db, name):
    hits = [s for s in db["songs"] if name.lower() in s["name"].lower()]
    if len(hits) != 1:
        sys.exit(f"'{name}' matches {len(hits)} songs" + (": " + ", ".join(s["name"] for s in hits) if hits else ""))
    return hits[0]


def ytdl(quiet=True):
    import yt_dlp
    return yt_dlp.YoutubeDL({"quiet": quiet, "no_warnings": True, "skip_download": True, "extract_flat": "in_playlist"})


def video_info(url):
    """Title, channel and length of one video, or None when it is gone or private."""
    import yt_dlp
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as y:
            v = y.extract_info(url, download=False)
        return {"id": v["id"], "title": v.get("title"), "channel": v.get("channel") or v.get("uploader"), "seconds": v.get("duration")}
    except Exception as e:
        return {"error": str(e).splitlines()[-1][:200]}


def score_video(v, song):
    """0-100: how likely this video is the studio recording that the tab was made from."""
    title, channel = (v.get("title") or "").lower(), (v.get("channel") or "").lower()
    want_title, want_artist = words(song.get("title") or song["name"]), words(song.get("artist"))
    got = words(title) | words(channel)
    s = 40.0 * len(want_title & got) / max(1, len(want_title))
    if want_artist:
        s += 15.0 * len(want_artist & got) / len(want_artist)
    # the original: YouTube's "Artist - Topic" audio, the artist's own channel, or their VEVO
    squash = lambda t: re.sub(r"[^a-z0-9]", "", t.lower())
    own = bool(want_artist) and squash(song.get("artist") or "") in squash(channel)  # "davidcrowderband" too
    if channel.endswith("- topic"):
        s += 25
    elif own or "vevo" in channel:
        s += 15
    if any(k in title for k in VIDEO):
        s -= 10
    elif "lyric" in title:
        s -= 10  # someone else's lyric video: often another version, or the audio cut or sped up
    for k, v_ in GOOD.items():
        if k in title:
            s += v_
            break
    for k, pen in BAD.items():
        if k in title and k not in (song.get("title") or song["name"]).lower():
            s -= pen
    if song.get("seconds") and v.get("seconds"):
        off = (v["seconds"] - song["seconds"]) / song["seconds"]
        # full marks when the lengths agree; a longer video (an intro, a fade, a music video) costs less
        s += 30 * max(0.0, 1 - (off / 0.3 if off > 0 else -off / 0.15))
    else:
        s += 10
    return round(max(0.0, min(100.0, s)), 1)


def gp_info(paths):
    """Title, artist, length of Guitar Pro files, read by alphaTab in headless Chromium (as Fretboard reads them)."""
    sys.path.insert(0, str(HERE))
    import run
    from playwright.sync_api import sync_playwright
    srv = run.serve()
    out = {}
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page()
        pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/tests/yt2gp5/render.html")
        pg.wait_for_function("window.renderReady === true")
        for p in paths:
            try:
                out[p] = pg.evaluate("b => songInfo(b)", base64.b64encode(Path(p).read_bytes()).decode())
            except Exception as e:
                out[p] = {"error": str(e).splitlines()[0][:200]}
        b.close()
    srv.shutdown()
    return out


def official_url(title):
    """The UG "official" tab a song came from, as the UG helper noted it (Downloads/UG Songs), or None."""
    ug = Path.home() / "Downloads" / "UG Songs"
    want = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    for f in list(ug.glob("*.txt")) + list(ug.glob("*/*.json")) + list(ug.glob("*.json")):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for url in re.findall(r"https://tabs\.ultimate-guitar\.com/tab/[^\s\"'<>]+-official-\d+", text):
            if f"/{want}-official-" in url:
                return url
    return None


def ug_chord_sheet(title, artist, roots=UG_FOLDERS):
    """The official song's chord chart (the UG helper's "<Song> - <Artist> - Chords.txt") as text, or "" when the
    song's folder has none. Fretboard shows it beside the tab (song.chordSheet)."""
    def key(s):
        return re.sub(r"[^a-z0-9]+", "", (s or "").lower())
    best = None
    for root in roots:
        if not root.exists():
            continue
        for d in root.iterdir():
            m = re.match(r"(.+?) - (.+?)(?: \(Key [^)]+\))?$", d.name)
            if not (d.is_dir() and m and key(m.group(1)) == key(title) and key(m.group(2)) == key(artist)):
                continue
            for f in d.glob("*Chords*.txt"):
                if f.stat().st_size > 20 and (best is None or f.stat().st_mtime > best.stat().st_mtime):
                    best = f
    return best.read_text(encoding="utf-8", errors="replace").strip("\r\n") if best else ""


def cmd_scan(db, folders, official=False):
    folders = [Path(f).expanduser() for f in folders] or [Path.home() / "Downloads"]
    import hashlib
    known = {s.get("gp") for s in db["songs"]}
    hashes = {s.get("sha1") for s in db["songs"]}
    new, seen = [], set()
    for p in sorted({p for f in folders for p in f.rglob("*") if p.suffix.lower() in GP_EXT}, key=lambda p: (len(p.name), str(p))):
        h = hashlib.sha1(p.read_bytes()).hexdigest()[:16]
        # skip copies ("song (1).gp") and the notebook's own output (song.gp5), which isn't a real tab
        if str(p) in known or h in hashes or h in seen or p.stem.lower() == "song":
            continue
        seen.add(h)
        new.append(str(p))
    if not new:
        print("no new Guitar Pro files")
        return
    infos = gp_info(new)
    for p in new:
        i = infos[p]
        if "error" in i:
            print(f"  can't read {Path(p).name}: {i['error']}")
            continue
        name = clean_name(Path(p).stem)
        title = i["title"] or (name.split(" - ", 1)[1] if " - " in name else name)
        artist = i["artist"] or (name.split(" - ", 1)[0] if " - " in name else "")
        if i["title"]:
            name = f"{artist} - {title}" if artist else title
        if official:
            name += " (official)"
        same = [s for s in db["songs"] if s.get("title", "").lower() == title.lower() and abs((s.get("seconds") or 0) - i["seconds"]) <= 2
                and bool(s.get("official")) == official]
        if same:
            print(f"  = {Path(p).name} is the same song as {same[0]['name']}, skipped")
            continue
        db["songs"].append({"name": name, "title": title, "artist": artist, "gp": p, "sha1": hashlib.sha1(Path(p).read_bytes()).hexdigest()[:16],
                            "seconds": i["seconds"],
                            "instruments": sorted({t["category"] for t in i["tracks"]}), "status": "no video"})
        if official:
            db["songs"][-1].update(official=True, ug=official_url(title))
        print(f"  + {name} ({i['seconds'] // 60}:{i['seconds'] % 60:02d}, {len(i['tracks'])} tracks)")
    save(db)


def cmd_find(db, redo=False, official=False):
    todo = [s for s in db["songs"] if (s["status"] == "no video" or (redo and s["status"] == "suggested"))
            and (s.get("official") or not official)]
    with ytdl() as y:
        for s in todo:
            q = f"{s.get('artist', '')} {s.get('title') or s['name']}".strip()
            res = {}
            # the second finds YouTube's "Artist - Topic" upload of the album track, the third an "Official Audio"
            for query in (q, q + " topic", q + " official audio", f"{s.get('title') or s['name']} {s.get('artist', '')} - Topic"):
                try:
                    for v in y.extract_info(f"ytsearch10:{query}", download=False)["entries"]:
                        res.setdefault(v.get("id"), v)
                except Exception as e:
                    print(f"  {s['name']}: search failed: {str(e).splitlines()[-1][:150]}")
            cands = [{"id": v["id"], "title": v.get("title"), "channel": v.get("channel") or v.get("uploader"),
                      "seconds": v.get("duration")} for v in res.values() if v and v.get("id")]
            for c in cands:
                c["score"] = score_video(c, s)
            cands.sort(key=lambda c: (tier(c, s), -c["score"]))  # the user's order first, then how well it fits
            if not cands:
                print(f"  {s['name']}: nothing found")
                continue
            best = cands[0]
            s["youtube"] = f"https://www.youtube.com/watch?v={best['id']}"
            s["video"] = {k: best[k] for k in ("title", "channel", "seconds")}
            s["confidence"] = best["score"]
            # keep the plausible ones (the right song), so verify can go down the list
            s["others"] = [{"url": f"https://www.youtube.com/watch?v={c['id']}", "title": c["title"], "channel": c["channel"],
                            "seconds": c["seconds"], "score": c["score"]} for c in cands[1:] if c["score"] >= 45 and tier(c, s) < 5][:10]
            s["status"] = "suggested"
            print(f"  {s['name']}: {best['title']} [{best['channel']}] {fmt_len(best['seconds'])} vs tab {fmt_len(s.get('seconds'))} · confidence {best['score']:.0f}")
    save(db)


def cmd_verify(db, name=None, top=8, official=False):
    """Goes down the suggestions in the user's order (tier: the label's or artist's official audio first, music
    videos and other people's uploads last), downloads each, and lines it up with the tab (real.whole_match).
    Confirmed: the best match in the best tier that matches all the way through (the same chords every 10 s,
    the same length every 30 s, no more than a few seconds left over at either end)."""
    sys.path.insert(0, str(HERE))
    import real
    import run
    from playwright.sync_api import sync_playwright
    todo = [find_one(db, name)] if name else [s for s in db["songs"] if s.get("gp") and s.get("youtube")
                                               and s["status"] == "suggested" and (s.get("official") or not official)]
    if not todo:
        print("nothing to check (only suggested songs with a tab are checked; name one to recheck it)")
        return
    srv = run.serve()
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page()
        pg.set_default_timeout(1_200_000)
        pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/tests/yt2gp5/render.html")
        pg.wait_for_function("window.renderReady === true")
        for s in todo:
            folder = real.CACHE / run.slug(s["name"])
            folder.mkdir(parents=True, exist_ok=True)
            cands = [{"url": s["youtube"], **(s.get("video") or {})}] + (s.get("others") or []) + (s.get("tried") or [])
            cands = list({c["url"]: c for c in reversed(cands)}.values())[::-1]  # each video once
            cands = sorted([c for c in cands if tier(c, s) < 5], key=lambda c: (tier(c, s), -(c.get("score") or 0)))[:top]
            print(f"{s['name']} (tab {fmt_len(s.get('seconds'))}):")
            try:
                _, gp_wav = real.render_whole(pg, Path(s["gp"]), folder)
            except Exception as e:
                print(f"  can't play the tab: {e}")
                continue
            best, tried, curves = None, [], []
            for c in cands:
                t = tier(c, s)
                if best and t > best[2]:
                    break  # a match in a better tier wins over anything lower down
                try:
                    m = real.whole_match(gp_wav, real.download(c["url"], folder))
                except Exception as e:
                    print(f"  {c.get('title')}: {str(e).splitlines()[-1][:150]}")
                    continue
                print(f"  {'✓' if m['ok'] else '✗'} [{TIERS[t]}] {c.get('title')} [{c.get('channel')}] {fmt_len(c.get('seconds'))} · {why(m)}")
                tried.append({"url": c["url"], "title": c.get("title"), "channel": c.get("channel"), "tier": t, **summary(m)})
                mp = m["map"][::4]  # every 2 s
                curves.append({**tried[-1], "tab_s": m["tab_s"], "drift": [[a, round(b - a, 2)] for a, b in mp],
                               "parts": [{"tab": q["tab"], "dist": q["dist"], "why": q["why"]} for q in m["parts"]]})
                if m["ok"] and (best is None or m["dist"] < best[0]["dist"]):
                    best = (m, c, t)
            s["tried"] = tried
            if best:
                m, c, t = best
                # keep the rest, so a later verify can still go down the whole list
                s["others"] = [{k: x.get(k) for k in ("url", "title", "channel", "seconds", "score")} for x in cands if x["url"] != c["url"]]
                s.update(youtube=c["url"], video={k: c.get(k) for k in ("title", "channel", "seconds")}, status="confirmed",
                         lineup=m["dist"], match=summary(m))
                print(f"  → confirmed [{TIERS[t]}]: {c.get('title')}")
            else:
                s.pop("match", None)
                c = cands[0]  # the user's first choice stays the suggestion
                s.update(youtube=c["url"], video={k: c.get(k) for k in ("title", "channel", "seconds")}, status="suggested")
                s["others"] = [{k: x.get(k) for k in ("url", "title", "channel", "seconds", "score")} for x in cands[1:]]
                print(f"  none matches all the way through; give the right one with: set \"{s['name']}\" URL, then verify \"{s['name']}\"")
            for cv in curves:
                cv["chosen"] = bool(best) and cv["url"] == best[1]["url"]
            MATCHES.mkdir(parents=True, exist_ok=True)
            (MATCHES / f"{run.slug(s['name'])}.json").write_text(json.dumps({"name": s["name"], "tab_s": s.get("seconds"),
                                                                            "tried": curves}), encoding="utf-8")
            save(db)
        b.close()
    srv.shutdown()
    cmd_report(db)


MATCHES = HERE / "out" / "match"


def cmd_report(db):
    """out/match/report.html: for each checked song, a picture of how each video follows the tab."""
    import html
    sys.path.insert(0, str(HERE))
    import run
    secs = []
    for s in db["songs"]:
        f = MATCHES / f"{run.slug(s['name'])}.json"
        if not f.exists():
            continue
        r = json.loads(f.read_text(encoding="utf-8"))
        if not r["tried"]:
            continue
        secs.append(report_song(r, html.escape))
    page = REPORT.replace("<!--SONGS-->", "\n".join(secs))
    (MATCHES / "report.html").write_text(page, encoding="utf-8")
    print(f"picture: {MATCHES / 'report.html'}")


def report_song(r, esc):
    W, H, L, R, TOP = 760, 200, 44, 10, 10
    tab_s = max(c["tab_s"] for c in r["tried"])
    lim = 15.0
    x = lambda t: L + (W - L - R) * t / tab_s
    y = lambda d: TOP + (H - TOP - 20) * (lim - max(-lim, min(lim, d))) / (2 * lim)
    colors = ["#1565c0", "#ef6c00", "#6a1b9a", "#00838f", "#ad1457", "#558b2f", "#4e342e", "#37474f"]
    chosen = next((c for c in r["tried"] if c["chosen"]), None)
    main = chosen or r["tried"][0]
    g = [f'<rect x="{x(p["tab"][0]):.1f}" y="{TOP}" width="{x(p["tab"][1]) - x(p["tab"][0]):.1f}" height="{H - TOP - 20}" class="badzone"/>'
         for p in main["parts"] if p["why"]]
    for v in (-10, -5, 0, 5, 10):
        g.append(f'<line x1="{L}" x2="{W - R}" y1="{y(v):.1f}" y2="{y(v):.1f}" class="{"zero" if v == 0 else "grid"}"/>'
                 f'<text x="{L - 6}" y="{y(v) + 4:.1f}" class="ax" text-anchor="end">{v:+d}</text>')
    for t in range(0, int(tab_s) + 1, 60):
        g.append(f'<text x="{x(t):.1f}" y="{H - 4}" class="ax" text-anchor="middle">{t // 60}:00</text>')
    rows = []
    for i, c in enumerate(r["tried"]):
        d = c["drift"]
        base = sorted(b for _, b in d)[len(d) // 2]  # a steady offset (an intro) is not a problem: centre on it
        col = "var(--ok)" if c["chosen"] else colors[i % len(colors)]
        pts = " ".join(f"{x(a):.1f},{y(b - base):.1f}" for a, b in d)
        g.append(f'<polyline points="{pts}" fill="none" stroke="{col}" stroke-width="{3 if c is main else 1.3}" opacity="{1 if c is main else 0.7}"/>')
        mark = "✓" if c["ok"] else "✗"
        extra = []
        if c["head_s"] > 1:
            extra.append(f"{c['head_s']:.0f} s extra at the start")
        if c["tail_s"] > 1:
            extra.append(f"{c['tail_s']:.0f} s extra at the end")
        if c["shift"]:
            extra.append(f"other key ({c['shift']:+d})")
        extra += c["bad"][:4]
        rows.append(f'<li><span class="sw" style="background:{col}"></span><b class="{"ok" if c["ok"] else "no"}">{mark}</b> '
                    f'<a href="{esc(c["url"])}" target="_blank" rel="noopener">{esc(c["title"] or "")}</a> '
                    f'<span class="mute">[{esc(c["channel"] or "")} · {TIERS[c["tier"]]}]</span>'
                    f'{"<br><span class=mute>" + esc("; ".join(extra)) + "</span>" if extra else ""}</li>')
    # the chosen (or first) video's chords, every 10 s: green close, red different
    strip = []
    for p in main["parts"]:
        k = max(0.0, min(1.0, (p["dist"] - 0.05) / 0.25))
        col = f"hsl({120 * (1 - k):.0f} 65% 45%)"
        strip.append(f'<rect x="{x(p["tab"][0]):.1f}" y="0" width="{max(1, x(p["tab"][1]) - x(p["tab"][0]) - 1):.1f}" height="16" fill="{col}">'
                     f'<title>{p["tab"][0]:.0f}-{p["tab"][1]:.0f} s: chords {p["dist"]}{" · " + p["why"] if p["why"] else ""}</title></rect>')
    verdict = (f'<span class="ok">Matches all the way through</span>: {esc(chosen["title"] or "")}' if chosen else
               '<span class="no">No video matches all the way through</span>')
    return f"""<section><h2>{esc(r["name"])}</h2><p>{verdict}</p>
<svg viewBox="0 0 {W} {H}" role="img" aria-label="timing of each video against the tab">{"".join(g)}</svg>
<div class="lab">Chords, every 10 s ({"chosen video" if chosen else "first video"}): green same, red different</div>
<svg viewBox="0 0 {W} 16" class="strip"><g transform="translate(0,0)">{"".join(strip)}</g></svg>
<ul>{"".join(rows)}</ul></section>"""


REPORT = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video matches</title><style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--mute:#6b6b66;--line:#deded8;--ok:#2e7d32;--no:#c62828;--bad:rgba(198,40,40,.13)}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--mute:#9a9a94;--line:#33332f;--ok:#66bb6a;--no:#ef5350;--bad:rgba(239,83,80,.18)}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:16px}h1{font-size:20px;margin:0 0 6px}h2{font-size:17px;margin:26px 0 4px}
p{margin:4px 0 8px}.ok{color:var(--ok);font-weight:600}.no{color:var(--no);font-weight:600}.mute{color:var(--mute);font-size:13px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--line)}.zero{stroke:var(--mute);stroke-dasharray:4 3}.ax{fill:var(--mute);font-size:11px}
.badzone{fill:var(--bad)}.strip{margin:2px 0 6px}.lab{color:var(--mute);font-size:13px;margin-top:6px}
ul{padding-left:18px;margin:6px 0}li{margin:3px 0}.sw{display:inline-block;width:12px;height:4px;vertical-align:middle;margin-right:4px}
a{color:inherit}.how{color:var(--mute);border-left:3px solid var(--line);padding-left:10px}
</style></head><body><main><h1>Do the videos match the tabs?</h1>
<p class="how">Each line is one video. It shows how far the recording runs ahead of (up) or behind (down) your tab, in seconds, through the song.
<b>Flat all the way = the same recording, matched from start to end.</b> A step up means the recording has a part the tab doesn't (or plays
slower there); a step down means it's missing one. Red shading marks the stretches that don't match. The coloured bar shows how close the chords are.</p>
<!--SONGS--></main></body></html>"""


TIERS = ["Topic audio", "official audio", "artist upload", "music video", "other upload"]


def summary(m):
    return {k: m[k] for k in ("ok", "dist", "worst", "head_s", "tail_s", "length_ratio", "shift")} | {
        "bad": [f"{p['tab'][0]:.0f}-{p['tab'][1]:.0f} s: {p['why']}" for p in m["bad"]]}


def why(m):
    """One line on how the recording follows the tab."""
    out = [f"chords {m['dist']:.2f} (worst 10 s {m['worst']:.2f})"]
    if m["head_s"] > 1:
        out.append(f"{m['head_s']:.0f} s extra at the start")
    if m["tail_s"] > 1:
        out.append(f"{m['tail_s']:.0f} s extra at the end")
    if m["shift"]:
        out.append(f"{m['shift']:+d} semitones")
    out += [f"{p['tab'][0]:.0f}-{p['tab'][1]:.0f} s {p['why']}" for p in m["bad"][:3]]
    if len(m["bad"]) > 3:
        out.append(f"{len(m['bad']) - 3} more stretches off")
    return ", ".join(out)


def fmt_len(sec):
    return "?" if not sec else f"{int(sec) // 60}:{int(sec) % 60:02d}"


def usable(s):
    """Songs the test and Colab use: confirmed, or suggested with high confidence."""
    if s.get("tried") is not None and s["status"] != "confirmed":
        return False  # verify found no video that matches all the way through
    return s.get("youtube") and (s["status"] == "confirmed" or (s["status"] == "suggested" and s.get("confidence", 0) >= 80))


def cmd_check(db):
    bad = 0
    for s in db["songs"]:
        if not s.get("youtube") or s["status"] == "skipped":
            continue
        v = video_info(s["youtube"])
        if "error" in v:
            s["problem"] = "video gone: " + v["error"]
        elif s.get("seconds") and v["seconds"] and abs(v["seconds"] - s["seconds"]) > max(20, 0.12 * s["seconds"]):
            s["problem"] = f"length {fmt_len(v['seconds'])} but the tab is {fmt_len(s['seconds'])}"
        else:
            s.pop("problem", None)
            continue
        bad += 1
        print(f"  {s['name']}: {s['problem']}")
    save(db)
    print(f"{bad} problem(s)" if bad else "all videos fine")


def cmd_list(db):
    for s in db["songs"]:
        v = s.get("video") or {}
        mark = "✓" if usable(s) else "·"
        extra = f" · {v.get('title')} [{v.get('channel')}] {fmt_len(v.get('seconds'))} vs tab {fmt_len(s.get('seconds'))}" if v else ""
        conf = f" ({s['confidence']:.0f})" if s.get("confidence") is not None and s["status"] == "suggested" else ""
        whole = s.get("match")
        whole = "" if not whole else " · matches all the way through" if whole["ok"] else " · NOT all the way through"
        print(f"{mark} {s['name']} — {s['status']}{conf}{extra}{whole}" + (f" · PROBLEM: {s['problem']}" if s.get("problem") else ""))
    n = sum(map(usable, db["songs"]))
    print(f"\n{n} of {len(db['songs'])} songs ready (✓). Confirm a suggestion with: songdb.py ok NAME, or set NAME URL")


def cmd_export(db):
    lines = [f"{s['youtube']} | {s['name']}" for s in db["songs"] if usable(s)]
    (HERE / "colab_batch.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(lines)} songs → {HERE / 'colab_batch.txt'} (paste into BATCH_LINKS in step 2, or put it in your Drive folder as batch.txt)")


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help", "help"):
        print(__doc__)
        return
    db = load()
    cmd, rest = a[0], a[1:]
    official = "--official" in rest
    rest = [x for x in rest if x != "--official"]
    if cmd == "scan":
        cmd_scan(db, rest, official)
    elif cmd == "find":
        cmd_find(db, redo="--redo" in rest, official=official)
    elif cmd == "set":
        s = find_one(db, rest[0])
        v = video_info(rest[1])
        if "error" in v:
            sys.exit("that video can't be opened: " + v["error"])
        s.update(youtube=f"https://www.youtube.com/watch?v={v['id']}", video={k: v[k] for k in ("title", "channel", "seconds")},
                 status="confirmed", confidence=None)
        s.pop("problem", None)
        save(db)
        print(f"{s['name']}: {v['title']} {fmt_len(v['seconds'])} vs tab {fmt_len(s.get('seconds'))}")
    elif cmd in ("ok", "skip"):
        s = find_one(db, rest[0])
        if cmd == "ok" and not s.get("youtube"):
            sys.exit("no video suggested yet: run find, or use set NAME URL")
        s["status"] = "confirmed" if cmd == "ok" else "skipped"
        save(db)
        print(f"{s['name']}: {s['status']}")
    elif cmd == "add":
        v = video_info(rest[0])
        if "error" in v:
            sys.exit("that video can't be opened: " + v["error"])
        db["songs"].append({"name": v["title"], "title": v["title"], "artist": v["channel"], "gp": None, "seconds": None,
                            "youtube": f"https://www.youtube.com/watch?v={v['id']}", "video": {k: v[k] for k in ("title", "channel", "seconds")},
                            "status": "confirmed"})
        save(db)
        print(f"+ {v['title']} (no tab: used by Colab, not scored)")
    elif cmd == "verify":
        cmd_verify(db, next((x for x in rest if not x.startswith("-")), None), official=official)
    elif cmd == "check":
        cmd_check(db)
    elif cmd == "list":
        cmd_list(db)
    elif cmd == "report":
        cmd_report(db)
    elif cmd == "export":
        cmd_export(db)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
