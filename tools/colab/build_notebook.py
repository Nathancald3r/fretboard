"""Builds tools/colab/youtube_to_gp5.ipynb from the cell sources below."""
import json, sys
from pathlib import Path

OUT = Path(sys.argv[1])

cells = []

def md(text):
    cells.append({"cell_type": "markdown", "metadata": {}, "source": text.strip("\n")})

def code(text):
    cells.append({"cell_type": "code", "metadata": {}, "execution_count": None,
                  "outputs": [], "source": text.strip("\n")})


md(r'''
# YouTube → multi-track Guitar Pro (.gp5)

Paste a YouTube link (or several, in step 2's BATCH_LINKS), run every cell (**Runtime → Run all**), and you get a zip with:

* `song.gp5`: a guitar track (6 strings, EADGBE) and a bass track (4 strings, EADG), 4/4, tempo from the audio
* the stems: `vocals.wav`, `drums.wav`, `bass.wav`, `guitar.wav`, `piano.wav`, `other.wav`
  (the default "uvr" split: Kim Vocal 2 and MDX23C, the models UVR5 users pick, then Demucs; `htdemucs` gives four stems)
* `guitar.mid` and `bass.mid` from basic-pitch

**Before you start:** Runtime → Change runtime type → **T4 GPU** (V100 or A100 work too).
A 4-minute song takes about 4–5 minutes on a T4, setup included. Without a GPU the separation step runs on the CPU and takes 10–20 minutes.

The `.gp5` opens in Fretboard, Guitar Pro, TuxGuitar or MuseScore. It is an automatic transcription:
expect wrong and missing notes, especially when keys and guitars share the `other` stem.

Only use audio you have the right to use for your own practice.
''')

code(r'''
# @title 1. Setup: install the tools, check the GPU, connect Google Drive
# Versions (checked 2026-10-24, Colab on Python 3.12):
# - basic-pitch 0.4.0 asks pip for tensorflow<2.15.1 on Python 3.11 and newer. That TensorFlow
#   doesn't exist for Python 3.12, so a plain "pip install basic-pitch" fails or replaces Colab's
#   own TensorFlow. We install it with --no-deps and run its ONNX model through onnxruntime,
#   which has Python 3.12 wheels. Step 5 always picks the ONNX model, never TensorFlow.
# - resampy must stay below 0.4.3 for basic-pitch.
# - demucs 4.0.1 is the last PyPI release. It uses Colab's own torch and torchaudio.
# - PyGuitarPro 0.10.1 writes .gp5; it is imported as "guitarpro".
# - audio-separator runs UVR5's models (Kim Vocal 2, MDX23C) without UVR's GUI. It is installed with
#   Colab's own torch pinned (-c keep.txt), so nothing swaps in another torch.
# - yt-dlp is NOT pinned on purpose: YouTube changes often and only the newest yt-dlp keeps up.
SAVE_TO_DRIVE = True  # @param {type:"boolean"}
DRIVE_FOLDER = "Fretboard/YouTube to GP5"  # @param {type:"string"}

import sys
print("Python", sys.version.split()[0])
if sys.version_info < (3, 9):
    raise RuntimeError("This notebook needs Python 3.9 or newer. Colab normally has it; "
                       "try Runtime → Disconnect and delete runtime, then run again.")

# - audio-separator and onnx2torch go in with --no-deps, and the few packages the two UVR models need
#   are named below: their full lists would build diffq from source (no Python 3.12 wheel; only
#   its Demucs models use it) and pull in onnx-weekly, which replaces Colab's protobuf.
# Colab already has ffmpeg and libsndfile; apt-get (10-30 s) runs only when ffmpeg is missing.
!which ffmpeg > /dev/null || (apt-get -qq update > /dev/null && apt-get -qq install -y ffmpeg libsndfile1 > /dev/null)
!pip install -q -U yt-dlp
!pip freeze | grep -iE "^(torch|torchaudio|torchvision)==" > /content/keep.txt
!pip install -q demucs==4.0.1 PyGuitarPro==0.10.1 pretty_midi==0.2.11 mido==1.3.3 "resampy>=0.2.2,<0.4.3" mir_eval==0.8.2 onnxruntime soundfile librosa beat-this==1.1.0 onnx ml_collections "rotary-embedding-torch>=0.6.1,<0.7" pydub -c /content/keep.txt
!pip install -q --no-deps basic-pitch==0.4.0 "audio-separator==0.47.1" "onnx2torch-py313==1.6.0"

import gc, json, re, shutil, subprocess, zipfile
from pathlib import Path
import numpy as np
import torch

# Errors from this notebook start with the step name and say what to do, in plain words.
class StepError(RuntimeError):
    pass

def fail(step, what, detail=None):
    msg = f"[{step}] {what}"
    if detail:
        msg += f"\n    Details: {str(detail).strip()[:600]}"
    raise StepError(msg)

if torch.cuda.is_available():
    gpu = torch.cuda.get_device_properties(0)
    print(f"GPU: {gpu.name}, {gpu.total_memory / 2**30:.0f} GB")
else:
    print("No GPU. Separation will run on the CPU (10-20 minutes for a song).\n"
          "To use a GPU: Runtime → Change runtime type → T4 GPU, then run all cells again.")

WORK_ROOT = Path("/content/yt2gp5")
WORK_ROOT.mkdir(parents=True, exist_ok=True)

DRIVE_OUT = None
if SAVE_TO_DRIVE:
    try:
        from google.colab import drive
        drive.mount("/content/drive")
        DRIVE_OUT = Path("/content/drive/MyDrive") / DRIVE_FOLDER
        DRIVE_OUT.mkdir(parents=True, exist_ok=True)
        print("Results will also be saved in Google Drive:", DRIVE_OUT)
    except Exception as e:
        print("Google Drive could not be connected, so results are only downloaded.\n"
              "    Details:", e)
# The separation models (about 1 GB) download once: into Drive when it's connected, so later runs skip it.
import os
MODELS = (DRIVE_OUT.parent / "models") if DRIVE_OUT else Path("/content/models")
MODELS.mkdir(parents=True, exist_ok=True)
os.environ["TORCH_HOME"] = str(MODELS / "torch")  # Demucs keeps its models here
print("Setup done.")
''')

