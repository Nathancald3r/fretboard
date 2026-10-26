"""TabMaker data factory (step 3): turn the downloaded datasets into training examples, all in one format.

  python tools/datafactory.py run [--aam 20] [--from 1] [--no-gtechs] [--gpu]   make examples (resumable)
  python tools/datafactory.py check [--n 5]                                    do the labels line up with the audio?
  python tools/datafactory.py index                                            rebuild train_index.json

Input: %USERPROFILE%\\fretboard-data, filled by `python tools/datasets.py get`.
  - AAM: MIDI + beat annotations (aam-labels). Each song's mix is read from aam-mixes-* if downloaded, otherwise
    just that one file is fetched from the Zenodo zip by byte range (no 15 GB download for a test run).
  - Guitar-TECHS: guitar clips (direct input and mic'd amp) with MIDI, one MIDI track per string.
Output: fretboard-data\\factory\\<source>\\<example>\\ with mono FLAC stems and labels.json:
  {"id", "source", "licence", "sr", "duration", "beats": [[t, bar, beat]], "chords": [[t, name]],
   "instruments": {name: {"group", "stem"}},
   "stems": {stem: {"file", "rms", "instruments": [...], "notes": [[onset, offset, pitch, velocity, instrument(, string, fret)]]}}}
  AAM songs: the mix plus Spleeter's 5 stems (vocals, drums, bass, piano, other). The idea of the plan: train on these
  messy stems with AAM's exact labels. AAM has no singing, so "vocals" has no notes (it holds what Spleeter leaked there).
  Times are seconds from the start of the audio. Guitar-TECHS strings: 1 = high e ... 6 = low E, standard tuning.

Resource caps (the user's rule): CPU at most 60% (the job is pinned to 60% of the cores, low priority);
GPU only with --gpu, held to 85% of its memory. Only commercially cleared tools: Spleeter (MIT), not Demucs.
Spleeter needs Python <= 3.11, so the script makes its own environment (fretboard-data\\.spleeter-env, via uv) and
restarts itself in it.
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

DATA = Path(os.environ.get("FRETBOARD_DATA", Path.home() / "fretboard-data"))
OUT = DATA / "factory"
ENV = DATA / ".spleeter-env"
ENV_PY = ENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
DEPS = ["spleeter==2.4.0", "numpy<2", "soundfile", "mido", "psutil"]
CPU_CAP, GPU_CAP = 0.60, 0.85
SR = 22050  # output sample rate: plenty for transcription, keeps 3,000 songs near 75 GB
STEMS = ["vocals", "drums", "bass", "piano", "other"]
PIANOS = {"Piano", "BrightPiano", "ElectricPiano"}
ZEN = "https://zenodo.org/api/records/5794629/files/{}/content"
GT_STRINGS = {"e": 1, "B": 2, "G": 3, "D": 4, "A": 5, "E": 6}
GT_OPEN = {1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40}
FLUX_BIAS = -0.010  # label_lag reads exact labels (AAM drums/bass/other, rendered from MIDI) ~10 ms early


def say(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------- environment and caps ----------

def ensure_env():
    """Re-run this script inside the Spleeter environment, making it first if needed."""
    if Path(sys.prefix).resolve() == ENV.resolve():
        return
    if not ENV_PY.exists():
        say(f"making the Spleeter environment in {ENV} (once, a few minutes)")
        if subprocess.run([sys.executable, "-m", "uv", "--version"], capture_output=True).returncode:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "uv"])
        subprocess.check_call([sys.executable, "-m", "uv", "venv", "--python", "3.10", str(ENV)])
        subprocess.check_call([sys.executable, "-m", "uv", "pip", "install", "--python", str(ENV_PY), *DEPS])
    sys.exit(subprocess.call([str(ENV_PY), "-I", os.path.abspath(__file__), *sys.argv[1:]]))


def apply_caps(gpu):
    import psutil
    n = max(1, int(os.cpu_count() * CPU_CAP))
    p = psutil.Process()
    try:
        p.cpu_affinity(list(range(n)))
        p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 10)
    except Exception as e:
        say(f"couldn't pin the CPU: {e}")
    for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "TF_NUM_INTRAOP_THREADS"):
        os.environ[k] = str(n)
    os.environ["TF_NUM_INTEROP_THREADS"] = "2"
    os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"
    os.environ["MODEL_PATH"] = str(DATA / ".spleeter-models")
    if not gpu:
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(n)
    tf.config.threading.set_inter_op_parallelism_threads(2)
    if gpu:
        for g in tf.config.list_physical_devices("GPU"):
            total = int(subprocess.check_output(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"]).split()[0])
            tf.config.set_logical_device_configuration(g, [tf.config.LogicalDeviceConfiguration(memory_limit=int(total * GPU_CAP))])
    say(f"caps: {n} of {os.cpu_count()} cores, low priority, GPU {'on, ' + str(int(GPU_CAP * 100)) + '% memory' if gpu else 'off'}")


# ---------- MIDI and annotations ----------

def midi_notes(path):
    """{track name: [[onset, offset, pitch, velocity]]}, times in seconds, using the tempo map of all tracks."""
    import mido
    from mido.midifiles import meta
    if not getattr(meta, "_fb_patched", False):  # AAM writes key signatures like "10 sharps"; we don't need keys
        spec = meta.MetaSpec_key_signature
        old = spec.decode

        def decode(self, message, data):
            try:
                old(self, message, data)
            except Exception:
                message.key = "C"
        spec.decode = decode
        meta._fb_patched = True
    m = mido.MidiFile(path)
    tempos = []
    for tr in m.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "set_tempo":
                tempos.append((t, msg.tempo))
    tempos.sort()
    if not tempos or tempos[0][0] > 0:
        tempos.insert(0, (0, 500000))
    marks, sec = [], 0.0  # (tick, seconds at tick, tempo)
    for i, (tk, tempo) in enumerate(tempos):
        if marks:
            ptk, psec, ptempo = marks[-1]
            sec = psec + (tk - ptk) * ptempo / 1e6 / m.ticks_per_beat
        marks.append((tk, sec, tempo))

    def secs(tk):
        lo = 0
        for i, mk in enumerate(marks):
            if mk[0] <= tk:
                lo = i
        ptk, psec, tempo = marks[lo]
        return psec + (tk - ptk) * tempo / 1e6 / m.ticks_per_beat

    out = {}
    for ti, tr in enumerate(m.tracks):
        t, open_, notes = 0, {}, []
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                open_.setdefault((msg.channel, msg.note), []).append((t, msg.velocity))
            elif msg.type in ("note_off", "note_on"):
                q = open_.get((msg.channel, msg.note))
                if q:
                    on, vel = q.pop(0)
                    notes.append([on, t, msg.note, vel])
        for (ch, pitch), q in open_.items():
            for on, vel in q:
                notes.append([on, t, pitch, vel])
        if notes:
            name = tr.name.strip() or f"track{ti}"
            out.setdefault(name, []).extend([round(secs(a), 4), round(secs(b), 4), p, v] for a, b, p, v in notes)
    for v in out.values():
        v.sort()
    return out


def arff_rows(path):
    rows = []
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        if line and not line.startswith("@") and line[0].isdigit():
            rows.append(next(__import__("csv").reader([line], quotechar="'")))
    return rows


def beats_chords(song):
    beats, chords = [], []
    for r in arff_rows(DATA / "aam-labels" / f"{song}_beatinfo.arff"):
        t = round(float(r[0]), 4)
        beats.append([t, int(float(r[1])), int(float(r[2]))])
        if len(r) > 3 and (not chords or chords[-1][1] != r[3]):
            chords.append([t, r[3]])
    return beats, chords


def aam_groups():
    groups, g = {}, None
    for line in (DATA / "aam-labels" / "instruments.txt").read_text(encoding="utf-8").splitlines():
        if re.match(r"^(Melody|Chords|Bass):", line):
            g = line[:-1].lower()
        m = re.match(r"^\+ (\w+)", line)
        if m:
            groups[m.group(1)] = "drums" if m.group(1) == "Drums" else g
    return groups


def stem_of(name, group):
    if group == "drums":
        return "drums"
    if group == "bass":
        return "bass"
    return "piano" if name in PIANOS else "other"


# ---------- audio ----------

class RemoteZip:
    """Read single members of a Zenodo zip with HTTP Range requests."""

    def __init__(self, name):
        import io, zipfile
        self.url = ZEN.format(name)

        class R(io.RawIOBase):
            def __init__(s):
                s.p = 0
                with urllib.request.urlopen(urllib.request.Request(self.url, method="HEAD"), timeout=60) as r:
                    s.n = int(r.headers["Content-Length"])

            def seekable(s): return True
            def readable(s): return True
            def tell(s): return s.p

            def seek(s, o, w=0):
                s.p = {0: o, 1: s.p + o, 2: s.n + o}[w]
                return s.p

            def readinto(s, b):
                if s.p >= s.n:
                    return 0
                d = self.get(s.p, min(s.n, s.p + len(b)) - 1)
                b[:len(d)] = d
                s.p += len(d)
                return len(d)

        self.zip = zipfile.ZipFile(io.BufferedReader(R(), 1 << 16))
        self.info = {Path(i.filename).name: i for i in self.zip.infolist()}

    def get(self, a, b):
        for attempt in range(6):
            try:
                with urllib.request.urlopen(urllib.request.Request(self.url, headers={"Range": f"bytes={a}-{b}"}), timeout=120) as r:
                    return r.read()
            except Exception as e:
                say(f"  range read failed ({e}), retrying")
                time.sleep(5 * (attempt + 1))
        raise RuntimeError("Zenodo range reads keep failing")

    def extract(self, member, dest):
        import struct
        i = self.info[member]
        if i.compress_type != 0:  # deflated: let zipfile do it
            with self.zip.open(i) as src, open(dest, "wb") as f:
                shutil.copyfileobj(src, f, 1 << 20)
            return
        head = self.get(i.header_offset, i.header_offset + 29)
        n, x = struct.unpack("<HH", head[26:30])
        start = i.header_offset + 30 + n + x
        tmp = Path(str(dest) + ".part")
        tmp.write_bytes(self.get(start, start + i.compress_size - 1))
        tmp.rename(dest)


_zips = {}


def aam_mix(song):
    """Path to the song's mix: a local copy, else fetched once from Zenodo into factory/_cache."""
    local = list(DATA.glob(f"aam-mixes-*/**/{song}_mix.flac"))
    if local:
        return local[0], False
    cache = OUT / "_cache"
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / f"{song}_mix.flac"
    if not dest.exists():
        k = (int(song) - 1) // 1000
        name = f"{k * 1000 + 1:04d}-{k * 1000 + 1000:04d}-audio-mixes.zip"
        if name not in _zips:
            _zips[name] = RemoteZip(name)
        _zips[name].extract(f"{song}_mix.flac", dest)
    return dest, True


