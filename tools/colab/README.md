# YouTube → Guitar Pro (Colab)

`youtube_to_gp5.ipynb` turns a YouTube link into a zip with `song.gp5` (guitar + bass tab),
the four Demucs stems and `guitar.mid` / `bass.mid`. Fretboard imports the `.gp5` directly.

## Open it in Colab

- **Upload:** go to https://colab.research.google.com → File → Upload notebook → pick this file.
- **From GitHub** (once it's pushed):
  https://colab.research.google.com/github/Nathancald3r/fretboard/blob/main/tools/colab/youtube_to_gp5.ipynb

Then: Runtime → Change runtime type → **T4 GPU**, paste the link in step 2, and Runtime → Run all.
Colab asks once for Google Drive access (step 1); untick `SAVE_TO_DRIVE` to skip it.

## Notes

- basic-pitch is installed with `--no-deps` and runs its ONNX model: its pip metadata asks for
  `tensorflow<2.15.1`, which doesn't exist for Colab's Python 3.12.
- Stems default to "uvr": Kim Vocal 2 (vocals) and MDX23C (instruments), the models UVR5 users pick, run by
  `audio-separator` without UVR's GUI; then Demucs splits the instruments. Kim runs through torch on the GPU
  (onnxruntime's GPU build wants a newer CUDA). The models (~1 GB) are kept in Drive, `Fretboard/models`.
  A whole song takes about 4–5 min on a T4 (estimated from this PC; step 4 tested here, 5.6 min on a T1000).
- audio-separator is installed `--no-deps` and every pip run is pinned to Colab's own torch (`-c keep.txt`):
  unpinned, pip swaps in a CPU-only torch.
- If bar lines land on the wrong beat, set `BEATS_BEFORE_FIRST_DOWNBEAT` to 1, 2 or 3 and rerun step 6b.
- Tested locally (Windows, CPU, Python 3.12): steps 2 and 4–7 on made-up audio, the fingering and
  `.gp5` builder on made-up MIDI (read back with `guitarpro.parse` and alphaTab). Not tested here:
  the YouTube download (step 3), the GPU path and the Colab-only parts (Drive, `files.download`).