code(r'''
# @title 2. Paste the YouTube link
YOUTUBE_URL = ""  # @param {type:"string"}
# Leave blank to use the video's title.
SONG_NAME = ""  # @param {type:"string"}
# uvr: Kim Vocal 2 takes the vocals and MDX23C the instruments (the models UVR5 users pick), then
#      htdemucs_6s splits the instruments into drums, bass, guitar and piano. The cleanest.
# bssw: BS-Roformer-SW gives all six stems (vocals, guitar, piano, bass, drums, other) by itself.
# htdemucs is fastest (four stems). htdemucs_ft is about 4x slower and a little cleaner.
# htdemucs_6s also splits out guitar and piano, so keys don't end up in the guitar track.
SEPARATION_MODEL = "uvr"  # @param ["uvr", "bssw", "htdemucs", "htdemucs_ft", "htdemucs_6s"]
# Which beat is "1": -1 lets the beat finder decide. If bar lines land on the wrong beat, set 0, 1, 2 or 3.
BEATS_BEFORE_FIRST_DOWNBEAT = -1  # @param {type:"integer"}
# If the .gp5's tempo is twice (or half) what the official tab says, pick "half" (or "double") and run again.
TEMPO = "auto"  # @param ["auto", "half", "double"]
# MIDI sound for the guitar track: 25 steel acoustic, 26 jazz, 27 clean electric, 29 overdrive, 30 distortion.
GUITAR_PROGRAM = 25  # @param {type:"integer"}

# Several songs: paste their links here (separated by spaces), or leave it blank and put batch.txt
# (one "link | name" per line, made by Fretboard's songdb.py export) in the Drive folder from step 1.
BATCH_LINKS = ""  # @param {type:"string"}

YT = r"https?://(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)/\S+"
YOUTUBE_URL = YOUTUBE_URL.strip()
BATCH = [(u, "") for u in re.findall(YT, BATCH_LINKS)]
if not BATCH and not YOUTUBE_URL and DRIVE_OUT and (DRIVE_OUT / "batch.txt").exists():
    for line in (DRIVE_OUT / "batch.txt").read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*(" + YT + r")\s*(?:\|\s*(.*))?$", line)
        if m:
            BATCH.append((m.group(1), (m.group(2) or "").strip()))
    print(f"Read {len(BATCH)} links from {DRIVE_OUT / 'batch.txt'}")
if BATCH:
    print(f"Batch mode: {len(BATCH)} songs. Run all cells; step 8 does them one by one.")
elif not re.match(r"^" + YT, YOUTUBE_URL):
    fail("Input", "Paste a YouTube link into YOUTUBE_URL (it starts with https://www.youtube.com/ "
                  "or https://youtu.be/), then run this cell again.")
else:
    print("Link OK:", YOUTUBE_URL)
''')

code(r'''
# @title 3. Download the audio as a 44.1 kHz WAV
def slug(text, fallback="song"):
    """A safe folder and file name made from a title."""
    s = re.sub(r"[^\w\- ]+", "", text, flags=re.UNICODE).strip()
    s = re.sub(r"\s+", " ", s)[:80]
    return s or fallback

def download_audio(url, work_root):
    """Downloads the best audio stream with yt-dlp, then converts it with ffmpeg to a
    stereo 16-bit 44.1 kHz WAV. Returns (wav_path, title, work_dir)."""
    import yt_dlp
    tmp = work_root / "_download"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    opts = {"format": "bestaudio/best", "outtmpl": str(tmp / "audio.%(ext)s"),
            "noplaylist": True, "quiet": True, "no_warnings": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            got = (info.get("requested_downloads") or [{}])[0].get("filepath") or ydl.prepare_filename(info)
    except yt_dlp.utils.DownloadError as e:
        fail("Download", "YouTube didn't give the audio. Check that the link is one public video "
                         "(not private, age-restricted or members-only), then try again. If it "
                         "worked before, YouTube may have changed: run step 1 again for the newest yt-dlp.", e)
    title = info.get("title") or "song"
    work = work_root / slug(SONG_NAME or title)
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    wav = work / "song.wav"
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(got), "-vn",
                        "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(wav)],
                       capture_output=True, text=True)
    if r.returncode != 0 or not wav.exists():
        fail("Download", "ffmpeg couldn't turn the download into a WAV. Run step 1 again "
                         "(it installs ffmpeg).", r.stderr)
    shutil.rmtree(tmp, ignore_errors=True)
    return wav, title, work

# --- run ---  (everything above is the library the local test loop also uses)
MIX_WAV, VIDEO_TITLE, WORK = download_audio(YOUTUBE_URL, WORK_ROOT)
SONG_TITLE = SONG_NAME.strip() or VIDEO_TITLE
import soundfile as sf
print(f"Saved {MIX_WAV} ({sf.info(str(MIX_WAV)).duration / 60:.1f} min): {SONG_TITLE}")
''')

