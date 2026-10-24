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

## Checking a tab against its recording, track by track (2026-10-24)

The goal: official `.gp` files that pair perfectly with their recordings, so the stems can be cut well and a YouTube link can become a `.gp` to play in Fretboard. The user listens; the computer learns from what they say.

- **Done:** the listen page (`listen.py`), the guesses (`check.py`), the truth files (`truth/<song>.json`). See the README guide.
- **How a check is placed:** on the track alone in the right ear (else the whole tab), at the bar heard ⅓ s before the key. The same key within 2.5 s stretches it to the next bar. K covers the whole section.
- **Next:**
  1. `songdb.py verify-done NAME`: marks a song "verified" when every track that plays is OK in every section and no check is left open.
  2. `check.py tune`: try the `LIMITS` against all the answers (Enter = right, X = wrong) and keep the ones with the best score.
  3. `real.py` reads the truth files: scores only bars marked OK, and skips bars with open problems.
  4. Fix the tabs from the checks (Claude, by hand at first; then suggested fixes, e.g. a note one semitone off where the recording has the other one).
- **Later:** suggest levels per track (from the user's own level changes); sections for tabs without markers (from Chords.txt labels, then from the music repeating); how sure each bar is, shown in Fretboard.

## Two roads to "any YouTube song as a .gp" (2026-10-24)

1. **A good tab exists (UG official, or a good user tab):** don't transcribe. Download the tab, match it to the video (`real.whole_match`), and hand Fretboard the line-up.
   - **Done:** `listen.py NAME --export` writes `out/listen/<song>/<title>.fretboard`: the .gp, the YouTube link, and a sync point for every bar (`syncPoints`, from the time map), marked `syncDone` and `autoSync`. Import it into Fretboard and the tab follows the video at once. Checked on Be My Escape: bars 28, 52 and 73 land within 0.05 s of the matcher's times.
   - **Next:** one command from a YouTube link: find the UG official tab, have the helper save it, `ug_to_gp`, verify, export, and open it in Fretboard. Then the same for good user tabs (rated ones), with the match as the quality check: a tab that doesn't match all the way through is not used.
2. **No good tab:** transcribe (the Colab notebook). This is where Colab and a dataset pay off.
   - Every song checked on road 1 is a training pair: the recording, its stems, and the exact notes with their times (the time map), cleaned by the user's checks in `truth/`.
   - With ~100 such pairs: fine-tune the note model on Colab (GPU), score it with `real.py` on songs it hasn't seen, and keep it only if the guitar notes get better.
   - Public datasets (GuitarSet, GAPS, the Slakh synthetic mixes) help as a start, but the user's own band-style pairs match what they play.

## Save point (2026-10-24, evening): video sync, one steady tempo

**Where we stopped:** both songs were sent to the user to import and listen to. Waiting for the user to say whether they sound right. If they do, commit and push (the user asked "commit and push" before for this work). If not, ask which bar.

**The user's rules for the sync (new):**
- **One steady tempo for the whole song, plus the right start.** Never stretch or fit single bars unless the user asks (`--fit`). Bar fitting made Be My Escape slow at bar 92 and speed up at 93.
- **Check before sending:** `whole_song_off` must be about 0 ms. The user noticed the delay and the off notes, and the old checks didn't.

**How the line-up works now** (`syncqa.py`, run by `listen.py NAME --export`, or on its own: `syncqa.py NAME`):
1. `raw_line`: the audio line-up from `listen.py` (`info["tabAt"]`), one time per bar.
2. `one_tempo`: a straight line through it (median slopes of bars far apart), then a search on tempo (±1 %, then ±0.2 %) and start (±150 ms). It keeps the line where the tab's own sound (all tracks, onset strength) lines up best with the recording over the whole song. The `.fretboard` gets a sync point on that line for every bar.
3. `lag_curve`: the check. How far the whole tab would have to move to line up best, printed as "whole song off N ms" and saved as `whole_song_off_ms` in `sync.json`.

**Traps found today:**
- **Beat This! can lock onto the off-beats.** Fitting the tempo to its beats put Stupid Deep half a beat off (it played 141 ms late: "it sounds terrible, delay"). The note check (±80 ms window) and the beat check can't see a half-beat slip in a strummed song. So the tempo never comes from Beat This!. Its bar list ("bars where the tab differs", "bars over 50 ms off") is wrong whenever its beats sit on the off-beats; Stupid Deep shows 1–50 there, which means nothing.
- **The raw line-up drifts at the end** of Be My Escape: from bar 91 it runs up to 13 s past the end of the 3:40 recording, which caused the bar 92/93 jumps. The steady line fills the recording exactly.

**Results:**

| Song | Tempo | Bar 1 | Whole song off | Notes within 30 ms |
|---|---|---|---|---|
| Be My Escape | 112 BPM (100.44 % of the tab) | 0.169 s | −1 ms | 78 % |
| Stupid Deep (official) | 72 BPM (102.85 % of the tab's 70) | 0.031 s | −1 ms (was 141 ms late) | 64 % |

The user thought Stupid Deep was 69–70 BPM. Its 54 bars only fill the 2:59 official audio at about 72.

**Where the files are:**
- The files sent to the user: `out/listen/<slug>/<title>.fretboard`, with `sync_report.html` and `sync.json` beside them. Slugs: `Relient_K_-_Be_My_Escape_official`, `Jon_Bellion_-_Stupid_Deep_official`.
- Stupid Deep's tab: made by `ug_to_gp.py` → `cache/ug/Jon Bellion - Stupid Deep.gp` (54 bars, 13 tracks), then `songdb.py scan … --official` and `find --official` → video "Jon Bellion - Stupid Deep (Official Audio)", 2:59.

**Not committed yet:**
- `syncqa.py` (CRLF): `one_tempo`, `raw_line`, `lag_curve`, `--fit`, the check.
- `listen.py`: `--fit`, the steady tempo by default.
- `songs.json`: Stupid Deep.
- The app files:
  - `js/playalong.js`:
    - a toast when the speed isn't a YouTube speed (YouTube plays only in 25 % steps, so the video, the tab and the click follow the video, not the typed speed)
    - the docked video bar follows its slot each frame (it overlapped the speed box when the chord name got wider)
  - `js/player.js` and `styles.css`: the mixer's sound box opens from the instrument icon (a box on every row was "way too obnoxious"); it shows by itself only on tracks whose sound isn't sure.
- `TODO.md` and `marks/` stay uncommitted (as always). The Android APK hasn't been built for any of this.

**The simple sync (2026-10-24, later):** start with simple songs: a studio recording played to a click, one tempo, no free intro. A sync is two numbers, the tempo and the start (`one_tempo`); Beat This! now runs only for `--fit`. `steadiness` checks the song in 4-bar stretches and prints one verdict:
- **OK**: one steady tempo fits (no stretch drifts, the whole song within 15 ms).
- **NOT SIMPLE**: stretches drift off the tempo. Leave the song for later.
- **listen to bars …**: a stretch lines up half a beat off while the stretches round it are right. The tab's rhythm differs there, not the sync.
- Be My Escape: OK. Listen to 1–8 (the intro: clearly half a beat out, 0.77 vs 0.17), 21–24, 37–48, 93–96. Stupid Deep: NOT SIMPLE (weak line-up everywhere, 0.1–0.3; nothing lines up at 0 in bars 37–48).

**Next, after the user confirms:**
1. Commit and push.
2. Build the APK if the user wants it on the phone.
3. Redo Trust In God (`syncqa.py "Trust In God"`) the same way and check its whole_song_off.
4. Later: drop or fix the Beat This! bar list (it should use the tab's sound per bar, like `lag_curve` but per section).

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
