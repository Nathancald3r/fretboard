"""Training data for TabMaker: find and download free, commercially usable, precisely labeled music data.

Rules (autopilot/goals.md, the TabMaker handoff):
  - Train only on CC BY / CC0 / MIT / Apache / public-domain data, or data we make.
  - Never: GuitarSet, MAESTRO, MedleyDB, MUSDB18, IDMT-SMT, DadaGP, Slakh/Lakh, GOAT, UG tabs, YouTube rips.

Commands:
  python tools/datasets.py get [--budget 80] [--only aam,groove]   download the approved list, in order, up to a budget (GB)
  python tools/datasets.py find                                    search Zenodo + Hugging Face for new candidates -> data/CANDIDATES.md
  python tools/datasets.py status                                  what is downloaded

Downloads resume after a break, are checked (md5 or size), unzipped, and the zip is deleted.
Data lives in %USERPROFILE%\\fretboard-data (outside the repo). CREDITS.md there lists every dataset with its
attribution, for the app's Credits page. New candidates are never downloaded by themselves: a CC BY licence on
Zenodo doesn't prove the audio isn't someone's copyrighted song, so a person adds them to APPROVED after a look.
"""
import argparse, hashlib, json, os, shutil, sys, time, urllib.parse, urllib.request, zipfile
from pathlib import Path

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


def download(url, dest, size, md5):
    """Resumable download with a .part file; checks size and md5."""
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    for attempt in range(8):
        if have >= size:
            break
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fretboard-datasets/1.0", "Range": f"bytes={have}-"})
            with urllib.request.urlopen(req, timeout=120) as r, open(part, "ab" if r.status == 206 else "wb") as f:
                if r.status != 206:
                    have = 0
                last = 0
                while chunk := r.read(1 << 20):
                    f.write(chunk)
                    have += len(chunk)
                    if time.time() - last > 30:
                        last = time.time()
                        say(f"  {dest.name}: {have / 1e9:.2f} / {size / 1e9:.2f} GB")
        except Exception as e:  # network blips: wait and resume
            say(f"  {dest.name}: {e}; retrying in {10 * (attempt + 1)} s")
            time.sleep(10 * (attempt + 1))
            have = part.stat().st_size if part.exists() else 0
    if have != size:
        raise RuntimeError(f"{dest.name}: got {have} of {size} bytes")
    if md5:
        h = hashlib.md5()
        with open(part, "rb") as f:
            while b := f.read(1 << 22):
                h.update(b)
        if h.hexdigest() != md5:
            part.unlink()
            raise RuntimeError(f"{dest.name}: md5 mismatch, deleted; run again")
    part.rename(dest)


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
    DATA.mkdir(parents=True, exist_ok=True)
    m = manifest()
    used = sum(v.get("bytes", 0) for v in m.values()) / 1e9
    say(f"data folder {DATA}; {used:.1f} GB already, budget {budget_gb} GB, {free_gb():.0f} GB free on disk")
    for ds in APPROVED:
        if only and ds["id"] not in only:
            continue
        if m.get(ds["id"], {}).get("done"):
            continue
        files = files_of(ds)
        size = sum(f[2] for f in files) / 1e9
        if used + size > budget_gb:
            say(f"skip {ds['id']} ({size:.1f} GB): over the {budget_gb} GB budget")
            continue
        if free_gb() - 2 * size < KEEP_FREE_GB:  # zip + unzipped copy at once
            say(f"skip {ds['id']} ({size:.1f} GB): would leave under {KEEP_FREE_GB} GB free")
            continue
        say(f"get {ds['id']}: {ds['title']} ({size:.1f} GB, {ds['licence']})")
        folder = DATA / ds["id"]
        folder.mkdir(exist_ok=True)
        entry = m.setdefault(ds["id"], {"title": ds["title"], "licence": ds["licence"], "files": {}})
        for name, url, fsize, md5 in files:
            if entry["files"].get(name) == "unzipped":
                continue
            zpath = folder / name
            if not zpath.exists():
                download(url, zpath, fsize, md5)
            say(f"  unzip {name}")
            with zipfile.ZipFile(zpath) as z:
                z.extractall(folder)
            zpath.unlink()
            entry["files"][name] = "unzipped"
            save_manifest(m)
        entry.update(done=True, bytes=int(size * 1e9), when=time.strftime("%Y-%m-%d"))
        used += size
        save_manifest(m)
        say(f"done {ds['id']}")
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
        state = "done" if e and e.get("done") else ("partly" if e else "-")
        print(f"{state:7} {ds['id']:14} {ds['title']}")
    print(f"{free_gb():.0f} GB free on disk; data in {DATA}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["get", "find", "status"])
    ap.add_argument("--budget", type=float, default=80, help="GB to download in total (default 80)")
    ap.add_argument("--only", default="", help="comma-separated dataset ids")
    a = ap.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    if a.cmd == "get":
        get(a.budget, {s for s in a.only.split(",") if s})
    elif a.cmd == "find":
        find()
    else:
        status()