code(r'''
# @title 4. Separate the stems (UVR5 models + Demucs, or Demucs alone)
import logging
import soundfile as sf

def read_wav(path, rate=44100):
    """A WAV as a (2, samples) float tensor at `rate`."""
    import julius
    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)  # (samples, channels)
    wav = torch.from_numpy(audio.T.copy())
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    wav = wav[:2]
    return julius.resample_frac(wav, sr, rate) if sr != rate else wav

def uvr_stem(model_file, wav_path, stem, work):
    """One stem ("Vocals" or "Instrumental") of a UVR5 model, run by audio-separator; stem=None gives
    {name: stem} for every stem the model makes (BS-Roformer-SW: six).
    Kim Vocal 2 is an ONNX model, which audio-separator runs with onnxruntime, on the CPU unless onnxruntime's
    GPU build finds the CUDA it was built for (4 min a song, not 15 s). So it is turned into a torch model
    and run on the GPU at its own segment size: the vocals are the same as onnxruntime's (-97 dB)."""
    from audio_separator.separator import Separator
    from audio_separator.separator.architectures import mdx_separator
    import onnx, onnx2torch

    def torch_load(self):
        self.model_run = onnx2torch.convert(onnx.load(self.model_path)).to(self.torch_device).eval()
    mdx_separator.MDXSeparator.load_model = torch_load
    work.mkdir(parents=True, exist_ok=True)
    try:
        sep = Separator(output_dir=str(work), model_file_dir=str(MODELS / "uvr"), output_format="WAV",
                        sample_rate=44100, log_level=logging.WARNING, output_single_stem=stem,  # only the stem we use (None: all)
                        mdx_params={"hop_length": 1024, "segment_size": 256, "overlap": 0.25, "batch_size": 1,
                                    "enable_denoise": False},
                        # MDX23C: 4 overlapping passes, not its default 8. Half the time; the instrumental
                        # differs by -39 dB (inaudible). Measured on a 216 s song, 2026-10-25.
                        mdxc_params={"segment_size": 256, "override_model_segment_size": False, "batch_size": 1,
                                     "overlap": 4, "pitch_shift": 0})
        sep.load_model(model_filename=model_file)
        out = [Path(f) if Path(f).is_absolute() else work / Path(f).name for f in sep.separate(str(wav_path))]
    except Exception as e:
        fail("Separation", f"The UVR model {model_file} stopped with an error. Run step 1 again, or pick "
                           "SEPARATION_MODEL = htdemucs_6s in step 2.", e)
    if stem:
        got = read_wav(next(f for f in out if f"({stem})" in f.name))
    else:
        got = {f.name.split("_(")[-1].split(")")[0].lower(): read_wav(f) for f in out}
    for f in out:
        f.unlink(missing_ok=True)
    del sep
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return got

def separate_stems(wav_path, out_dir, model_name="uvr"):
    """Splits the mix into stems and writes <stem>.wav files into out_dir. Returns {stem name: path}.
    "uvr": Kim Vocal 2 gives the vocals, MDX23C the instruments, htdemucs_6s splits those into drums,
    guitar and piano, htdemucs_ft's bass model gives the bass, and "other" is what's left of the
    instruments. Else one Demucs model."""
    if model_name == "uvr":
        vocals = uvr_stem("Kim_Vocal_2.onnx", wav_path, "Vocals", out_dir / "_uvr")
        inst = uvr_stem("MDX23C-8KFFT-InstVoc_HQ.ckpt", wav_path, "Instrumental", out_dir / "_uvr")
        n = min(vocals.shape[1], inst.shape[1])
        inst = inst[:, :n]
        six = demucs_split(inst, "htdemucs_6s")
        stems = {k: six[k] for k in ("drums", "guitar", "piano")}
        # Where there is no bass, htdemucs_6s's bass still leaks at -20 dB, the ft bass model's at -45 dB:
        # cleaner notes for basic-pitch, for 6 s more on a T4 (measured 2026-10-25).
        stems["bass"] = demucs_split(inst, "htdemucs_ft", only="bass")["bass"]
        stems["other"] = inst - sum(stems.values())
        stems["vocals"] = vocals[:, :n]
        shutil.rmtree(out_dir / "_uvr", ignore_errors=True)
    elif model_name == "bssw":
        stems = uvr_stem("BS-Roformer-SW.ckpt", wav_path, None, out_dir / "_uvr")
        n = min(v.shape[1] for v in stems.values())
        stems = {k: v[:, :n] for k, v in stems.items()}
        shutil.rmtree(out_dir / "_uvr", ignore_errors=True)
    else:
        stems = demucs_split(read_wav(wav_path), model_name)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, src in stems.items():
        p = out_dir / f"{name}.wav"
        sf.write(str(p), np.clip(src.numpy().T, -1, 1), 44100, subtype="PCM_16")
        paths[name] = p
    return paths

def demucs_split(wav, model_name, only=None):
    """{stem: (2, samples) CPU tensor at 44.1 kHz} from one Demucs model (all of them work at 44.1 kHz).
    only="bass" with htdemucs_ft runs just its bass model (ft is four models, one tuned per stem).
    On a GPU out-of-memory error it retries with shorter segments, then on the CPU."""
    from demucs.pretrained import get_model
    from demucs.apply import apply_model

    try:
        model = get_model(model_name)
    except Exception as e:
        fail("Separation", f"The Demucs model '{model_name}' couldn't be downloaded. "
                           "Check the Colab internet connection and run this cell again.", e)
    if only:
        model = model.models[model.sources.index(only)]
    model.eval()
    # Demucs expects the mix normalised; the stems are scaled back afterwards.
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    mix = ((wav - mean) / std)[None]  # stays on the CPU: the full-length result is built there

    # Each try: (device, segment length in seconds or None for the model's own).
    tries = [("cpu", None)]
    if torch.cuda.is_available():
        tries = [("cuda", None), ("cuda", 4.0), ("cuda", 2.0), ("cpu", None)]
    sources = None
    for device, segment in tries:
        try:
            print(f"Separating on {device}" + (f", {segment:g} s segments" if segment else "") + " ...")
            model.to(device)
            with torch.no_grad():
                sources = apply_model(model, mix, device=device, segment=segment,
                                      split=True, overlap=0.25, shifts=1, progress=True)[0]
            break
        except Exception as e:  # torch.cuda.OutOfMemoryError is a RuntimeError
            if device == "cuda" and "out of memory" in str(e).lower():
                print("The GPU ran out of memory; trying again with less.")
                model.to("cpu")
                gc.collect()
                torch.cuda.empty_cache()
                continue
            fail("Separation", "Demucs stopped with an error.", e)
    if sources is None:
        fail("Separation", "Demucs ran out of memory even on the CPU. Try a shorter song.")

    sources = sources * std + mean
    out = {name: src.cpu() for name, src in zip(model.sources, sources)}

    # Free the model and the GPU before the next steps.
    del model, sources, mix
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return out

# --- run ---
if "MIX_WAV" not in globals():
    fail("Separation", "Run step 3 (Download) first.")
STEMS = separate_stems(MIX_WAV, WORK / "stems", SEPARATION_MODEL)
print("Stems:", ", ".join(str(p) for p in STEMS.values()))
''')

