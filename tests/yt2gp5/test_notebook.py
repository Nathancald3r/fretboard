"""Runs the notebook's cells that work offline: 2 (input check), 4 (Demucs on CPU),
5 (basic-pitch ONNX), 6a/6b (Guitar Pro) and 7 (zip), on made-up audio and MIDI."""
import json, os, sys, shutil, gc, re, zipfile, subprocess
from pathlib import Path
import numpy as np

NB = Path(sys.argv[1])
OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
FULL = "--full" in sys.argv
# --model NAME: the SEPARATION_MODEL for --full (default htdemucs). UVR models are linked in from
# ~/.fretboard/uvr-models so nothing downloads twice.
SEP = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else "htdemucs"
cells = {}
for c in json.loads(NB.read_text(encoding="utf-8"))["cells"]:
    src = "".join(c["source"])
    m = re.match(r"# @title (\w+)\.", src)
    if m:
        cells[m.group(1)] = src

class StepError(RuntimeError): pass
def fail(step, what, detail=None):
    raise StepError(f"[{step}] {what}" + (f"\n    Details: {detail}" if detail else ""))

torch = __import__("torch") if FULL else None
G = {"np": np, "Path": Path, "fail": fail, "StepError": StepError, "shutil": shutil, "gc": gc,
     "re": re, "zipfile": zipfile, "subprocess": subprocess, "torch": torch, "__name__": "nb", "DRIVE_OUT": None}

# --- step 2: input check -------------------------------------------------------------
for url, ok in [("https://www.youtube.com/watch?v=abc", True), ("https://youtu.be/abc", True),
                ("http://example.com/x", False), ("", False)]:
    src = cells["2"].replace('YOUTUBE_URL = ""', f'YOUTUBE_URL = "{url}"', 1)
    try:
        exec(src, dict(G)); got = True
    except StepError:
        got = False
    assert got == ok, url
print("step 2 input check OK")

# --- step 6a: unit checks -------------------------------------------------------------
exec(cells["6a"], G)
fc = G["finger_chord"]
shape, hand = fc([(48, 90), (52, 90), (55, 90), (60, 90), (64, 90)], G["GUITAR_TUNING"], None)
print("C major:", shape, "hand", hand)
assert sorted((s, f) for s, f, _ in shape) == [(1, 0), (2, 1), (3, 0), (4, 2), (5, 3)]
shape, _ = fc([(40, 90), (41, 90), (42, 90)], G["GUITAR_TUNING"], None)
print("E2 F2 F#2 cluster:", shape)
assert len(shape) == 1 and len({s for s, _, _ in shape}) == len(shape)
shape, hand = fc([(67, 90)], G["GUITAR_TUNING"], 10)  # G4 near fret 10 -> not the open G string area
print("G4 with hand at 10:", shape, hand)
assert shape[0][1] >= 8
for _ in range(300):  # random chords: distinct strings, span rule, correct pitches
    ps = sorted(set(np.random.randint(40, 89, size=np.random.randint(1, 6)).tolist()))
    sh, _ = fc([(p, 80) for p in ps], G["GUITAR_TUNING"], int(np.random.randint(0, 12)))
    strings = [s for s, _, _ in sh]
    assert len(strings) == len(set(strings))
    fr = [f for _, f, _ in sh if f > 0]
    assert not fr or max(fr) - min(fr) <= G["MAX_SPAN"]
    got = sorted(G["GUITAR_TUNING"][s - 1] + f for s, f, _ in sh)
    assert set(got) <= set(ps), (ps, sh)
assert list(G["split_length"](14, 6)) == [(8, False, 2), (4, False, 4)]
assert list(G["split_length"](0, 16)) == [(1, False, 16)]
assert list(G["split_length"](0, 6)) == [(4, True, 6)]
print("step 6a unit checks OK")

# --- step 6a: build a .gp5 from made-up MIDI ------------------------------------------
import pretty_midi
def write_mid(path, notes, program):
    pm = pretty_midi.PrettyMIDI(); inst = pretty_midi.Instrument(program=program)
    inst.notes = [pretty_midi.Note(velocity=v, pitch=p, start=s, end=e) for s, e, p, v in notes]
    pm.instruments.append(inst); pm.write(str(path))

# 100 bpm with a slow drift, first beat at 0.3 s (so bar 1 has a short pickup of rest)
beats = 0.3 + np.cumsum(np.r_[0, np.full(40, 0.6) + np.linspace(0, 0.02, 40)])
def at(beat):  # time of a beat position (fractional ok)
    return float(np.interp(beat, np.arange(len(beats)), beats))
gnotes = []
for bar, chord in enumerate([[48, 52, 55, 60, 64], [43, 47, 50, 55, 59, 67], [45, 52, 57, 60, 64], [41, 48, 53, 57, 60, 65]]):
    for p in chord:  # whole-bar chords, slightly off-grid
        gnotes.append((at(bar * 4) + 0.012, at(bar * 4 + 4) - 0.05, p, 80 + (p % 7)))
for i, p in enumerate([64, 67, 69, 71, 72, 71, 69, 67]):  # an 8th-note melody in bar 5
    gnotes.append((at(16 + i / 2) - 0.01, at(16 + i / 2 + 0.5), p, 100))
