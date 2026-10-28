"""Training data for TabMaker: find and download free, commercially usable, precisely labeled music data.

Rules (autopilot/goals.md, the TabMaker handoff):
  - Train only on CC BY / CC0 / MIT / Apache / public-domain data, or data we make.
  - Never: GuitarSet, MAESTRO, MedleyDB, MUSDB18, IDMT-SMT, DadaGP, Slakh/Lakh, GOAT, UG tabs, YouTube rips.

Commands:
  python tools/datasets.py get [--budget 80] [--only aam,groove]   download the approved list, in order, up to a budget (GB)
  python tools/datasets.py find                                    search Zenodo + Hugging Face for new candidates -> data/CANDIDATES.md
  python tools/datasets.py status                                  what is downloaded

Speed: a steady 80% of the line at home (measured once per network), a low 1 MB/s on a public network
(tools/netcap.py). One stream of pieces runs across all files, so unzipping never stalls the line.
Downloads resume after a break, are checked (md5 or size), unzipped, and the zip is deleted.
Data lives in %USERPROFILE%\\fretboard-data (outside the repo). CREDITS.md there lists every dataset with its
attribution, for the app's Credits page. New candidates are never downloaded by themselves: a CC BY licence on
Zenodo doesn't prove the audio isn't someone's copyrighted song, so a person adds them to APPROVED after a look.
"""
import argparse, hashlib, json, os, queue, shutil, sys, threading, time, urllib.parse, urllib.request, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from netcap import limit  # noqa: E402  a steady 80% of the line; low on public Wi-Fi

DATA = Path(os.environ.get("FRETBOARD_DATA", Path.home() / "fretboard-data"))
KEEP_FREE_GB = 60  # never fill the disk below this

ZEN = "https://zenodo.org/api/records/{rec}/files/{key}/content"
MAG = "https://storage.googleapis.com/magentadata/datasets/"