code(r'''
# @title 5. Transcribe bass and guitar to MIDI with basic-pitch
import logging
import pretty_midi
logging.getLogger().setLevel(logging.ERROR)  # hide basic-pitch's "X is not installed" notes about unused backends
from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
from basic_pitch.inference import predict
logging.getLogger().setLevel(logging.WARNING)

# Always the ONNX model (see step 1): Colab's TensorFlow is too new for basic-pitch's TF model.
BASIC_PITCH_MODEL = build_icassp_2022_model_path(FilenameSuffix.onnx)

# Note ranges as MIDI numbers: bass E1-G4, guitar E2-E6.
# onset_threshold: how sure a note start must be (higher = fewer, cleaner notes).
# frame_threshold: how long a note keeps sounding (higher = shorter notes).
# min_note_ms: shorter blips are dropped.
TRANSCRIBE = {
    "bass":   dict(low=28, high=67, onset_threshold=0.5, frame_threshold=0.3, min_note_ms=90, program=33),
    "guitar": dict(low=40, high=88, onset_threshold=0.5, frame_threshold=0.25, min_note_ms=60, program=25),  # notecheck.py, 2026-10-25
}

def midi_hz(n):
    return 440.0 * 2 ** ((n - 69) / 12)

def transcribe(stem_wav, midi_out, kind, program=None):
    """Runs basic-pitch on one stem and writes a MIDI file that keeps each note's pitch,
    start, end and velocity. Notes outside the instrument's range are dropped."""
    s = dict(TRANSCRIBE[kind])
    if program is not None:
        s["program"] = program
    try:
        _, midi, _ = predict(
            str(stem_wav), BASIC_PITCH_MODEL,
            onset_threshold=s["onset_threshold"], frame_threshold=s["frame_threshold"],
            minimum_note_length=s["min_note_ms"],
            # half a semitone of room around the range; the exact cut is below
            minimum_frequency=midi_hz(s["low"] - 0.5), maximum_frequency=midi_hz(s["high"] + 0.5),
            multiple_pitch_bends=False, melodia_trick=True)
    except Exception as e:
        fail("Transcription", f"basic-pitch couldn't read {Path(stem_wav).name}. Run step 1 again; "
                              "if it still fails, onnxruntime may not have installed.", e)
    out = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=s["program"], name=kind.capitalize())
    for src in midi.instruments:
        inst.notes += [n for n in src.notes if s["low"] <= n.pitch <= s["high"] and n.end > n.start]
    inst.notes.sort(key=lambda n: (n.start, n.pitch))
    out.instruments.append(inst)
    out.write(str(midi_out))
    return midi_out, len(inst.notes)

def guitar_stem(stems):
    """The stem to read guitar from: 'guitar' with htdemucs_6s, else 'other'."""
    return stems.get("guitar") or stems["other"]

# --- run ---
if "STEMS" not in globals():
    fail("Transcription", "Run step 4 (Separation) first.")
BASS_MID, n_bass = transcribe(STEMS["bass"], WORK / "bass.mid", "bass")
GUITAR_MID, n_guitar = transcribe(guitar_stem(STEMS), WORK / "guitar.mid", "guitar", GUITAR_PROGRAM)
print(f"bass.mid: {n_bass} notes, guitar.mid: {n_guitar} notes")
if n_guitar == 0:
    print(f"No guitar notes were found in the '{guitar_stem(STEMS).stem}' stem; the guitar track will be empty.")
''')

