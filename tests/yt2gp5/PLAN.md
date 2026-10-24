# YouTube → GP5: plan and where everything is

Start here in a new session. Last updated 2026-10-24.

## What it is

A Colab notebook turns a YouTube song into a two-track `.gp5` (guitar and bass) that Fretboard opens. The pipeline is: download → Demucs stems → basic-pitch notes → Beat This! beats → `.gp5`. A test loop on this PC scores the notebook against songs whose notes are known.

Nothing here learns or trains. Every model is used as is. The `.gp` + YouTube pairs are an **answer key**: they show whether a change to the notebook made it better or worse.

## Files (all in the project; none committed yet)

| File | What it does |
|---|---|
| `tools/colab/youtube_to_gp5.ipynb` | The notebook. **Generated:** don't edit it by hand. |
| `tools/colab/build_notebook.py` | The notebook's source. Edit this, then run `python tools/colab/build_notebook.py tools/colab/youtube_to_gp5.ipynb` |
| `tools/colab/README.md` | How the user runs the notebook in Colab |
| `tests/yt2gp5/run.py` | Synth test: Fretboard's synth plays each `.gp` → the notebook runs → scores (stems, notes, tempo, bars, key, loads). Writes `out/scorecard.md` |
| `tests/yt2gp5/real.py` | Real-recording test: the YouTube audio of each song, lined up with its `.gp` by chords (DTW) → scores. Writes `out/real/scorecard.md` |
| `tests/yt2gp5/songdb.py` | The song list `songs.json`: `.gp` files and their YouTube videos (`scan`, `find`, `set`, `ok`, `list`, `export` → `colab_batch.txt`) |
| `tests/yt2gp5/test_notebook.py` | Offline smoke test of the notebook's cells on made-up audio: `python tests/yt2gp5/test_notebook.py tools/colab/youtube_to_gp5.ipynb <scratch folder> --full` |
| `tests/yt2gp5/render.html`, `render.js` | The page that plays a `.gp` through alphaTab (Fretboard's synth) for the tests |
| `tests/yt2gp5/config.json` | Songs for the synth test, models, and pass marks (`pass`, `pass_real`) |
| `tests/yt2gp5/README.md` | How to run all of it (PowerShell commands) |
| `tests/yt2gp5/out/history.jsonl`, `out/real/history.jsonl` | Every run's scores, to see what got better or worse |

The Python for all of this is `C:\Users\natha\.fretboard\yt2gp5-venv\Scripts\python.exe`. It has torch+CUDA, demucs, basic-pitch, beat-this, PyGuitarPro, mir_eval, playwright, yt-dlp and imageio-ffmpeg. The system Python lacks these.

## Where it stands (2026-10-24)

**Synth test** (5 songs × 2 models, 2 min in all):

- Tempo is right on 3 of 5 songs since Beat This! (Stairway's bars went from 0% to 100%).
- When I Go Down and How He Loves (12/8) come out at double tempo. The `TEMPO` setting (half/double) in step 2 fixes them by hand.
- Guitar notes F1 40–64%, bass 47–76%.
- htdemucs is better than htdemucs_6s for guitar. 6s loses overdriven guitar to the drums stem (Worship 0.7 dB, When I Go Down 0.1 dB). Keep htdemucs as the default.

**Real recordings** (3 songs, 5 min; first run):

- Lined up well (chord distance 0.05–0.08).
- Guitar F1 31–37%, bass 19–39%, tab 40–47%, bars 21–42%.
- Key right on all 3.
- Tempo right on 2 of 3; When I Go Down is wrong.
- The line-up is only good to ~0.1–0.15 s, so compare runs with each other. A finer onset line-up was tried and didn't help.

**Real recordings, all 5 (2026-10-24, second run):**

- Key right on 5 of 5.
- Tempo right on 3. When I Go Down and How He Loves come out double.
- Guitar F1 15–37%, bass 5–39%.
- How He Loves (12/8) is the worst at every check.

**Songs:** all 5 matched and checked by `songdb.py verify`, which downloads the top candidates and lines each up with the tab. The user's preference: the artist's **official audio** first (the "Artist - Topic" upload, "Provided to YouTube by…"), then the artist's own audio upload, and music videos last (they can have intros or skits). The search scores candidates in that order. Here I Am To Worship has no official upload in the search results, so a fan upload of the studio track is used (line-up 0.11).

**More songs available:** `Downloads\UG Songs` has 8 more official UG songs as PDFs only, such as Be My Escape and Candlelight. Next idea: import each through Fretboard's PDF importer in headless Chromium and save it as .gp (alphaTab's Gp7Exporter), so `songdb.py scan` can use them.

## Save point (2026-10-24): adding the UG PDF songs

The user asked: "import the PDF-only UG songs through Fretboard, save each as .gp, add them to songs.json, find their official audio, and score them."

- **Usable folders** in `C:\Users\natha\Downloads\UG Songs` (PDF parts, no .gp yet): **Be My Escape** (Relient K), **Champion** (Bethel Music, Key Bb), **How Great Is Our God** (Chris Tomlin, Key C#), **Trust In God** (Elevation Worship, Key C).
- **Not usable:** Candlelight (only .txt tabs), Champion (Maverick City), Rest On Us and Sun Come Down (chords only, no notes). "When I Go Down Power" duplicates a song that already has a .gp. Here I Am To Worship, How He Loves and When I Go Down already have .gp files.
- **Converter plan** (step in progress): add a page function `ugFolderToGp(files, {title, artist, key})` to `render.js`. It mirrors `readParts` / `importPdfParts` in `js/app.js`:
  - For each PDF (skip `Chords.txt`), take the part name from the file name (`"Song - Artist - Part.pdf"`). The program comes from the `PARTS` table in app.js.
  - Run `pdfToTab(buf, ()=>{}, {lyrics:false, dynamics:false, bass:/bass/i, drums: drumKind(name)})` one PDF at a time.
  - Sort: guitar parts with tab first, then the rest, then drums. Then `ugToAlphaTex(parts[0].strips, {title, artist, name, program, extra: parts.slice(1), key})`.
  - Load the tex with `new alphaTab.importer.AlphaTexImporter()` (as in `js/player.js:1199`), then `new alphaTab.exporter.Gp7Exporter().export(score, settings)` (as in `js/editor.js:95`). Save it through the test server's POST `/__save/` to `tests/yt2gp5/cache/ug/<slug>.gp`.
  - Drive it from a small Python script (Playwright, `run.serve()`, as in `real.py`).
- **Then:** `songdb.py scan tests/yt2gp5/cache/ug` → `find` → `verify` (the artist's official Topic audio first) → `real.py -k <song>` for each → update this file and the README.
- Nothing is committed (the user hasn't asked).

## Matching the official songs to YouTube (2026-10-24)

The user asked for each `.gp` made from a UG **official** tab to be matched to the right YouTube recording, with Official Audio preferred over Official Video. The match must hold **all the way through**. They also wanted to hear their instruments on top of the video, to check it.

- **Done:**
  - the `--official` flag and the tiers in `songdb.py` (see the README)
  - `real.whole_match`: chords every 10 s, lasting timing steps, the ends, the key
  - `songdb.py report`: the picture page
  - `listen.py`: the listen page
- **Results:**
  - **Be My Escape:** Relient K "Official Audio Stream". Matches.
  - **Champion:** Bethel Music & Dante Bowe (an artist upload). Matches. The first ~30 s wander (a free intro) and then come back.
  - **Trust In God:** Elevation Worship "Trust In God", 7:23. Matches.
  - **Here I Am To Worship:** no Chris Tomlin upload was found. Fan uploads follow the tab exactly but have 9 s before the tab starts. Left as suggested: check it with listen.py, or `set` the right link.
  - **How Great Is Our God:** no match. Chris Tomlin's "(Audio)" fails in its first 20 s (different chords, and 6 s longer). It may have another intro; check it with listen.py.
- **Limits:**
  - whole_match's chord line-up is good to about 0.3 s, so a missing part shorter than about 4 s won't show.
  - The `real.MATCH` limits are tuned on the 10 cached songs: the right recordings pass and other versions fail.
- How He Loves has official PDFs too, but `ug_to_gp.py` skipped it because its folder also has a .gpx.

## Next steps

1. More songs. Each song needs a `.gp` plus the YouTube video of the same recording. More songs make the scores more trustworthy; aim for 15–20 of different styles (acoustic, distorted, 6/8, fast).
2. Improve guitar notes, the weakest part:
   - basic-pitch thresholds (`onset_threshold`, `frame_threshold`, minimum note length) tuned on the song set, synth and real both
   - try `htdemucs_ft`
3. Guess half/double tempo automatically, e.g. from the note density per beat or the bass pattern, checked on the song set.
4. 6/8 and 12/8: the `.gp5` is always 4/4 now.
5. Optional, big: **actually train** on the pairs. Fine-tune basic-pitch (or a guitar model like the GAPS/GuitarSet ones) on stems with their aligned tab notes. That needs ~100+ songs and a GPU for hours (Colab Pro or similar), and a better line-up than 0.1 s. Only worth it after steps 1–3.

## Rules from the user

- Don't commit or push unless the user asks.
- No bot-evasion or cookie tricks in yt-dlp. The user downloads only audio they may use.
- On a crash: alert the user (PushNotification), fix it and run again by itself. Watch only for errors (Monitor with a grep for errors); don't poll.
- Tell the user when compute is near a limit or costs go up. Local runs cost nothing; Colab has a free GPU quota of a few hours a day.
