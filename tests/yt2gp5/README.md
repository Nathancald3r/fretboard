# YouTube → GP5 quality test

Checks the Colab notebook (`tools/colab/youtube_to_gp5.ipynb`) on this PC's GPU, against songs whose notes are known.

For each Guitar Pro file in `config.json`:

1. Fretboard's own synth (alphaTab plus the MuseScore soundfont, in headless Chromium) plays every track alone for the song's busiest 45 s. The tracks summed make the "mix", and the tracks summed per instrument are the true stems. This is cached in `cache/`.
2. The notebook's own code runs on the mix with each Demucs model: separation, basic-pitch, then the `.gp5`. `run.py` reads the code straight from the `.ipynb`, so it tests what Colab runs.
3. Everything is scored against the truth, and `out/scorecard.md` is written.

| Check | What it means | Pass mark |
|---|---|---|
| Stems SDR | How clean the bass and guitar stems are while their instrument plays (dB, median of 1-s windows) | ≥ 5 dB |
| Guitar / Bass F1 | Notes from basic-pitch with the right pitch, starting within 50 ms | ≥ 50% / 60% |
| Tab guitar / bass | The same, as written in the `.gp5` (16th grid and fingering), within 100 ms | ≥ 40% / 50% |
| Tempo off | `.gp5` tempo vs the true tempo; "half" or "double" is named | ≤ 2% |
| Bar lines | True bar lines that the `.gp5` has within 80 ms. "Setting N fits" means use `BEATS_BEFORE_FIRST_DOWNBEAT = N` | ≥ 80% |
| Key | The key found from the notes vs the key of the true notes | same |
| Wrong-instrument | Guitar-track notes that were really keys or vocals | ≤ 25% |
| Dropped | Notes left out as unplayable | ≤ 15% |
| Loads | Fretboard opens the `.gp5`: 2 tracks, right tunings, every bar full | yes |

A score that falls since the last run of the same song and model is flagged ("fell"), using `history.jsonl`.

## One-time setup (already done on this PC)

The test uses its own Python in `C:\Users\natha\.fretboard\yt2gp5-venv`: torch with CUDA, demucs, basic-pitch (ONNX), Beat This!, PyGuitarPro, mir_eval, Playwright, yt-dlp and imageio-ffmpeg.

## Run it

```powershell
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\run.py
```

- `-k Worship` runs only songs whose file name has "Worship".
- `--models htdemucs_6s` picks the models.
- `--seconds 60` sets a longer stretch per song.
- `--max-minutes 30` starts no new song after 30 minutes.
- `--rerender` makes the test audio again (use it after a synth or soundfont change).

Then open `tests\yt2gp5\out\scorecard.md`. Each run's stems, MIDI and `.gp5` are in `tests\yt2gp5\out\<song>\<model>\`, so you can listen to them or open them in Fretboard.

## Let it run by itself

Windows Task Scheduler runs it every night at 2:00, with a 60-minute cap:

```powershell
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; schtasks /Create /TN "Fretboard YT2GP5 test" /SC DAILY /ST 02:00 /TR "cmd /c cd /d \"%CD%\" && \"%USERPROFILE%\.fretboard\yt2gp5-venv\Scripts\python.exe\" tests\yt2gp5\run.py --max-minutes 60 > tests\yt2gp5\out\nightly.log 2>&1"
```

To remove it: `schtasks /Delete /TN "Fretboard YT2GP5 test" /F`.

## Cost and limits

- **Local runs cost nothing.** Each run prints its time per song and the GPU's peak memory. The Quadro T1000 has 4 GB; a 45-s stretch peaks near 0.5 GB.
- If a run says "ran out of memory", use fewer `--seconds`. The notebook also retries in smaller pieces, and then on the CPU.
- **Colab** (the real notebook) has a free GPU quota that Google doesn't publish, roughly a few hours a day. One song takes about 1–3 minutes of GPU. Colab says "You cannot currently connect to a GPU" when the quota is used up; it comes back after about a day. Paid Colab only spends compute units while a GPU runtime is connected, so disconnect the runtime (Runtime → Disconnect and delete runtime) when done.

## Add a song

Add any `.gp`, `.gpx`, `.gp5` or `.gp4` to `songs` in `config.json`. The test audio is the soundfont's sound, which is cleaner than a real band, so real songs score lower. A change that makes this test worse will almost always make real songs worse too. To score real recordings, see below.