code(r'''
# @title 6a. Guitar Pro builder (functions only; step 6b runs them)
import guitarpro
from guitarpro import models as gpm

GUITAR_TUNING = [64, 59, 55, 50, 45, 40]  # string 1 (high e) to string 6 (low E): E4 B3 G3 D3 A2 E2
BASS_TUNING = [43, 38, 33, 28]            # string 1 (G) to string 4 (low E): G2 D2 A1 E1
MAX_FRET = 20
MAX_SPAN = 4            # highest fretted note minus lowest fretted note, in frets (open strings are free)
MAX_GUITAR_NOTES = 4    # notes kept per guitar chord before fingering: playable shapes, not stacked blocks
STEPS_PER_BAR = 16      # 4/4 counted in 16th notes

# (length in 16ths, Guitar Pro note value, dotted, the bar position it must start on a multiple of)
NOTE_VALUES = [(16, 1, False, 16), (12, 2, True, 4), (8, 2, False, 8), (6, 4, True, 2),
               (4, 4, False, 4), (3, 8, True, 1), (2, 8, False, 2), (1, 16, False, 1)]


def read_midi_notes(midi_path):
    """All notes of a MIDI file as (start s, end s, pitch, velocity), sorted by start."""
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    notes = [(n.start, n.end, n.pitch, n.velocity) for inst in pm.instruments if not inst.is_drum
             for n in inst.notes]
    return sorted(notes)


def find_beats(mix_wav):
    """Beat times (seconds) of the song, and which beat is the first downbeat (0-3).
    Beat This! (a neural beat tracker, 2024) finds beats and downbeats; it keeps tempo and bar
    lines right far more often than librosa, which tends to double slow songs. If it can't run,
    librosa's beat tracker is used, and beat 0 is taken as the downbeat."""
    beats = downbeats = None
    try:
        import torch
        from beat_this.inference import File2Beats
        device = "cuda" if torch.cuda.is_available() else "cpu"
        f2b = File2Beats(checkpoint_path="final0", device=device, dbn=False)
        beats, downbeats = f2b(str(mix_wav))
        del f2b
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as e:
        print("Beat This! didn't run, so librosa finds the beats instead:", str(e).splitlines()[0][:200])
    if beats is None or len(beats) < 8:
        import librosa
        y, sr = librosa.load(str(mix_wav), sr=22050, mono=True)
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
        tempo = float(np.atleast_1d(tempo)[0])
        downbeats = None
        if len(beats) < 8:
            # Too few beats (a free-time intro, or a quiet song): use an even grid at librosa's tempo.
            print("Few beats found; using an even grid.")
            beats = np.arange(0, len(y) / sr, 60.0 / (tempo or 120.0))
    beats = np.asarray(beats, dtype=float)
    offset = 0
    if downbeats is not None and len(downbeats):
        # The downbeats vote for which beat (counting in fours) is "1".
        idx = [int(np.argmin(np.abs(beats - d))) for d in downbeats]
        offset = int(np.bincount([i % 4 for i in idx], minlength=4).argmax())
    return beats, offset


def change_tempo(beats, offset, how):
    """"half" keeps every other beat (a song counted twice too fast), "double" adds a beat between each
    two. The first downbeat stays where it was. Returns (beats, offset)."""
    beats = np.asarray(beats, dtype=float)
    if how == "half" and len(beats) >= 16:
        return beats[offset % 2::2], (offset // 2) % 4
    if how == "double" and len(beats) >= 2:
        mid = (beats[:-1] + beats[1:]) / 2
        out = np.empty(len(beats) + len(mid))
        out[0::2], out[1::2] = beats, mid
        return out, (2 * offset) % 4
    return beats, offset


def make_grid(beat_times, offset_beats=0, first_note=0.0):
    """Returns (to_step, to_seconds, bpm). to_step(seconds) gives the 16th-note step from the
    start of bar 1, and to_seconds(step) goes back. Notes are placed against the detected beats,
    so a song that drifts in tempo still lines up with its bars. Beat number offset_beats of the
    detected beats is a downbeat, and bar 1 starts on the last downbeat at or before the first
    note, so no empty bars lead in (to_seconds(0) says where bar 1 is in the audio)."""
    b = np.asarray(beat_times, dtype=float)
    if len(b) < 2:
        fail("Guitar Pro", "Not enough beats were found to set a tempo. Is the song mostly silent?")
    first, last = b[1] - b[0], b[-1] - b[-2]
    idx = np.arange(len(b), dtype=float)

    def beat_pos(t):
        t = np.asarray(t, dtype=float)
        pos = np.interp(t, b, idx)
        pos = np.where(t < b[0], (t - b[0]) / first, pos)
        return np.where(t > b[-1], len(b) - 1 + (t - b[-1]) / last, pos)

    def beat_time(pos):
        pos = np.asarray(pos, dtype=float)
        t = np.interp(pos, idx, b)
        t = np.where(pos < 0, b[0] + pos * first, t)
        return np.where(pos > len(b) - 1, b[-1] + (pos - len(b) + 1) * last, t)

    k = int(offset_beats)
    # A note a hair before the downbeat still belongs to that bar, hence the 1/8-beat allowance.
    start = k + 4 * np.floor((beat_pos(first_note) + 0.125 - k) / 4)

    def to_step(t):
        return np.rint((beat_pos(t) - start) * 4).astype(int)

    def to_seconds(step):
        return beat_time(start + np.asarray(step, dtype=float) / 4)

    bpm = 60.0 / float(np.median(np.diff(b)))
    return to_step, to_seconds, bpm


# Krumhansl-Kessler key profiles, C first.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
FIFTHS = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1}


def estimate_key(notes):
    """Key from the notes (start, end, pitch, ...), weighted by length.
    Returns (name like "G major", sharps (+) or flats (-) of its key signature, minor?)."""
    hist = np.zeros(12)
    for n in notes:
        hist[n[2] % 12] += max(0.05, min(n[1] - n[0], 2.0))
    if hist.sum() == 0:
        return "C major", 0, False
    best = None
    for tonic in range(12):
        for minor, prof in ((False, MAJOR_PROFILE), (True, MINOR_PROFILE)):
            r = np.corrcoef(hist, np.roll(prof, tonic))[0, 1]
            if best is None or r > best[0]:
                best = (r, tonic, minor)
    _, tonic, minor = best
    fifths = FIFTHS[(tonic + 3) % 12 if minor else tonic]
    return f"{NOTE_NAMES[tonic]} {'minor' if minor else 'major'}", fifths, minor


def group_chords(notes, to_step, mono=False):
    """Snaps note starts and ends to the 16th grid and groups notes that start on the same step.
    Returns a sorted list of (step, length in 16ths, [(pitch, velocity), ...]). A chord lasts
    until its longest note ends, but never past the next chord's start.
    mono=True keeps only the lowest note of each chord (for bass)."""
    if not notes:
        return []
    starts = to_step([n[0] for n in notes])
    ends = to_step([n[1] for n in notes])
    by_step = {}
    for (s, e, p, v), a, z in zip(notes, starts, ends):
        a = max(int(a), 0)
        c = by_step.setdefault(a, {"end": a + 1, "notes": {}})
        c["end"] = max(c["end"], int(z), a + 1)
        c["notes"][p] = max(v, c["notes"].get(p, 0))  # same pitch twice: keep the louder
    steps = sorted(by_step)
    chords = []
    for i, a in enumerate(steps):
        end = by_step[a]["end"]
        if i + 1 < len(steps):
            end = min(end, steps[i + 1])
        ns = sorted(by_step[a]["notes"].items())
        if mono:
            ns = ns[:1]
        chords.append((a, end - a, ns))
    return chords


def thin_chord(notes, keep):
    """Keeps at most `keep` notes: always the lowest and highest, then the loudest of the rest."""
    if len(notes) <= keep:
        return notes
    inner = sorted(notes[1:-1], key=lambda pv: -pv[1])[:keep - 2]
    return sorted([notes[0], notes[-1]] + inner)


def finger_chord(notes, tuning, hand, max_fret=MAX_FRET, max_span=MAX_SPAN):
    """Chooses a string and fret for each note of one chord with a small cost search.
    Rules: one note per string, fretted notes within max_span frets, close to the hand's last
    position (hand = lowest fretted fret of the previous chord, or None). A note that can't be
    placed is dropped; the lowest and highest notes are the most expensive to drop.
    Returns ([(string number, fret, velocity)], new hand position)."""
    n = len(notes)
    if n == 0:
        return [], hand
    order = sorted(range(n), key=lambda i: -notes[i][0])  # high notes first
    options = []
    for i in order:
        pitch, vel = notes[i]
        opts = [(s + 1, pitch - open_) for s, open_ in enumerate(tuning) if 0 <= pitch - open_ <= max_fret]
        edge = 2.0 if i in (0, n - 1) else 1.0
        options.append((opts, edge * (6.0 + vel / 16.0), vel))

    best = [float("inf"), None]

    def finish(chosen, dropped_cost):
        fretted = [f for _, f, _ in chosen if f > 0]
        low = min(fretted) if fretted else None
        cost = dropped_cost
        cost += sum(0.08 * f for _, f, _ in chosen)                      # lower frets are easier
        if low is not None and hand is not None:
            cost += 0.6 * abs(low - hand)                                 # stay near the hand
        if fretted:
            cost += 0.3 * (max(fretted) - low)                            # smaller stretch
        used = sorted(s for s, _, _ in chosen)
        if used:
            cost += 0.5 * (used[-1] - used[0] + 1 - len(used))           # skipped strings
        if cost < best[0]:
            best[0], best[1] = cost, list(chosen)

    def search(k, chosen, used, lo, hi, dropped_cost):
        if dropped_cost >= best[0]:
            return
        if k == len(options):
            finish(chosen, dropped_cost)
            return
        opts, drop_cost, vel = options[k]
        for s, f in opts:
            if s in used:
                continue
            nlo, nhi = lo, hi
            if f > 0:
                nlo, nhi = min(lo, f), max(hi, f)
                if nhi - nlo > max_span:
                    continue
            chosen.append((s, f, vel))
            used.add(s)
            search(k + 1, chosen, used, nlo, nhi, dropped_cost)
            used.discard(s)
            chosen.pop()
        search(k + 1, chosen, used, lo, hi, dropped_cost + drop_cost)  # or drop this note

    search(0, [], set(), 99, -1, 0.0)
    chosen = best[1] or []
    fretted = [f for _, f, _ in chosen if f > 0]
    return sorted(chosen), (min(fretted) if fretted else hand)


def split_length(pos, length):
    """Cuts a note or rest that starts at 16th `pos` into Guitar Pro note values that don't
    cross a bar line. Yields (value, dotted, length in 16ths); the caller ties the pieces."""
    while length > 0:
        in_bar = pos % STEPS_PER_BAR
        for n16, value, dotted, align in NOTE_VALUES:
            if n16 <= length and in_bar % align == 0 and in_bar + n16 <= STEPS_PER_BAR:
                yield value, dotted, n16
                pos += n16
                length -= n16
                break


def fill_track(track, headers, chords, tuning, guitar):
    """Writes fingered chords, rests and ties into one track's measures.
    Returns (notes dropped, [(step, pitch) of every note written])."""
    total = len(headers) * STEPS_PER_BAR
    measures = []
    for h in headers:
        m = gpm.Measure(track, h)
        measures.append(m)
    track.measures = measures

    events, t, hand, dropped, placed = [], 0, None, 0, []
    for step, length, notes in chords:
        if step >= total:
            break
        if step > t:
            events.append((t, step - t, None))
        if guitar:
            kept = thin_chord(notes, MAX_GUITAR_NOTES)
            dropped += len(notes) - len(kept)
            notes = kept
        fingered, hand = finger_chord(notes, tuning, hand)
        dropped += len(notes) - len(fingered)
        placed += [(step, tuning[s - 1] + f) for s, f, _ in fingered]
        events.append((step, min(length, total - step), fingered or None))
        t = step + length
    if t < total:
        events.append((t, total - t, None))

    for start, length, fingered in events:
        pos, first = start, True
        for value, dotted, n16 in split_length(start, length):
            voice = measures[pos // STEPS_PER_BAR].voices[0]
            beat = gpm.Beat(voice, duration=gpm.Duration(value=value, isDotted=dotted))
            if fingered:
                beat.status = gpm.BeatStatus.normal
                for string, fret, vel in fingered:
                    beat.notes.append(gpm.Note(beat, value=fret, string=string,
                                               velocity=int(min(127, max(15, vel))),
                                               type=gpm.NoteType.normal if first else gpm.NoteType.tie))
            else:
                beat.status = gpm.BeatStatus.rest
            voice.beats.append(beat)
            pos += n16
            first = False
    return dropped, placed


def artist_and_title(text):
    """("Kings Kaleidoscope", "Always") from "Kings Kaleidoscope - ALWAYS (Official Lyric Video)".
    The artist is "" when the text has no "Artist - Title" dash."""
    t = re.sub(r"\s*[\(\[][^\)\]]*(official|lyric|audio|video|visualizer|live|hd|4k)[^\)\]]*[\)\]]", "", text, flags=re.I)
    parts = re.split(r"\s+[-–—|]\s+", t.strip(), maxsplit=1)
    return (parts[0].strip(), parts[1].strip()) if len(parts) == 2 else ("", t.strip())


def new_track(song, number, name, tuning, program, channel):
    track = gpm.Track(song, number=number, name=name,
                      strings=[gpm.GuitarString(number=i + 1, value=v) for i, v in enumerate(tuning)])
    track.channel = gpm.MidiChannel(channel=channel, effectChannel=channel + 1, instrument=program)
    return track


def build_gp5(guitar_mid, bass_mid, beat_times, out_path, title="", offset_beats=0, guitar_program=25,
              detail=None, url=""):
    """Builds a two-track .gp5 (guitar EADGBE, bass EADG) in 4/4 and writes it to out_path.
    "Artist - Title" is split into the file's artist and title. The video's link goes in the notice,
    so Fretboard plays that same video with the tab (not another song with the same name).
    Returns a short summary dict. A dict passed as `detail` gets, for checking, every written note
    as (seconds, pitch) per track and the time of every beat."""
    guitar_notes, bass_notes = read_midi_notes(guitar_mid), read_midi_notes(bass_mid)
    first = min([n[0] for n in guitar_notes + bass_notes] or [0.0])
    to_step, to_seconds, bpm = make_grid(beat_times, offset_beats, first)
    key_name, fifths, minor = estimate_key(guitar_notes + bass_notes)
    guitar_chords = group_chords(guitar_notes, to_step)
    bass_chords = group_chords(bass_notes, to_step, mono=True)
    last = max([a + n for a, n, _ in guitar_chords + bass_chords] or [STEPS_PER_BAR])
    n_bars = max(1, -(-last // STEPS_PER_BAR))

    song = guitarpro.Song()
    song.artist, song.title = artist_and_title(title)
    if url:
        song.notice = [f"Video: {url}"]
    song.tempo = int(round(bpm))
    song.measureHeaders = []
    for i in range(n_bars):
        h = gpm.MeasureHeader(number=i + 1, start=gpm.Duration.quarterTime * (1 + 4 * i),
                              keySignature=gpm.KeySignature((fifths, 1 if minor else 0)),
                              timeSignature=gpm.TimeSignature(numerator=4, denominator=gpm.Duration(value=4)))
        song.measureHeaders.append(h)
    guitar = new_track(song, 1, "Guitar", GUITAR_TUNING, guitar_program, 0)
    bass = new_track(song, 2, "Bass", BASS_TUNING, 33, 2)
    song.tracks = [guitar, bass]
    g_dropped, g_placed = fill_track(guitar, song.measureHeaders, guitar_chords, GUITAR_TUNING, True)
    b_dropped, b_placed = fill_track(bass, song.measureHeaders, bass_chords, BASS_TUNING, False)
    try:
        guitarpro.write(song, str(out_path), version=(5, 1, 0))
    except Exception as e:
        fail("Guitar Pro", "PyGuitarPro couldn't write the .gp5 file.", e)
    if detail is not None:
        for name, placed in (("guitar", g_placed), ("bass", b_placed)):
            steps = np.array([st for st, _ in placed], dtype=float)
            detail[name] = list(zip(to_seconds(steps).tolist(), [p for _, p in placed]))
        detail["beat_lines"] = to_seconds(np.arange(n_bars * 4 + 1) * 4).tolist()  # every quarter; bar lines are every 4th
        detail["notes_in"] = {"guitar": len(guitar_notes), "bass": len(bass_notes)}
    return {"bars": n_bars, "bpm": round(bpm, 1), "key": key_name,
            "bar_1_at_seconds": round(float(to_seconds(0)), 2),
            "guitar_chords": len(guitar_chords), "bass_notes": len(bass_chords),
            "dropped_notes": {"guitar": g_dropped, "bass": b_dropped}}


def check_gp5(path):
    """Reads the .gp5 back and checks every bar of every track adds up to 4/4.
    Returns {track name: (bars, notes)}."""
    song = guitarpro.parse(str(path))
    out = {}
    for track in song.tracks:
        notes = 0
        for m in track.measures:
            total = sum(gpm.Duration.quarterTime * 4 // b.duration.value * (3 if b.duration.isDotted else 2) // 2
                        for b in m.voices[0].beats)
            if total != gpm.Duration.quarterTime * 4:
                fail("Guitar Pro", f"Bar {m.number} of {track.name} doesn't add up to 4/4 ({total} ticks).")
            notes += sum(len(b.notes) for b in m.voices[0].beats)
        out[track.name] = (len(track.measures), notes)
    return out
''')