def to_mono(x, sr_in):
    import numpy as np
    from math import gcd
    from scipy.signal import resample_poly
    if x.ndim == 2:
        x = x.mean(axis=1)
    if sr_in != SR:
        g = gcd(sr_in, SR)
        x = resample_poly(x, SR // g, sr_in // g)
    return np.clip(x, -1, 1).astype("float32")


def write_flac(path, x):
    import soundfile as sf
    sf.write(str(path), x, SR, subtype="PCM_16", format="FLAC")


def rms(x):
    import numpy as np
    return round(float(np.sqrt(np.mean(np.square(x, dtype="float64")))), 5)


# ---------- makers ----------

_sep = None


def separator():
    global _sep
    if _sep is None:
        from spleeter.separator import Separator
        _sep = Separator("spleeter:5stems", multiprocess=False)
    return _sep


def make_aam(song, groups):
    import numpy as np, soundfile as sf
    from math import gcd
    from scipy.signal import resample_poly
    final = OUT / "aam" / song
    if (final / "labels.json").exists():
        return False
    t0 = time.time()
    notes = {}  # labels first: a bad MIDI fails before the slow separation
    for mid in sorted((DATA / "aam-labels").glob(f"{song}_*.mid")):
        inst = mid.stem.split("_", 1)[1]
        if inst not in groups:  # e.g. NNNN_Demo.mid, all instruments in one file: would double the notes
            continue
        for v in midi_notes(mid).values():
            notes.setdefault(inst, []).extend(v)
    if not notes:
        raise RuntimeError("no MIDI notes")
    mix_path, fetched = aam_mix(song)
    x, sr = sf.read(str(mix_path), dtype="float32", always_2d=True)
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    if sr != 44100:
        g = gcd(sr, 44100)
        x = resample_poly(x, 44100 // g, sr // g, axis=0).astype("float32")
        sr = 44100
    parts = separator().separate(x)
    instruments = {k: {"group": groups.get(k, "chords"), "stem": stem_of(k, groups.get(k, "chords"))} for k in sorted(notes)}
    beats, chords = beats_chords(song)

    tmp = OUT / "aam" / (song + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    stems = {}
    audio = {"mix": x, **parts}
    for name in ["mix", *STEMS]:
        mono = to_mono(audio[name], sr)
        write_flac(tmp / f"{name}.flac", mono)
        insts = sorted(notes) if name == "mix" else [k for k in sorted(notes) if instruments[k]["stem"] == name]
        ns = sorted([*n, k] for k in insts for n in notes[k])
        stems[name] = {"file": f"{name}.flac", "rms": rms(mono), "instruments": insts, "notes": ns}
    labels = {"id": f"aam-{song}", "source": "AAM", "licence": "CC BY 4.0", "sr": SR, "duration": round(len(x) / sr, 3),
              "beats": beats, "chords": chords, "instruments": instruments, "stems": stems}
    (tmp / "labels.json").write_text(json.dumps(labels, separators=(",", ":")), encoding="utf-8")
    shutil.rmtree(final, ignore_errors=True)
    tmp.rename(final)
    if fetched:
        mix_path.unlink()
    say(f"aam {song}: {labels['duration']:.0f} s, {len(instruments)} instruments, {time.time() - t0:.0f} s")
    return True


def gtechs_pairs():
    root = DATA / "guitar-techs"
    for midi_dir in sorted(root.glob("*/midi")):
        part = midi_dir.parent.name
        for mid in sorted(midi_dir.glob("midi_*.mid")):
            name = mid.stem[5:]
            mics = {w.parent.name: w for w in sorted(midi_dir.parent.glob(f"audio/*/*_{name}.wav"))}
            if mics:
                yield f"{part}_{name}", mid, mics


def make_gtechs(ex, mid, mics):
    import soundfile as sf
    final = OUT / "guitar-techs" / ex
    if (final / "labels.json").exists():
        return False
    ns = []
    for track, v in midi_notes(mid).items():
        s = GT_STRINGS.get(track)
        for on, off, p, vel in v:
            ns.append([on, off, p, vel, "ElectricGuitar"] + ([s, p - GT_OPEN[s]] if s else []))
    ns.sort()
    tmp = OUT / "guitar-techs" / (ex + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    audio, dur = {}, 0
    for mic, wav in mics.items():
        x, sr = sf.read(str(wav), dtype="float32", always_2d=True)
        audio[mic] = to_mono(x, sr)
        dur = max(dur, len(x) / sr)
    # Guitar-TECHS MIDI comes ~20-40 ms after the sound (MIDI pickup latency). Measure it on the cleanest
    # signal (direct input) and move the labels onto the audio. AAM needs none: its audio was rendered from the MIDI.
    shift = label_lag(audio.get("directinput", next(iter(audio.values()))), [n[0] for n in ns])
    if shift:
        ns = [[max(0.0, round(n[0] + shift, 4)), max(0.0, round(n[1] + shift, 4)), *n[2:]] for n in ns]
    stems = {}
    for mic, mono in audio.items():
        write_flac(tmp / f"{mic}.flac", mono)
        stems[mic] = {"file": f"{mic}.flac", "rms": rms(mono), "instruments": ["ElectricGuitar"], "notes": ns}
    labels = {"id": f"gtechs-{ex}", "source": "Guitar-TECHS", "licence": "CC BY 4.0", "sr": SR, "duration": round(dur, 3),
              "beats": [], "chords": [], "instruments": {"ElectricGuitar": {"group": "chords", "stem": "other"}},
              "label_shift_ms": round(shift * 1000, 1), "stems": stems}
    (tmp / "labels.json").write_text(json.dumps(labels, separators=(",", ":")), encoding="utf-8")
    shutil.rmtree(final, ignore_errors=True)
    tmp.rename(final)
    say(f"guitar-techs {ex}: {dur:.0f} s, {len(ns)} notes, {', '.join(mics)}")
    return True


def label_lag(mono, onsets, max_ms=80):
    """Seconds to add to the labels so their onsets sit on the audio's onsets (2.9 ms steps); 0 if unsure."""
    import numpy as np
    env, fs = onset_env_x(mono, SR, hop=64)
    ons = np.unique(np.round(np.array(onsets) / fs).astype(int))
    ons = ons[(ons > 40) & (ons < len(env) - 40)]
    if len(ons) < 8:
        return 0.0
    lags = np.arange(-int(max_ms / 1000 / fs), int(max_ms / 1000 / fs) + 1)
    score = np.array([env[ons + L].mean() for L in lags])
    if score.max() < 2 * score.mean():  # no clear peak: leave the labels alone
        return 0.0
    return float(lags[score.argmax()] * fs) - FLUX_BIAS


# ---------- index and check ----------

def index():
    rows, hours, inst_hours, note_hours = [], {}, {}, {}
    for lab in sorted(OUT.glob("*/*/labels.json")):
        d = json.loads(lab.read_text(encoding="utf-8"))
        h = d["duration"] / 3600
        hours[d["source"]] = hours.get(d["source"], 0) + h
        for stem, s in d["stems"].items():
            for k in s["instruments"]:
                if stem != "mix":
                    inst_hours[k] = inst_hours.get(k, 0) + h
            if stem != "mix":
                for n in s["notes"]:
                    note_hours[n[4]] = note_hours.get(n[4], 0) + (n[1] - n[0]) / 3600
        rows.append({"id": d["id"], "folder": str(lab.parent.relative_to(OUT)).replace("\\", "/"), "duration": d["duration"],
                     "stems": list(d["stems"]), "instruments": list(d["instruments"])})
    r = lambda m: {k: round(v, 3) for k, v in sorted(m.items(), key=lambda kv: -kv[1])}
    idx = {"made": time.strftime("%Y-%m-%d %H:%M"), "examples": len(rows), "hours": round(sum(hours.values()), 3),
           "hours_per_source": r(hours),
           "hours_per_instrument": r(inst_hours),
           "note_hours_per_instrument": r(note_hours),
           "note": "hours_per_instrument = audio hours of examples with that instrument (per stem, mixes not counted twice); "
                   "note_hours = summed note lengths. Guitar-TECHS counts each mic as its own stem.",
           "items": rows}
    (OUT / "train_index.json").write_text(json.dumps(idx, indent=1), encoding="utf-8")
    say(f"train_index.json: {len(rows)} examples, {idx['hours']:.2f} h")
    for k, v in idx["hours_per_instrument"].items():
        print(f"  {k:22} {v:6.2f} h")
    return idx


def onset_env(path, hop=256):
    """Spectral-flux onset strength, 1 frame = hop samples (256 = 11.6 ms at 22050)."""
    import soundfile as sf
    x, sr = sf.read(str(path), dtype="float32")
    return onset_env_x(x, sr, hop)


def onset_env_x(x, sr, hop=256):
    import numpy as np
    n = 1024
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(x, (n // 2, n // 2)), n)[::hop] * np.hanning(n)
    mag = np.log1p(100 * np.abs(np.fft.rfft(frames, axis=1)))
    flux = np.maximum(0, np.diff(mag, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(9) / 9, mode="same")  # local mean off
    return np.maximum(flux, 0), hop / sr


def check(n):
    """For a few examples: shift the labels' onsets over the stem's onset curve and find the best fit.
    Lined-up labels peak at 0 ms; the hit rate (an onset peak within 50 ms of a label) should be high."""
    import numpy as np
    labs = sorted(OUT.glob("aam/*/labels.json"))[:n] + sorted(OUT.glob("guitar-techs/*/labels.json"))[:max(1, n // 2)]
    report = []
    for lab in labs:
        d = json.loads(lab.read_text(encoding="utf-8"))
        for stem, s in d["stems"].items():
            if stem in ("mix", "vocals") or not s["notes"]:
                continue
            env, fs = onset_env(lab.parent / s["file"])
            ons = np.unique(np.round(np.array([x[0] for x in s["notes"]]) / fs).astype(int))
            ons = ons[ons < len(env) - 30]
            if len(ons) < 8:
                continue
            lags = range(-17, 18)  # about +-200 ms
            score = [env[np.clip(ons + L, 0, len(env) - 1)].mean() for L in lags]
            best = list(lags)[int(np.argmax(score))]
            peaks = (env > np.roll(env, 1)) & (env >= np.roll(env, -1)) & (env > np.percentile(env, 80))
            pk = np.flatnonzero(peaks)
            near = np.abs(pk[np.searchsorted(pk, ons).clip(0, len(pk) - 1)] - ons)
            near = np.minimum(near, np.abs(pk[(np.searchsorted(pk, ons) - 1).clip(0, len(pk) - 1)] - ons))
            hit = float((near * fs <= 0.05).mean())
            ratio = max(score) / (np.mean(score) + 1e-9)
            report.append({"example": d["id"], "stem": stem, "onsets": int(len(ons)), "best_shift_ms": round(best * fs * 1000),
                           "hit_rate_50ms": round(hit, 2), "peak_over_mean": round(float(ratio), 2)})
            r = report[-1]
            print(f"  {r['example']:28} {stem:12} onsets {r['onsets']:5}  best shift {r['best_shift_ms']:+5} ms  "
                  f"hits {r['hit_rate_50ms']:.0%}  peak/mean {r['peak_over_mean']:.2f}")
    # Dense, even drum patterns can fit as well one 8th note off, so a high hit rate counts too.
    ok = [r for r in report if abs(r["best_shift_ms"]) <= 25 or r["hit_rate_50ms"] >= 0.9]
    say(f"{len(ok)} of {len(report)} stems line up (best shift within 25 ms, or 90% of labels on an onset)")
    weak = [r for r in report if r not in ok]
    if weak:
        say(f"not lined up: {', '.join(sorted({r['stem'] for r in weak}))} (a stem Spleeter leaves nearly empty can't be checked)")
    (OUT / "check.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["run", "check", "index"])
    ap.add_argument("--aam", type=int, default=20, help="how many AAM songs (default 20; 0 = all 3,000)")
    ap.add_argument("--from", dest="start", type=int, default=1, help="first AAM song number (default 1)")
    ap.add_argument("--no-gtechs", action="store_true", help="skip Guitar-TECHS")
    ap.add_argument("--gpu", action="store_true", help="use the GPU (held to 85%% of its memory)")
    ap.add_argument("--n", type=int, default=5, help="check: how many AAM examples")
    a = ap.parse_args()
    ensure_env()
    OUT.mkdir(parents=True, exist_ok=True)
    if a.cmd == "index":
        return index()
    if a.cmd == "check":
        return check(a.n)
    apply_caps(a.gpu)
    songs = sorted({p.name[:4] for p in (DATA / "aam-labels").glob("[0-9][0-9][0-9][0-9]_beatinfo.arff")})
    songs = [s for s in songs if int(s) >= a.start]
    songs = songs[:a.aam] if a.aam else songs
    groups = aam_groups()
    made = 0
    for s in songs:
        try:
            made += make_aam(s, groups)
        except Exception as e:  # one bad song never stops the run; it is retried next time
            say(f"aam {s}: failed: {e!r}")
    if not a.no_gtechs:
        for ex, mid, mics in gtechs_pairs():
            try:
                made += make_gtechs(ex, mid, mics)
            except Exception as e:
                say(f"guitar-techs {ex}: failed: {e!r}")
    say(f"made {made} new examples")
    index()


if __name__ == "__main__":
    main()