## The song list: Guitar Pro files and their YouTube videos (`songdb.py`)

`songdb.py` keeps `songs.json`: each Guitar Pro file, and the YouTube video of the same recording. It is used for two things: scoring real recordings (`real.py`), and the notebook's batch mode.

```powershell
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; $py = "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe"; & $py tests\yt2gp5\songdb.py scan; & $py tests\yt2gp5\songdb.py find; & $py tests\yt2gp5\songdb.py list
```

- `scan [folders]` finds Guitar Pro files (default: Downloads) and reads their title, artist and length.
- `find` searches YouTube for each song and suggests the best match. The score favours the artist's own upload or "- Topic" channel, the right length, and no "live", "cover", "lesson" or "karaoke". A match of 80 or more is used (✓ in `list`).
- `set "NAME" URL` gives the right video yourself. **This helps the most:** a studio recording of the same version as the tab (same length, same key). `ok "NAME"` accepts a suggestion; `skip "NAME"` leaves a song out.
- `scan tests\yt2gp5\cache\ug --official`, `find --official`, `verify --official`: the songs converted from UG **official** tabs (`ug_to_gp.py`). Their names end in " (official)", and they keep their UG link.
- `verify [NAME]` downloads the candidates in the user's order and confirms the first that **matches all the way through** (`real.whole_match`).
  - The order: the artist's own "- Topic" audio, then their "Official Audio", then their other uploads, then their music or lyric videos, then other people's uploads.
  - Never tried: another song; a live, acoustic, radio or other version; someone else's Topic channel.
  - "All the way through" means the same key, the same chords in every 10 s, no lasting jump in timing (a missing or extra part), and no more than 6 s left over at either end.
  - A free-time intro that wanders and comes back still passes.
- `report` makes `out\match\report.html` (verify also writes it after every run).
  - Each video gets one line, showing how far the recording runs ahead of or behind the tab.
  - Flat means it matches. A step means a part is missing or extra (shown in red).
- `add URL` adds a song with no tab (batch mode only, it can't be scored).
- `check` finds videos that are gone or whose length no longer fits.
- `export` writes `colab_batch.txt`, for the notebook's batch mode.

## Score real recordings (`real.py`)

```powershell
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\real.py
```

For each ✓ song in `songdb.py list`:

1. It downloads the video's audio (cached in `cache\real\`).
2. Fretboard's synth plays the whole tab.
3. The two are lined up by their chords, in all 12 keys.
4. The notebook runs on the real recording and is scored against the tab, with a 100 ms window (the line-up is good to about a tenth of a second).

There are no stem scores. "Line-up" shows how well the video matches the tab: above 0.25, it is probably another version, so fix its link with `songdb.py set`. Results are in `out\real\scorecard.md`. `-k NAME` and `--model` work as in `run.py`.

## Many songs in Colab (batch mode)

1. Run `songdb.py export`.
2. Either paste the links from `tests\yt2gp5\colab_batch.txt` into **BATCH_LINKS** in step 2, or copy the file into the Drive folder from step 1 as `batch.txt`.
3. Run all cells. Step 8 makes one zip per song, plus `all_songs.zip`.

One song that crashes doesn't stop the others. Step 8 prints the GPU minutes used so far.

## Tempo: double or half

Beat This! (the beat finder) gets the tempo right on most songs. Some can be counted either way: When I Go Down (74 bpm in the tab, heard as 150) and 12/8 songs like How He Loves. If the `.gp5` has twice the tab's tempo, set **TEMPO** in step 2 to `half` and run again (or `double` for the other way). The `.gp5` is always written in 4/4.

## Listen to your tab on top of the recording (`listen.py`)

```powershell
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\listen.py "Be My Escape (official)"
```

- It plays every track of the tab with Fretboard's synth, then stretches it to the recording's timing with the pitch kept. It lines up by the chords first, then by the note starts (to about 10 ms).
- It then opens a local page with:
  - an on/off switch and a volume for each track
  - the recording's volume
  - "recording left, tab right"
  - a timing nudge
  - the 10-s stretches (red ones don't match; click one to go there)
- Add `--url URL` to try another video.
- The files stay in `out\listen\` and are never shared. Press Ctrl+C to stop it.