code(r'''
# @title 6b. Find the tempo and write song.gp5
# --- run ---
if "GUITAR_MID" not in globals():
    fail("Guitar Pro", "Run step 5 (Transcription) first.")
BEATS, FIRST_DOWNBEAT = find_beats(MIX_WAV)
if BEATS_BEFORE_FIRST_DOWNBEAT >= 0:
    FIRST_DOWNBEAT = BEATS_BEFORE_FIRST_DOWNBEAT
BEATS, FIRST_DOWNBEAT = change_tempo(BEATS, FIRST_DOWNBEAT, TEMPO)
print(f"{len(BEATS)} beats; beat {FIRST_DOWNBEAT} is the first \"1\".")

GP5 = WORK / "song.gp5"
summary = build_gp5(GUITAR_MID, BASS_MID, BEATS, GP5, SONG_TITLE,
                    FIRST_DOWNBEAT, GUITAR_PROGRAM, url=YOUTUBE_URL)
print("Wrote", GP5, summary)
print("Read back:", check_gp5(GP5))
''')

code(r'''
# @title 7. Zip everything, save it to Drive, and download it
def export_zip(work, stems, midis, gp5, drive_out=None):
    """Zips song.gp5, the stems and the two MIDI files. Returns the zip path."""
    zip_path = work.parent / f"{work.name}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(gp5, gp5.name)
        for name, path in stems.items():  # WAVs barely shrink, so they're stored as they are (faster)
            z.write(path, f"stems/{name}.wav", compress_type=zipfile.ZIP_STORED)
        for m in midis:
            z.write(m, Path(m).name)
    print(f"Zip: {zip_path} ({zip_path.stat().st_size / 2**20:.0f} MB)")
    if drive_out:
        try:
            shutil.copy2(zip_path, drive_out / zip_path.name)
            print("Saved to Google Drive:", drive_out / zip_path.name)
        except Exception as e:
            print("Couldn't copy to Google Drive (is it full?). The download below still works.\n"
                  "    Details:", e)
    return zip_path

# --- run ---
if "GP5" not in globals():
    fail("Export", "Run step 6b first.")
ZIP = export_zip(WORK, STEMS, [GUITAR_MID, BASS_MID], GP5, DRIVE_OUT)
try:
    from google.colab import files
    files.download(str(ZIP))
except Exception as e:
    print("The browser download didn't start. Get the zip from the Files panel on the left "
          "(or from Google Drive).\n    Details:", e)
''')