gnotes.append((at(19.5), at(21.25), 76, 110))  # a note held across the bar line (tie)
gnotes.append((at(22), at(23), 30, 90))        # below the guitar range: can't be fingered
bnotes = [(at(b), at(b + 0.9), p, 95) for b, p in enumerate([36, 36, 43, 43, 31, 31, 38, 38, 33, 33, 40, 40, 29, 29, 36, 36])]
bnotes += [(at(1), at(1.9), 48, 40)]           # a harmonic over a bass note: mono keeps the lowest
write_mid(OUT / "guitar.mid", gnotes, 25); write_mid(OUT / "bass.mid", bnotes, 33)
summary = G["build_gp5"](OUT / "guitar.mid", OUT / "bass.mid", beats, OUT / "test.gp5", "Made-up test")
print("build:", summary)
print("check:", G["check_gp5"](OUT / "test.gp5"))

import guitarpro
song = guitarpro.parse(str(OUT / "test.gp5"))
assert [t.name for t in song.tracks] == ["Guitar", "Bass"]
assert [s.value for s in song.tracks[0].strings] == [64, 59, 55, 50, 45, 40]
assert [s.value for s in song.tracks[1].strings] == [43, 38, 33, 28]
assert song.tempo == 98, song.tempo  # median beat of the drifting test grid
def bar_text(track, i):
    out = []
    for b in track.measures[i].voices[0].beats:
        ns = " ".join(f"{n.string}:{n.value}{'~' if n.type == guitarpro.NoteType.tie else ''}" for n in b.notes) or "rest"
        out.append(f"1/{b.duration.value}{'.' if b.duration.isDotted else ''}[{ns}]")
    return "  ".join(out)
for i in range(len(song.tracks[0].measures)):
    print(f"bar {i + 1} guitar: {bar_text(song.tracks[0], i)}")
for i in range(2):
    print(f"bar {i + 1} bass:   {bar_text(song.tracks[1], i)}")
ties = sum(n.type == guitarpro.NoteType.tie for m in song.tracks[0].measures for b in m.voices[0].beats for n in b.notes)
assert ties >= 1
print("step 6a .gp5 round trip OK")

if not FULL:
    sys.exit(0)

# --- steps 4, 5, 6b, 7 on made-up audio (CPU) ------------------------------------------
import soundfile as sf
sr = 44100
t = np.arange(int(sr * 12)) / sr
mix = np.zeros_like(t)
bpm = 100; beat = 60 / bpm
for k in range(int(12 / beat)):  # bass on every beat, guitar chord every bar, a kick on each beat
    s = int(k * beat * sr); n = int(beat * 0.9 * sr); env = np.exp(-np.arange(n) / sr * 3)
    f = pretty_midi.note_number_to_hz([36, 43, 31, 38][(k // 4) % 4])
    seg = slice(s, min(s + n, len(t)))
    L = seg.stop - seg.start
    mix[seg] += 0.35 * np.sin(2 * np.pi * f * t[:L]) * env[:L]
    kick = np.sin(2 * np.pi * 55 * t[:L] * np.exp(-t[:L] * 20)) * np.exp(-t[:L] * 30)
    mix[seg] += 0.5 * kick
    if k % 4 == 0:
        for p in [[60, 64, 67], [59, 62, 67], [55, 59, 62], [57, 62, 66]][(k // 4) % 4]:
            fh = pretty_midi.note_number_to_hz(p)
            n4 = min(int(beat * 3.8 * sr), len(t) - s)
            e4 = np.exp(-np.arange(n4) / sr * 1.5)
            mix[s:s + n4] += 0.12 * sum(np.sin(2 * np.pi * fh * h * t[:n4]) / h for h in (1, 2, 3)) * e4
mix = np.stack([mix, mix], 1) / np.abs(mix).max() * 0.8
work = OUT / "Made up song"; shutil.rmtree(work, ignore_errors=True); work.mkdir()
sf.write(str(work / "song.wav"), mix, sr, subtype="PCM_16")
if SEP in ("uvr", "bssw"):
    uvr = OUT / "models" / "uvr"; uvr.mkdir(parents=True, exist_ok=True)
    for f in (Path.home() / ".fretboard" / "uvr-models").iterdir():
        if f.is_file() and not (uvr / f.name).exists():
            os.link(f, uvr / f.name)
    G["MODELS"] = OUT / "models"
    import stems; stems.ffmpeg_on_path()  # Colab has ffmpeg; here it may only be imageio's copy
G.update(MIX_WAV=work / "song.wav", WORK=work, SEPARATION_MODEL=SEP, GUITAR_PROGRAM=25, TEMPO="auto", YOUTUBE_URL="", SONG_NAME="",
         SONG_TITLE="Made up song", BEATS_BEFORE_FIRST_DOWNBEAT=0, BATCH=[], DRIVE_OUT=OUT / "drive")
(OUT / "drive").mkdir(exist_ok=True)
for name in ["4", "5", "6b", "7"]:
    print(f"--- step {name}")
    exec(cells[name], G)
with zipfile.ZipFile(G["ZIP"]) as z:
    print("zip:", sorted(z.namelist()))
assert (OUT / "drive" / G["ZIP"].name).exists()
print("steps 4-7 OK")