# Approved datasets, in download order (most useful per GB first). Each file: (name, url, bytes, md5 or None).
APPROVED = [
    {"id": "aam-labels", "title": "AAM: Artificial Audio Multitracks (MIDI, annotations, info)", "licence": "CC BY 4.0",
     "what": "MIDI + beat/chord/onset annotations for all 3,000 songs",
     "credit": "Ostermann, F., Vatolkin, I., Ebeling, M. (2023). AAM: a dataset of Artificial Audio Multitracks for diverse music information retrieval tasks. EURASIP J. Audio Speech Music Process. https://doi.org/10.5281/zenodo.5794629",
     "rec": 5794629, "files": ["info.zip", "0001-1000-midis.zip", "1001-2000-midis.zip", "2001-3000-midis.zip",
                               "0001-1000-annotations-v1.1.0.zip", "1001-2000-annotations-v1.1.0.zip", "2001-3000-annotations-v1.1.0.zip"]},
    {"id": "egmd-midi", "title": "E-GMD MIDI only", "licence": "CC BY 4.0", "what": "444 h of drum performances (MIDI)",
     "credit": "Callender, L., Hawthorne, C., Engel, J. (2020). Improving Perceptual Quality of Drum Transcription with the Expanded Groove MIDI Dataset. https://magenta.tensorflow.org/datasets/e-gmd",
     "urls": [("e-gmd-v1.0.0-midi.zip", MAG + "e-gmd/v1.0.0/e-gmd-v1.0.0-midi.zip", 107076192, None)]},
    {"id": "guitar-techs", "title": "Guitar-TECHS", "licence": "CC BY 4.0",
     "what": "~5 h real electric guitar: notes, chords, scales, techniques, music; per-string capture, aligned MIDI",
     "credit": "Pedroza, H., Abreu, W., Corey, R. M., Roman, I. R. (2025). Guitar-TECHS: An Electric Guitar Dataset Covering Techniques, Musical Excerpts, Chords and Scales Using a Diverse Array of Hardware. ICASSP 2025. https://doi.org/10.5281/zenodo.14963133",
     "rec": 14963133, "files": ["P3_music.zip", "P1_singlenotes.zip", "P2_singlenotes.zip", "P1_techniques.zip", "P2_techniques.zip",
                                "P1_scales.zip", "P2_scales.zip", "P1_chords.zip", "P2_chords.zip"]},
    {"id": "groove", "title": "Groove MIDI Dataset (with audio)", "licence": "CC BY 4.0", "what": "13.6 h of drums, MIDI + audio",
     "credit": "Gillick, J., Roberts, A., Engel, J., Eck, D., Bamman, D. (2019). Learning to Groove with Inverse Sequence Transformations. ICML. https://magenta.tensorflow.org/datasets/groove",
     "urls": [("groove-v1.0.0.zip", MAG + "groove/groove-v1.0.0.zip", 5111599714, None)]},
    {"id": "aam-mixes-1", "title": "AAM mixes, songs 1-1000", "licence": "CC BY 4.0", "what": "full mixes for 1,000 songs",
     "credit": "(see AAM above)", "rec": 5794629, "files": ["0001-1000-audio-mixes.zip"]},
    {"id": "aam-stems-1", "title": "AAM stems, songs 1-1000", "licence": "CC BY 4.0", "what": "one audio file per instrument, 1,000 songs",
     "credit": "(see AAM above)", "rec": 5794629, "files": ["0001-1000-audio-multitracks.zip"]},
    {"id": "aam-mixes-2", "title": "AAM mixes, songs 1001-2000", "licence": "CC BY 4.0", "what": "", "credit": "(see AAM above)",
     "rec": 5794629, "files": ["1001-2000-audio-mixes.zip"]},
    {"id": "aam-mixes-3", "title": "AAM mixes, songs 2001-3000", "licence": "CC BY 4.0", "what": "", "credit": "(see AAM above)",
     "rec": 5794629, "files": ["2001-3000-audio-mixes.zip"]},
    {"id": "aam-stems-2", "title": "AAM stems, songs 1001-2000", "licence": "CC BY 4.0", "what": "", "credit": "(see AAM above)",
     "rec": 5794629, "files": ["1001-2000-audio-multitracks.zip"]},
    {"id": "aam-stems-3", "title": "AAM stems, songs 2001-3000", "licence": "CC BY 4.0", "what": "", "credit": "(see AAM above)",
     "rec": 5794629, "files": ["2001-3000-audio-multitracks.zip"]},
    {"id": "egmd-audio", "title": "E-GMD with audio", "licence": "CC BY 4.0", "what": "444 h of drums, audio + MIDI (96 GB)",
     "credit": "(see E-GMD above)", "urls": [("e-gmd-v1.0.0.zip", MAG + "e-gmd/v1.0.0/e-gmd-v1.0.0.zip", 96422999145, None)]},
]

# Downloaded once and deleted (2026-10-28): nothing reads them. The data factory makes its own stems from the mixes and
# fetches a mix it doesn't have by byte range, so AAM's own stems and the mixes past song 1000 are dead weight (78 GB).
# `get` skips these unless named with --only.
NOT_USED = {"aam-stems-1", "aam-stems-2", "aam-stems-3", "aam-mixes-2", "aam-mixes-3"}

# Never download these, even if a search finds them (the handoff's "Not OK" list).
BANNED = ["lmd", "guitarset", "maestro", "medleydb", "musdb", "idmt", "dadagp", "slakh", "lakh", "goat", "ultimate guitar", "youtube"]
OK_LICENCES = {"cc-by-4.0", "cc-by-3.0", "cc-by-2.0", "cc0-1.0", "cc-zero", "mit", "apache-2.0", "cc-by", "cc0", "pddl", "odc-by", "public domain"}
QUERIES = ["guitar transcription", "guitar tablature", "bass transcription", "electric guitar dataset", "drum transcription dataset",
           "multitrack MIDI aligned audio", "note-level annotations guitar", "automatic music transcription dataset"]