code(r'''
# @title 8. Batch: every song from step 2, one after another
import time

def run_song(url, name=""):
    """Steps 3 to 7 for one song, without the browser download. Returns (zip path, summary)."""
    t0 = time.time()
    mix, title, work = download_audio(url, WORK_ROOT)
    stems = separate_stems(mix, work / "stems", SEPARATION_MODEL)
    bass_mid, _ = transcribe(stems["bass"], work / "bass.mid", "bass")
    guitar_mid, _ = transcribe(guitar_stem(stems), work / "guitar.mid", "guitar", GUITAR_PROGRAM)
    beats, first = change_tempo(*find_beats(mix), TEMPO)
    if BEATS_BEFORE_FIRST_DOWNBEAT >= 0:
        first = BEATS_BEFORE_FIRST_DOWNBEAT
    gp5 = work / "song.gp5"
    summary = build_gp5(guitar_mid, bass_mid, beats, gp5, name or title, first, GUITAR_PROGRAM, url=url)
    check_gp5(gp5)
    z = export_zip(work, stems, [guitar_mid, bass_mid], gp5, DRIVE_OUT)
    summary["minutes"] = round((time.time() - t0) / 60, 1)
    return z, summary

# --- run ---
if not BATCH:
    print("One song: steps 3-7 did it. For several, fill BATCH_LINKS in step 2.")
else:
    done, failed, t_all = [], [], time.time()
    for i, (url, name) in enumerate(BATCH, 1):
        print(f"\n=== {i}/{len(BATCH)}: {name or url}")
        try:
            z, summary = run_song(url, name)
            done.append(z)
            print(f"Done in {summary['minutes']} min: {summary}")
        except Exception as e:  # one bad song doesn't stop the rest
            failed.append((name or url, str(e).splitlines()[0][:300]))
            print("FAILED:", e)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        mins = (time.time() - t_all) / 60
        print(f"GPU time so far: {mins:.0f} min (free Colab gives a few hours a day; it stops with "
              f"'cannot connect to a GPU' when used up)")
    print(f"\n{len(done)} done, {len(failed)} failed, {(time.time() - t_all) / 60:.0f} min.")
    for n, why in failed:
        print(f"  failed: {n}: {why}")
    if done:
        all_zip = WORK_ROOT / "all_songs.zip"
        with zipfile.ZipFile(all_zip, "w") as zz:
            for z in done:
                zz.write(z, Path(z).name)
        try:
            from google.colab import files
            files.download(str(all_zip))
        except Exception as e:
            print("Get all_songs.zip from the Files panel (or Google Drive).", e)
''')

nb = {
    "nbformat": 4, "nbformat_minor": 0,
    "metadata": {
        "accelerator": "GPU",
        "colab": {"provenance": [], "gpuType": "T4", "name": "youtube_to_gp5.ipynb"},
        "kernelspec": {"name": "python3", "display_name": "Python 3"},
        "language_info": {"name": "python"},
    },
    "cells": cells,
}
for c in nb["cells"]:
    lines = c["source"].split("\n")
    c["source"] = [l + "\n" for l in lines[:-1]] + [lines[-1]]
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
print("wrote", OUT, len(cells), "cells")