def say(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "fretboard-datasets/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def files_of(ds):
    """[(name, url, size, md5)] for a dataset; Zenodo sizes and md5s come from the record."""
    if "urls" in ds:
        return ds["urls"]
    rec = get_json(f"https://zenodo.org/api/records/{ds['rec']}")
    if rec["metadata"].get("license", {}).get("id") not in OK_LICENCES:
        raise SystemExit(f"{ds['id']}: Zenodo licence is now {rec['metadata'].get('license')}, stopping")
    meta = {f["key"]: f for f in rec["files"]}
    out = []
    for key in ds["files"]:
        f = meta[key]
        out.append((key, ZEN.format(rec=ds["rec"], key=urllib.parse.quote(key)), f["size"], f["checksum"].split(":", 1)[1]))
    return out


def free_gb():
    return shutil.disk_usage(DATA).free / 1e9


CHUNK = 64 << 20        # bytes per piece; a break only loses the pieces in flight
MAX_CONNS = {"zenodo.org": 48, "default": 16}  # Zenodo gives each connection ~1 MB/s; Google ~13 MB/s
START_CONNS = {"zenodo.org": 32, "default": 8}  # measured, so the rate is high from the first minute


class Gate:
    """Lets at most `limit` threads in at once; the limit can change while they run."""

    def __init__(self, limit):
        self.limit, self.active, self.cv = limit, 0, threading.Condition()

    def set(self, n):
        with self.cv:
            self.limit = max(1, int(n))
            self.cv.notify_all()

    def __enter__(self):
        with self.cv:
            while self.active >= self.limit:
                self.cv.wait(1)
            self.active += 1

    def __exit__(self, *a):
        with self.cv:
            self.active -= 1
            self.cv.notify_all()


class Job:
    """One file: a full-size .part written in place by CHUNK pieces; finished pieces are listed in <part>.done."""

    def __init__(self, ds, name, url, size, md5, folder):
        self.ds, self.name, self.url, self.size, self.md5 = ds, name, url, size, md5
        self.dest = folder / name
        self.part = self.dest.with_suffix(self.dest.suffix + ".part")
        self.log = Path(str(self.part) + ".done")
        self.n = max(1, (size + CHUNK - 1) // CHUNK)
        self.host = urllib.parse.urlparse(url).hostname
        if self.dest.exists():  # downloaded, not yet unzipped
            self.done, self.todo = set(range(self.n)), []
            return
        done = {int(x) for x in self.log.read_text().split()} if self.log.exists() else set()
        if self.part.exists() and not self.log.exists():  # an older one-connection .part: keep its whole pieces
            done = set(range(min(self.n, self.part.stat().st_size // CHUNK)))
        self.log.write_text("".join(f"{i}\n" for i in sorted(done)))  # before the resize, so a full-size .part is never taken as old
        with open(self.part, "ab") as f:
            f.truncate(size)
        self.done, self.todo = done, [i for i in range(self.n) if i not in done]


def fetch(job, i, lim, throttled):
    """Download piece i of job at the shared steady rate. Retries; raises after 8 failures."""
    a, b = i * CHUNK, min(job.size, (i + 1) * CHUNK) - 1
    for attempt in range(8):
        pos = a
        try:
            req = urllib.request.Request(job.url, headers={"User-Agent": "fretboard-datasets/1.0", "Range": f"bytes={a}-{b}"})
            with urllib.request.urlopen(req, timeout=120) as r, open(job.part, "r+b") as f:
                if r.status != 206 and not (a == 0 and b + 1 == job.size):
                    raise RuntimeError("server ignored the byte range")
                f.seek(a)
                while pos <= b and (chunk := lim.read(r)):
                    f.write(chunk)
                    pos += len(chunk)
            if pos != b + 1:
                raise RuntimeError(f"piece {i} short")
            return
        except Exception as e:
            wait = 10 * (attempt + 1)
            if getattr(e, "code", None) in (429, 503):  # the server asks us to slow down
                throttled.set()
                try:
                    wait = max(wait, int(e.headers.get("Retry-After") or 0))
                except Exception:
                    pass
            say(f"  {job.name} piece {i}: {e}; retrying in {wait} s")
            time.sleep(wait)
    raise RuntimeError(f"{job.name}: piece {i} failed 8 times; run again to resume")


def finish(job):
    """md5 check, then the .part becomes the file."""
    if job.md5:
        h = hashlib.md5()
        with open(job.part, "rb") as f:
            while b := f.read(1 << 22):
                h.update(b)
        if h.hexdigest() != job.md5:
            job.part.unlink()
            job.log.unlink(missing_ok=True)
            raise RuntimeError(f"{job.name}: md5 mismatch, deleted; run again")
    job.part.rename(job.dest)
    job.log.unlink(missing_ok=True)


def unzip(zpath, folder):
    """Extract, skipping Mac junk (__MACOSX, ._ files, 'Icon\r') and names Windows can't create."""
    bad = set('<>:"|?*') | {chr(c) for c in range(32)}
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            parts = info.filename.replace("\\", "/").split("/")
            if "__MACOSX" in parts or parts[-1].startswith("._") or any(bad & set(p) for p in parts):
                continue
            z.extract(info, folder)


def manifest():
    p = DATA / "manifest.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def save_manifest(m):
    (DATA / "manifest.json").write_text(json.dumps(m, indent=1), encoding="utf-8")
    lines = ["# Training data credits", "", "Every dataset here allows commercial use. Show these on the app's Credits page.", ""]
    seen = set()
    for ds in APPROVED:
        if ds["id"] in m and ds["credit"] not in seen and not ds["credit"].startswith("(see"):
            seen.add(ds["credit"])
            lines += [f"- **{ds['title'].split(' (')[0].split(',')[0]}** ({ds['licence']}): {ds['credit']}"]
    (DATA / "CREDITS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def get(budget_gb, only):
    """One stream of pieces across every file, so the line stays busy at a steady rate: the next file downloads
    while the last one is checked and unzipped in its own thread. Connections grow while each step still helps."""
    DATA.mkdir(parents=True, exist_ok=True)
    lim = limit()
    m = manifest()
    used = sum(v.get("bytes", 0) for v in m.values()) / 1e9
    say(f"data folder {DATA}; {used:.1f} GB already, budget {budget_gb} GB, {free_gb():.0f} GB free on disk")
    lock = threading.RLock()  # next_piece holds it while jobs() runs, which takes it again
    left = {}         # dataset id -> files not yet unzipped
    pending = [0.0]   # GB queued but not yet unzipped
    fin_q, errors, throttled, stop = queue.Queue(), [], threading.Event(), threading.Event()

    def mark_done(ds):
        m[ds["id"]].update(done=True, bytes=int(sum(f[2] for f in ds["_files"])), when=time.strftime("%Y-%m-%d"))
        save_manifest(m)
        say(f"done {ds['id']}")

    def jobs():
        nonlocal used
        for ds in APPROVED:
            if (only and ds["id"] not in only) or m.get(ds["id"], {}).get("done"):
                continue
            if ds["id"] in NOT_USED and ds["id"] not in only:
                continue
            files = files_of(ds)
            size = sum(f[2] for f in files) / 1e9
            if used + size > budget_gb:
                say(f"skip {ds['id']} ({size:.1f} GB): over the {budget_gb} GB budget")
                continue
            if free_gb() - 2 * (size + pending[0]) < KEEP_FREE_GB:  # zip + unzipped copy at once
                say(f"skip {ds['id']} ({size:.1f} GB): would leave under {KEEP_FREE_GB} GB free")
                continue
            say(f"get {ds['id']}: {ds['title']} ({size:.1f} GB, {ds['licence']})")
            ds["_files"] = files
            folder = DATA / ds["id"]
            folder.mkdir(exist_ok=True)
            with lock:
                entry = m.setdefault(ds["id"], {"title": ds["title"], "licence": ds["licence"], "files": {}})
                todo = [f for f in files if entry["files"].get(f[0]) != "unzipped"]
                left[ds["id"]] = len(todo)
                used += size
                if not todo:
                    mark_done(ds)
            for name, url, fsize, md5 in todo:
                with lock:
                    pending[0] += fsize / 1e9
                job = Job(ds, name, url, fsize, md5, folder)
                if job.todo:
                    yield job
                else:
                    fin_q.put(job)

    src, cur, host = jobs(), [None], [None]

    def next_piece():
        with lock:
            while not errors:
                if cur[0] and cur[0].todo:
                    if cur[0].host != host[0] and not lim.public:  # a new server: start at its known count at once
                        gate.limit = max(gate.limit, START_CONNS.get(cur[0].host, START_CONNS["default"]))
                    host[0] = cur[0].host
                    return cur[0], cur[0].todo.pop(0)
                try:
                    cur[0] = next(src)
                except StopIteration:
                    return None
            return None

    def worker():
        while True:
            with gate:
                p = next_piece()
                if p is None:
                    return
                job, i = p
                try:
                    fetch(job, i, lim, throttled)
                except Exception as e:
                    errors.append(e)
                    return
                with lock:
                    job.done.add(i)
                    with open(job.log, "a") as g:
                        g.write(f"{i}\n")
                    if len(job.done) == job.n:
                        fin_q.put(job)

    def finisher():
        while (job := fin_q.get()) is not None:
            try:
                if not job.dest.exists():
                    finish(job)
                say(f"  unzip {job.name}")
                unzip(job.dest, job.dest.parent)
                job.dest.unlink()
            except Exception as e:
                errors.append(e)
                say(f"  {job.name}: {e}")
                continue
            with lock:
                pending[0] -= job.size / 1e9
                m[job.ds["id"]]["files"][job.name] = "unzipped"
                save_manifest(m)
                left[job.ds["id"]] -= 1
                if left[job.ds["id"]] == 0:
                    mark_done(job.ds)

    def steer():
        """Every 15 s: add connections while under the cap and the last step up still helped; halve on 429."""
        best, last_host, frozen, t_log = None, None, 0.0, 0.0
        b0, t0 = lim.bytes, time.time()
        while not stop.wait(15):
            rate = (lim.bytes - b0) / (time.time() - t0)
            b0, t0 = lim.bytes, time.time()
            maxc = MAX_CONNS.get(host[0], MAX_CONNS["default"])
            if time.time() - t_log > 29:
                t_log = time.time()
                j = cur[0]
                say(f"  {rate / 1e6:.1f} MB/s, {gate.limit} connections, {lim.mode} cap {lim.cap / 1e6:.0f} MB/s" +
                    (f"; {j.name} {min(j.size, len(j.done) * CHUNK) / 1e9:.1f} / {j.size / 1e9:.1f} GB" if j else ""))
            if lim.public:
                gate.set(lim.conns)
                best = None
                continue
            if host[0] != last_host:  # a new server (its start count is set in next_piece): measure afresh
                last_host, best, frozen = host[0], None, 0.0
                continue
            if throttled.is_set():
                throttled.clear()
                gate.set(max(2, gate.limit // 2))
                frozen = time.time() + 300
                continue
            if rate >= 0.92 * lim.cap or gate.limit >= maxc or time.time() < frozen:
                continue
            if best and gate.limit > best[1] and rate < best[0] * 1.08:  # the last step up didn't help: back and hold
                gate.set(best[1])
                frozen = time.time() + 300
                continue
            if not best or rate > best[0]:
                best = (rate, gate.limit)
            gate.set(min(maxc, gate.limit * 1.5 + 1))

    gate = Gate(lim.conns or 8)
    fin = threading.Thread(target=finisher, daemon=True)
    fin.start()
    threading.Thread(target=steer, daemon=True).start()
    workers = [threading.Thread(target=worker, daemon=True) for _ in range(max(MAX_CONNS.values()))]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    fin_q.put(None)
    fin.join()
    stop.set()
    if errors:
        raise SystemExit(f"stopped: {errors[0]}")
    say(f"finished: {used:.1f} GB in {DATA}")


MUSIC = ("guitar", "bass guitar", "electric bass", "drum kit", "drums", "music", "musical", "midi", "tablature", "audio effect")
NOT_MUSIC = ("transcription factor", "gene", "protein", "cell", "rna", "manuscript", "ocr", "patient", "robot", "composter", "ear drum", "reads", "climate", "rover", "teaching", "motion capture")
LABELS = ("aligned", "alignment", "midi", "onset", "annotat", "ground truth", "ground-truth", "tablature", "string and fret", "note-level", "transcription", "fret")


def is_music(text):
    t = text.lower()
    return any(w in t for w in MUSIC) and not any(w in t for w in NOT_MUSIC)


def precision(text):
    t = text.lower()
    return sum(w in t for w in LABELS)


def licence_ok(lic):
    lic = (lic or "").lower()
    return any(lic == ok or lic.startswith(ok) for ok in OK_LICENCES) and not any(x in lic.replace("_", "-").split("-") for x in ("nc", "nd", "sa"))


def find():
    """Search for new candidates; write data/CANDIDATES.md. Never downloads."""
    DATA.mkdir(parents=True, exist_ok=True)
    known = {str(d.get("rec")) for d in APPROVED if d.get("rec")}
    seen, rows = set(), []
    for q in QUERIES:
        try:
            d = get_json("https://zenodo.org/api/records?" + urllib.parse.urlencode({"q": q, "size": 25, "type": "dataset", "sort": "mostrecent"}))
        except Exception as e:
            say(f"zenodo '{q}': {e}")
            continue
        for h in d["hits"]["hits"]:
            md = h["metadata"]
            rid, title = str(h["id"]), md["title"]
            lic = (md.get("license") or {}).get("id", "")
            if rid in known or rid in seen:
                continue
            seen.add(rid)
            rows.append(("zenodo", title, lic, sum(f["size"] for f in h.get("files", [])) / 1e9, f"https://zenodo.org/records/{rid}", md.get("publication_date", ""), md.get("description", "")[:3000]))
        try:
            hf = get_json("https://huggingface.co/api/datasets?" + urllib.parse.urlencode({"search": q.split()[0] if "guitar" in q or "bass" in q or "drum" in q else q, "limit": 30, "full": "true"}))
        except Exception as e:
            say(f"huggingface '{q}': {e}")
            hf = []
        for ds in hf:
            rid = ds["id"]
            if rid in seen:
                continue
            seen.add(rid)
            lic = next((t.split(":", 1)[1] for t in ds.get("tags", []) if t.startswith("license:")), "")
            rows.append(("huggingface", rid, lic, None, f"https://huggingface.co/datasets/{rid}", (ds.get("lastModified") or "")[:10], " ".join(ds.get("tags", []))))
    rows = [r for r in rows if is_music(r[1] + " " + r[6])]
    rows.sort(key=lambda r: r[5], reverse=True)
    rows.sort(key=lambda r: -precision(r[1] + " " + r[6]))
    ok = [r for r in rows if licence_ok(r[2]) and not any(b in r[1].lower() for b in BANNED)]
    no = [r for r in rows if r not in ok]
    out = ["# Dataset candidates", "", f"Searched {time.strftime('%Y-%m-%d %H:%M')}. Nothing here is downloaded until it is added to APPROVED in tools/datasets.py.",
           "Before approving one, check that its audio was made for the dataset (not copyrighted songs) and that labels are aligned.", "",
           f"## Licence allows commercial use ({len(ok)})", "", "Labels = how many signs of precise labels (aligned, MIDI, onsets, annotations, tablature) the description shows.", "",
           "| Labels | Source | Name | Licence | Size | Date |", "|---|---|---|---|---|---|"]
    out += [f"| {precision(t + ' ' + x)} | {s} | [{t}]({u}) | {l} | {'' if g is None else f'{g:.1f} GB'} | {d} |" for s, t, l, g, u, d, x in ok]
    out += ["", f"## Not usable: licence missing, non-commercial or banned ({len(no)})", ""]
    out += [f"- [{t}]({u}): {l or 'no licence'}" for s, t, l, g, u, d, x in no]
    (DATA / "CANDIDATES.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    say(f"{len(ok)} usable candidates, {len(no)} not usable -> {DATA / 'CANDIDATES.md'}")


def status():
    m = manifest()
    for ds in APPROVED:
        e = m.get(ds["id"])
        state = "done" if e and e.get("done") else ("partly" if e else ("unused" if ds["id"] in NOT_USED else "-"))
        print(f"{state:7} {ds['id']:14} {ds['title']}")
    print(f"{free_gb():.0f} GB free on disk; data in {DATA}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["get", "find", "status"])
    ap.add_argument("--budget", type=float, default=80, help="GB to download in total (default 80)")
    ap.add_argument("--only", default="", help="comma-separated dataset ids")
    ap.add_argument("--net", choices=["home", "public"], help="treat this network as home or public (default: ask Windows)")
    ap.add_argument("--cap", type=float, help="MB/s limit instead of 80%% of the measured line")
    a = ap.parse_args()
    if a.net:
        os.environ["FRETBOARD_NET"] = a.net
    if a.cap:
        os.environ["FRETBOARD_CAP_MBS" if a.net != "public" else "FRETBOARD_PUBLIC_MBS"] = str(a.cap)
    DATA.mkdir(parents=True, exist_ok=True)
    if a.cmd == "get":
        get(a.budget, {s for s in a.only.split(",") if s})
    elif a.cmd == "find":
        find()
    else:
        status()
