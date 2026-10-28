# Fretboard

A guitar practice app: a web app (PWA, built on alphaTab 1.8.4) and an Android APK that wraps the same files.
The goal for imported songs: every track plays in sync, with the right notes at the right time.
Open bugs and to-dos live in `TODO.md`, not here.

## Rules from the user (always)

- **Guitar sound quality comes first.** It outranks everything else.
- **Commands for the user** start with a `cd` into the project. The user runs PowerShell 5.1:
  - chain commands with `;`
  - the path contains `[4]`, so use `cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"`. A plain `cd` fails on the brackets.
- **APK under 30 MB.** The soundfont downloads once and is never bundled.
- Plain, short answers. When something is wrong, say why in one or two plain sentences.

## Run, test, ship

- **Repeated jobs are scripts: run them, don't redo them by hand** (the user asked, 2026-10-24). When a job comes up a second time, make it a script.
  - `node scripts/test.mjs` runs every test (`--round` adds the round-trip test).
  - `node scripts/ship.mjs -m "message" file1 file2 …` checks and fixes flipped line endings, refuses out/, APKs and `_xxx/` folders, commits only the named files with the Co-Authored-By line, and pushes to main. `--check` only checks.
  - `node scripts/apk.mjs` bumps the version, builds, checks the 30 MB limit, keeps `Fretboard-<version>.apk`, installs on the phone and checks the version. `--no-bump` rebuilds or reinstalls the same version; `--no-install` skips the phone. Then send `APK_PATH` with SendUserFile.
  - `python tools/datasets.py get|find|status`: TabMaker training data. `get [--budget GB]` downloads the approved commercial-use datasets (AAM, Guitar-TECHS, E-GMD, Groove) to `%USERPROFILE%retboard-data`, resumable, checked, with CREDITS.md. `find` lists new candidates in CANDIDATES.md there; a person approves them.
  - Download speed (`tools/netcap.py`, shared with datafactory): a steady 80% of the line at home (measured once per network, kept 7 days in `fretboard-data/net.json`; ~80 MB/s here). On a Windows "Public" network (cafe/hotel Wi-Fi): 1 MB/s, 2 connections. Re-checked every minute. Overrides: `--net home|public`, `--cap MBps`.
  - One stream of 64 MB pieces runs across all files (resumable), and unzipping runs alongside, so the line never idles between files. Connections grow while each step still helps: Zenodo starts at 32, tops out ~45 MB/s at 48; Google storage reaches the cap with 8-16.
  - `python tools/datafactory.py run [--aam 20] [--from 1]|check|index`: TabMaker training examples in `fretboard-data\factory`. Each AAM mix → Spleeter 5 stems (mono 22 kHz FLAC) + `labels.json` (notes per stem, beats, chords); Guitar-TECHS clips with string and fret. Fetches only the needed mixes from Zenodo by byte range. Makes its own Python 3.10 env (Spleeter needs ≤ 3.11). Capped at 7 of 12 cores; ~100 s per song on CPU. `check` shifts the labels over each stem's onsets: lined up = best shift 0 ms. Writes `train_index.json` (hours per instrument). Stems training must skip get `"use": false` (`judge`): no labelled notes = bleed (always "vocals"); labelled but silent while its notes play (< 6% of the mix) = Spleeter put that instrument in "other" (AAM piano, 10 of the first 20 songs), so its labels move to "other". `index` judges older examples.
  - `python tools/factoryview.py`: viewer at http://127.0.0.1:8432. Shows the run's progress (from `factory/progress.json`: done of total, time left, failures) and each example: play any stem with tones at the label onsets, waveform, piano roll with beats and chords, stem loudness, and the `check` result. Read-only; can run during a run.
  - `python tools/autopilot.py [--loop]` works through `autopilot/tasks.md` headless while the user is away: checks, retries, a review, questions to `autopilot/questions.md`.
  - **YouTube link → synced song, one command:** `python tests/yt2gp5/fromlink.py "<youtube link>"` (`--ug URL`, `--title/--artist`, `--again`). Finds the UG Official tab (collector Chrome, started out of sight), saves its PDFs, makes the .gp, adds the song with that exact video, lines it up (one steady tempo), and prints the .fretboard file and the QA verdict. Exit 0 PASS, 2 LISTEN, 3 FAIL, 1 error. Re-execs itself in the yt2gp5 venv. Never run two at once (they share the collector Chrome).
  - yt2gp5: `listen.py --export`, `qa.py`, `compare.py`, `anchors.py` (see `tests/yt2gp5/PLAN.md`).
  - **Wave aligner (2026-10-27):** `python tools/aligner.py "Ho Hey"` (needs numpy; opens http://127.0.0.1:8433). The tab's rendered sound and the video's sound as two waveforms on the tab's time, bar lines, note ticks.
    - Mouse: drag moves the video (the section under the mouse); Shift+drag, wheel or `,` `.` scroll the view; click puts the marker. Keys: ← → nudge the video 10 ms (Shift 100, Ctrl 1); 1–5 (row or numpad) zoom (song, 45 s, 12 s, 3 s, 0.6 s); `A` cut at the nearest bar line (a section gets its own shift), `Delete` join; `M` matches the note starts around the marker (±1 s, shows its confidence); `N` / Shift+`N` jump the marker to the tab's next / previous note start (blue lines at the 3 s zoom); `L` turns the auto level on or off (a quiet lane is drawn louder, the label says ×N); Space plays both (video left ear, tab right); `T`/`V` mute; Ctrl+Z; Ctrl+S saves.
    - **Scrub, squeeze, loudness (2026-10-27, asked by the user):**
      - **Song strip** at the top: the whole song with sections, the part on view and the playhead line. Click or drag in it to scrub (you hear a short burst; while playing it carries on from there). The marker's tab in the main view drags the same way. `P` / "To playhead" centres the view on the playhead, `F` / "Follow" keeps the playhead in view while playing (the view stays still until the playhead would leave it, then jumps so it sits near the left edge; with Follow off the view never moves by itself while playing, even when the playhead runs off screen; the user asked for that), `+` `−` and `1`–`5` zoom into the middle of what is on screen; the `Z` switch ("Zoom on playhead") makes them centre on the playhead instead (the marker when stopped).
      - **Squeeze:** a section is `{i, s, sq}`: `s` = shift at its start, `sq` = how much further the shift is at its end (0 = locked to the tab's tempo, the video only moves). Click a section's name to pick it; `[` squeezes, `]` stretches (Shift 100 ms, Ctrl 1 ms), `K` locks it back. Dragging a pink cut line moves that boundary and squeezes/stretches both neighbours (the map stays continuous); double-click cuts at the bar nearest the pointer. `savePoints` samples the shift at every bar, so the saved `syncPoints` carry the squeeze as bar times. Playback is cut into straight pieces at every section start and every file sync point, each at its own speed.
      - **Shortcuts on screen:** every header button wears its key; a zoom bar (1–5, the active level lit); a row of switch chips (T V E O L G) lit when on; `?` (or the Shortcuts button) opens a grouped list with the mouse actions in orange. `TOGGLES`, `ZOOMS` and `HELP` in `aligner.html` are the one place that defines them. A clicked button is blurred on the next key so Space and Enter still reach the page.
      - **Loudness panel** (footer): sliders for the whole tab, the whole video, each tab track (`/audio/<slug>/tab-<index>.wav`) and each video stem (`rec-drums|bass|other|vocals.wav`, only when `drumclock.py` has made `stems-<id>/`). M mutes, S solos. All are scaled by the whole mix's factor, so the tracks add up to `tab.wav` (checked: within int16 rounding). The first touch fetches the rows (~5 s for Ho Hey); after that the side plays the separate instruments and its waveform shows what the sliders leave. Stems only add up to the video's mix approximately.
    - Save writes new `syncPoints` into the song's newest `.fretboard` in `tests/yt2gp5/out/listen/<song>/` (first version kept as `.fretboard.before-aligner`); import it in Fretboard with "Replace it". Save also writes `syncOffset: 0`, `videoMaster: 0`, `videoBpm: 0`, because "Replace it" keeps the library song's old values of those, and a leftover app nudge sat on top of the new times. Audio comes from `tests/yt2gp5/cache/real/`, so the song must have been through `fromlink.py`/`listen.py`. It opens on the tab's first note at the 3 s zoom.
    - **Trap (fixed):** `decodeAudioData` resamples to the browser's rate (48000 here), not the file's 22050. The page indexes samples with `S.rate`, so it must be set from `buf.sampleRate`; before, every waveform was drawn 2.2× too late (no peak at the first guitar notes).
  - **Wave fitter (2026-10-27):** `python tests/yt2gp5/wavefit.py NAME [--check] [--selftest] [--layers mix|stems|all|drums,bass,…] [--range S] [-v]` lines the tab up with the video by the note starts of the two sounds, by script (numpy only, light CPU, ~10 s a song). Re-execs itself in the yt2gp5 venv.
    - It only moves bar start times (`syncPoints`); the sheet music and rests are untouched. Steps: note-start curves at 5 ms → ~5 s windows × lags ±1.5 s → Viterbi path → robust line with tempo knots only where proven → whole-song knot tuning. Details in the file's docstring.
    - Trust: `--selftest` makes fake recordings (copy, late 3 s, ±3% speed, noisy) with a known truth: **10 of 10, every bar within 7.4 ms**. On a real song the gate is `qa.judge` (scored by `fixsync.score`); it writes only when better, keeping `<song>.fretboard.before-wavefit`. `fixsync.py` runs it as a try named "wavefit".
    - Default layer is the whole mix, because the recording's stems disagree by ~60 ms (Ho Hey: drums ≈ +15 ms, other stems ≈ −48 ms vs the file's sync).
    - Fixed on the way: `qa.features` reused a stale `qa_env.npz` after a recording change (now checks the wav's sha and length).
    - **Ending knot (2026-10-27):** the user heard Ho Hey drift from bar 48 on ("they slowed their tempo"). The first fit kept one tempo to the end: the knot rule wanted 2 clear windows in every stretch, and the long steady middle has none. Now a second try, `wavefit + ending` (`ending=True`), puts one more knot on the line in the last stretch (the middle stays exactly as it was) and gives it its own end value; the gate judges both tries and keeps the better (a few windows can't tell a real slow-down from a chance peak: with the ending rule always on, the self-test's noisy bad-start case ran 0.56 s off at the end). Ho Hey: last 9 s at 96.7–97% of the tab's tempo; bars 49–51 +159 ms → +9 ms.
    - Also: the lag path may move at most 6% of the time between windows (`LAG_STEP_PCT`); a short last window joins the one before; `aligner.save(..., sections=)` writes `tempo_sections` so the gate lets those tempo steps jump.
    - **Ho Hey result:** the first tab note maps to video 2.467 s (was 3.448 s); the intro runs at 98.2% for 0–57 s, then ~100%, then the slow-down. Median stretch error 9 ms (file's sync: 19 ms). Gate: 1 fail, 4 drift bars (was 2 fails, 15): only bars 37–40 are left (−61 ms; a musical difference, not the clock). **The user heard it: perfect to bar 47 on the first version, and "perfectly synced" with the ending fix.**
    - **In the pipeline (2026-10-27):** `listen.py` (so `fromlink.py` and `ladder.py`) runs `wavefit.run()` after the one-tempo fit. It writes only when the gate likes the result better, else the one-tempo file stays (`--no-wavefit` skips it). A strummed song looks the same one beat away, so a small cost per second of lag (`LAG_COST`) makes the lag nearer the file's sync win ties (Count On Me had locked a beat early); a song where no window is clear but every window agrees on one lag (`POOLED_Z`) still runs.
    - Where the tab doesn't match the recording (gate: "the tab's part differs", chord distance over ~0.1) it says "too few clear note starts" and leaves the file alone. Riptide and Hey Soul Sister (UG tab vs official audio, 2026-10-27) both did, and the gate FAILs them: that is the tab, not the clock. Count On Me was already right (first note 0.28 s in both); nothing written. Shut Up And Dance, Believer and Pompeii failed on 2026-10-26 with "Couldn't turn … into a .gp" (the PDF import step made no file, exit code 0, no output). It did not repeat on 2026-10-27 (same call, same PDFs): likely a one-off while the PC was overloaded. `fromlink.py` now prints the converter's output, so a repeat shows its error. Results then: Shut Up And Dance PASS, Pompeii PASS (bar 1 within 1 ms of wavefit's own fit, two different methods agreeing), Believer LISTEN (the tab's part differs in bars 3-20).
    - **Harmony tries (2026-10-27, the user asked for a smarter sync):** `wavefit.run()` also runs `wavefit + harmony` (and `+ ending`). Each window's evidence is the note-start z plus `HARM` (0.8) × the z of how alike the tab's and the recording's chords are (`harmony_matrix`, chroma from `qa_env.npz`), so a strummed song, or one with few clear note starts, still gets one clear place. The gate picks the best try, so it is never worse; `--selftest` also runs the harmony variants (20 of 20). By the gate: Pumped Up Kicks FAIL → PASS (ending knot), Sweet Home Alabama FAIL (42 drift bars) → LISTEN (8), Stressed Out 24 → 12 drift bars, Riptide 24 → 16 (plain wavefit gave up on Riptide and Sweet Home Alabama); no gain on the rest. Written for those four (backups `.before-wavefit`); not heard by ear yet. Ladder by the gate now: PASS Ho Hey, Pompeii, Shut Up And Dance, Pumped Up Kicks, Be My Escape; LISTEN Count On Me, Believer, Sweet Home Alabama; the rest FAIL, almost all because the UG tab differs from the recording (chord distance 0.1–0.14), which no alignment can fix.
    - **Library tools (don't redo):** the venv already has librosa, synctoolbox, beat-this, basic-pitch, mir_eval, demucs. synctoolbox MrMsDTW was tried (`anchors.py`, 2026-10-24) and lost to wavefit; Beat This! beats feed `syncqa --fit`. Next idea: a truth benchmark from AAM (`%USERPROFILE%\fretboard-data\aam-*`, CC BY 4.0): recordings warped by a known tempo map, to tune on exact numbers instead of 14 songs judged by a gate.
- **Dev server:** `node server.mjs` serves http://localhost:8420, the user's own copy. `PORT=8421` is the preview.
  - Use preview_start with the `fretboard` entry in `.claude/launch.json`.
  - Never start a second server on 8420: the user may be using it.
- **Tests:** `node scripts/test.mjs`. Run them after any change to `js/ugtab.js`, `js/pdftab.js`, `js/chordsheet.js` or `js/player.js`.
- **Round-trip import test:** `python tests/roundtrip/roundtrip.py` (`-k NAME`, `--keep`, `--verbose`).
  - Draws each song in `tests/roundtrip/songs/` as UG-style tab PDFs (Letter), reads them back with `pdfToTab` and `ugToAlphaTex`, and prints a score per song and check. Exits 1 below the pass mark in `config.json`.
  - Needs Python Playwright with Chromium; no server (it serves itself on a free port). About 6 s.
  - The PDFs are alphaTab's, styled like UG (stems and TAB clef patched in `harness.js`). See `tests/roundtrip/README.md`.
  - Use it to check an importer change: the score should not drop.
- **Website:** GitHub Pages from `Nathancald3r/fretboard`, branch `main`.
  - A push to `main` updates the website **and** the UG helper, which downloads its files from there.
  - The user has approved pushing helper/importer fixes.
- **Android** (`node scripts/apk.mjs` does all of this):
  - Bump `versionCode` and `versionName` in `android/app/build.gradle`.
  - Build with `cd android; ./gradlew --console=plain assembleRelease -q`. The output is `android/app/build/outputs/apk/release/app-release.apk`. The web files are copied into the APK by the `copyWeb` task.
  - Check the APK is under 30 MB, then send it with SendUserFile.
  - **Install on the user's phone** (a Pixel 8a over USB): `~/AppData/Local/Android/Sdk/platform-tools/adb.exe -s 49111JEKB02598 install -r android/app/build/outputs/apk/release/app-release.apk`. `adb` isn't on the PATH, and `-s` is needed because an offline emulator also shows in `adb devices`. Check with `adb shell dumpsys package app.fretboard | grep versionName`.
  - Keep a copy as `Fretboard-<version>.apk` in the project folder (not committed).

## Line endings: check before every commit

- `js/ugtab.js` is stored with **CRLF** line endings. `tools/ug_collect.py` and most other files use **LF**.
- `sed -i` or a Python rewrite can flip the line endings, and the commit then shows the whole file as changed.
- `node scripts/ship.mjs` does this check and fix for you.
- **Before committing by hand, run `git diff --stat`.** If a small edit shows hundreds of changed lines, restore the original endings first:
  - to CRLF: `sed -i 's/$/\r/' file`
  - to LF: `sed -i 's/\r$//' file`
- Prefer the Edit tool over `sed` for code changes.

## How an official Ultimate Guitar song gets in

1. **UG helper** (`tools/ug_watch.py` serves on 127.0.0.1:9231; `tools/ug_collect.py` drives Chrome).
   - **Install and start:**
     - The installed copy lives in `%USERPROFILE%\Fretboard UG helper`.
     - The user starts it with "Start UG helper" (`start.cmd`), which runs `ug_helper_setup.py --refresh`. That downloads the latest helper files from https://nathancald3r.github.io/fretboard/tools/.
     - **A fix reaches the user only after a push and a restart of the helper.** When the user reports a helper problem, first ask whether they are still running the old helper.
   - **Allowed pages:** the helper accepts only the page origins listed in `ORIGINS` in `ug_watch.py` (GitHub Pages, and localhost/127.0.0.1 on 8420 and 8421). A page on any other port gets "The UG helper didn't start".
   - **Collector Chrome** runs on CDP port 9222. For tests, connect with Playwright `connect_over_cdp("http://localhost:9222")` and pick the page whose URL contains "official".
2. **Official songs are saved as one PDF per instrument, plus `Chords.txt`.** Guitar Pro files only come with `--gp`.
   - The user wants PDFs that Fretboard converts. Never switch the default back to .gp.
   - **Pro and Guitar Pro tabs** (URL has `-pro-`) are different: the helper saves only the .gp/.gp5 file from their Download button (`page_kind` / `save_gp`). Only `-official-` URLs get PDFs.
   - The user does this legally: never add stealth, bot-hiding or paywall bypassing.
3. **The importer:** `importFiles` → `importPdfParts` → `readParts` (in `js/app.js`).
   - **Each PDF:** `pdfToTab` (`js/pdftab.js`) → `findStaves` + `readStrip` (`js/ugtab.js`).
     - Drums and shaker go through `findDrumStaves` / `readDrumStrip` (`js/ugdrums.js`) instead.
     - A part with no strips becomes sheet music.
   - **Combining the parts:** `ugToAlphaTex(parts[0].strips, { extra: parts.slice(1) })`. Every part is cut or padded to the first part's bar count.

### How the helper captures a track (`save_track` / `PAGES_JS` in `ug_collect.py`)

- **Speed (2026-10-23): a whole song (8 tracks + chords) takes about 20 s.** Most of that is UG drawing its own print pictures (pure UG CPU work), the floor. Keep it fast:
  - **Standard + Tab prints are off by default** (they were ~15 s). Fretted tracks then get only their tab pages, so Fretboard has no dynamics or words. The user turns them on with the checkbox on Fretboard's UG helper line: `/settings` in `ug_watch.py` keeps `{"notation": true}` in `settings.json` beside the helper (a `--refresh` leaves it) and passes `--notation` to `ug_collect.py`.
  - **Main route: UG's own Print pictures** (`GRAB_JS` / `printed_lines`). A patched `execCommand`/`print` in UG's print frame takes the line pictures, so no Print window opens. Screenshots (`shots_pdf`, the two pictures below) are only the fallback.
  - **PDFs are written in the background** (`PdfWriter`, over raw CDP) while the next track is taken.
  - **Always 127.0.0.1, never localhost**: on Windows each localhost connection costs 2 s.
  - **One Playwright connection per run.** A new one costs ~0.4 s. Another thread needs its own (`find_chords` searches UG for chords while the tracks are taken, when the song has no Chords view).
  - **Notation switch by page JS** (`SWITCH_JS`, ~0.1 s). Pointer clicks are the fallback. Track picks keep the locator click (JS presses were unreliable). The Instruments toggle needs a raw `pg.mouse.click`.
  - **Untabbed tracks first** (vocals, drums, keys): they need no view switch.
  - No fixed waits: wait for the change itself (`settle` in `ug_watch.py`, `wait_for_function`).
  - Tried and slower: tabs in parallel. Never lower the picture scale (quality).
- **Cut print pictures:** UG's Print can cut a line's picture right through its bottom staff line (a line with nothing under the staff). `mend` in `PAGES_JS` draws that line back. Without it the line read as five lines and was lost (Synth Pad: 78 bars, not 85).
- **Cut words at a page's foot:** Print lays its lines out on pages of up to 10000 px and cuts the last line on each page through its notes or words. `PRINT_H` 6000 (a 12000-px canvas at 2×) keeps the drawing below the page, and the `getImageData` hook in `GRAB_JS` carries a cut that ends on ink down to the next blank gap. At a smaller height the cut stays. Bar numbers cut at the left edge are outside UG's canvas and can't be recovered, so the PDF has a 5 mm side margin.
- **Doubled lines:** that carry-on (and Print's own slices) can run into the top of the next line, which the next picture then has whole. `repeats` in `PAGES_JS` cuts a picture off where its tail matches the next picture's top pixel for pixel (Synth Pad: the 15–18 staff twice, and bar numbers stacked "5" over "5").
- **Official chords:** the JS in `official_chords` needs `'\\n'` in the Python string. A plain `'\n'` broke the JS, and official chords always came back empty.
- **Switch the view first.** Before saving, it sets the player's Settings → Notation to **Tablature** (`notation(pg, "Tablature")`), then puts the user's own choice back afterwards. Settings shows the user's choice as "St. + Tab"; to restore it, pick the option "Standard + Tablature".
  - Why: in "Standard + Tablature" the note lengths exist only in the music staff, so the tab has no rhythm stems. Every note then reads as a quarter note, and the time signature comes out wrong (13/4 was seen).
- **Screenshot fallback: take two pictures every time:** one at the top and one scrolled to the end. `PAGES_JS` matches the two by their ink-per-row profile and joins them.
  - The canvas (`#xtz_canvas`) is viewport-sized and sticky, so one picture never covers a long song.
  - Never skip the second picture on a "looks complete" check: the song can end in the gap between two lines.
- **Wait for a steady picture:** `steady()` takes pictures until two in a row agree.
- **Jumbled pictures → UG's Print instead** (`printed_lines`):
  - A picture is "jumbled" when the score wasn't cut into lines: a part taller than a page, or one tall part. PAGES_JS returns `glitch`.
  - Print builds a same-origin frame with one PNG per line. Those PNGs are read through CDP `DOM.getDocument` with pierce, and the Print window is then cancelled. Nothing is printed and no Save As dialog opens.
  - Playwright's open connection never sees a Print window opened after it connected, and `time.sleep` doesn't pump its events. So `print_open()` checks over HTTP, and `cancel_print` clicks Cancel from a fresh process. Use DEVNULL for its output: `capture_output` hangs.
  - About 10 s per track. The tab must be in front.
- **No fixed waits** where something can be watched. The user wants no pointless clicks or delays. Poll for the state instead (view switched, track shown, canvas resized).

### Reading the tab, and the traps already hit (keep these)

- **Song length:** every part must read the same number of bars as the song (Here I Am To Worship: 85).
  - To check, read each part with `pdfToTab` and compare `bars`.
  - To find where a part gains or loses a bar, compare the bars read per line with the bar numbers printed at the start of each line.
- **`findStaves`:**
  - **Line detection:** a staff line covers 45% of the page width, *or* is one unbroken run of 15% of it. A one-bar last line is short, and missing it lost a bar.
  - **Thick bands are not staff lines.** A band more than twice the median line thickness (a beam, a block of words) is dropped. It shifted a staff a string down.
  - **Broken lines:** a row's dark runs joined across small holes (≤ 2.5% of the width, ≥ 80% filled) count as one run. A one-bar last line with broken lines was lost (bar 85).
  - **Seven equally spaced lines** means a six-line staff plus a stray line. Keep the six whose gaps fit best.
  - **A five-line run is a music staff:** skip all of it. Don't step one line on, or its last four lines read as a bass staff (that gave 275 bars).
  - **All of a staff's lines start at the same x.** A beam over a music staff starts after the clef.
- **`pdftab.js` `tabSize`:** keep only staves whose line spacing is within 20% of the page's median. A music staff with a ledger line or beam can pass as tab.
- **`pdftab.js` rescale:** after the page is redrawn at tab size, a pale 1-px staff line can fall across two rows, both too pale to count, and its staff is lost. If staves went missing, it tries 1.01× and 0.99× and keeps whichever finds more.
- **Testing `pdfToTab` in the preview:** run one at a time with `{ lyrics: false }` (two at once share the lyric reader and hang). Its signature is `pdfToTab(buf, onProgress, opts)`.
- **`barLines`:**
  - **Final double bar:** bar lines closer than one staff space are one bar line. Otherwise the thin and thick lines of the final double bar add an empty bar.
  - **No closing bar line:** a line without one closes at the staff's end.
- **Multi-bar rests:** a thick bar with a number above it. `thickRest` and `readRestCount` read it, and `barsOf` expands it into that many bars.
- **Stems:**
  - A stem must be at least **0.85 staff spaces** tall. In tab view the lyrics sit just under the staff, and their tall letters (b, d, H, I), about 0.75 spaces, were read as stems, which made fake held notes.
  - Real stems start 0.6–0.8 spaces below the last line. A half note's stem is about 1 space tall, a quarter's about 2.4.
- **A note with no stem found:**
  - If it sits over a beam, the beam gives its length (some stems are drawn only a pixel or two above the beam).
  - Otherwise it gets `guess: true`. In tab view that means a whole note, and a lone chord rings to the end of the bar.
  - A bar that has a guessed note is spaced by how far apart its notes sit.
- **Capo per track:** UG gives each track its own Tuning / Key / Capo (Trust In God: acoustic in Eb tuning, capo 6, G shapes, sounding C; piano and synth pad in C, no capo). The helper writes "Capo: …" into each fretted PDF; `pdftab.js` reads it. Older PDFs: `partCapos` (`ugtab.js`) finds the capo that puts the part's notes into the song's key (UG's key, else the notation parts' key).
- **Tuning menu (player):** another tuning keeps the frets, so the whole song moves (`retune` in `transposeScore`), and a red "Not the original key" badge shows.
- **Time signature and tempo** come from **all parts**, not just the first:
  - bars with a guessed note don't vote on the bar length
  - the first tempo mark found in any part is used (the mark may sit over only one part's staff)

### How to check an import in the preview (the browser tool times out after 45 s)

- **Long runs:** start them as `window.__run = (async () => { ... push results to window.__out ... })()`, then poll `window.__out`.
- **After editing a module:** reload the page (`location.reload()`). ES modules stay cached even if you add `?v=`.
- **Test PDFs:** copy them into a temporary folder in the project (e.g. `_ug4/`) so the server can serve them, and delete it before committing.
- **Import all parts at once:** put `File`s into a `DataTransfer`, set `#file-input`'s `files`, dispatch `change`, then click `[data-go]` in the review dialog.
- **Check the result:** `window.fretboardPlayer.api.score` has the master bar count, time signature and tempo. Check that each track's bar beats add up to `masterBars[i].calculateDuration()`.
- **Python PDF checks:** render pages with `fitz` (PyMuPDF), e.g. `page.get_pixmap(dpi=60)`, to look at them.

## Library cleanup: "Pick not synced" (2026-10-27, asked by the user)

- In the library's **Select** mode the bar has **Pick not synced**: it ticks every listed song that isn't *official Ultimate Guitar tab + linked YouTube video + Synced* (`officialGaps` in `js/songmeta.js`, tested in `tests/songmeta.test.mjs`). Each row says why in orange ("tab not official · no video · not synced"). Nothing goes until the user unticks what to keep and presses **Delete**.
- **The user's "GitHub library" is the private repo the app syncs to** (`fretboard/library.json` + one file per song, `js/sync.js`), not the code repo `Nathancald3r/fretboard`, which holds no songs. A song deleted in the app leaves that repo on the next sync, so the cleanup has to be done in the app on a device with sync on. Claude can't reach the user's browser storage or token.
- "Official tab" = `song.sourceUrl` parses (`parseSource`) as an UG `-official-` link; songs imported before `sourceUrl` was kept look unofficial and get ticked, which is why the user reviews the list.

## Phone → computer → phone: "Ask my computer for a song" (2026-10-27, asked by the user)

The user wants the APK on the phone **only once sync results are consistent** (APK 1.53 is built and held; `node scripts/apk.mjs --no-bump` installs it). The goal: save a song on the phone, the computer fetches the official UG tab and the official lyric/music video, syncs them, and the finished song lands on the phone by itself.

- **Phone side (built, in the web app):** on a device with no UG helper (the phone), an empty library search shows **Ask my computer**; the ＋ menu has **Ask my computer for a song…**. It saves a placeholder (`kind: 'text'`, empty, `want: { state: 'asked' | 'working' | 'failed', at, reason }`, `js/wanted.js`) that the normal library sync carries to the private repo. A placeholder row shows its state ("Asked: your computer will get it", "Your computer is getting it…", "Couldn't get it: <reason>"); tapping it says so instead of opening; its ⋮ menu has **Try again** (failed) and **Delete / Cancel the request**. Needs Sync and backup turned on (the ask says so otherwise).
- **Computer side (built, not running by itself yet):** `node scripts/songworker.mjs` (`--loop`, `--every MIN`, `--dry`) is one more device of the same library (it reuses `js/sync.js`, copy in `%USERPROFILE%\.fretboard\worker\library`). For each asked song: sets "working", searches YouTube (`tests/yt2gp5/ytfind.py`, ranked by `js/ytsearch.js`: the artist's own upload, official audio / lyric before the music video, never covers; up to 3 videos tried), runs `tests/yt2gp5/fromlink.py` (official UG tab, .gp, wavefit, QA gate). **Only a PASS is delivered** (same uid, so the phone's sync replaces the placeholder). LISTEN, FAIL or an error leaves a one-line reason on the placeholder; nothing half-synced reaches the phone. No official UG tab = "no official tab on Ultimate Guitar" at once (another video won't change that).
- **One-time setup the user must do:** put `{ "repo": "owner/name", "token": "…" }` (the same private repo and fine-grained token as the app's Sync panel) in `%USERPROFILE%\.fretboard\sync.json`. Claude never writes the token. A file `%USERPROFILE%\.fretboard\worker\PAUSE` holds the pipeline (rounds still sync). One worker at a time (lock file; it shares the collector Chrome). Not set up as a Windows scheduled task: that is the user's call (CPU heat, PC check pending).
- **Tests:** `tests/wanted.test.mjs`, `tests/songworker.test.mjs` (phone + worker + fake runner on an in-memory repo: working → delivered, FAIL reason, retry, pause, dry, unreadable file). The Python pipeline part was not run end to end from a phone request yet.
- **Why "consistent" is still open:** the ladder is 2 PASS, 2 LISTEN, 8 FAIL of 12, mostly the UG tab differing from the recording, so most asks would come back "couldn't get it" today. Next: calibrate the gate by the user's ear (Viva La Vida bars 1-8), split clock problems from tab mismatches, then run the worker on a few real songs.
- **Gate calibrated by ear (2026-10-27):** the user hears Ho Hey (the aligner-saved file) as perfectly synced, but the gate failed it on one isolated stretch, bars 37-40, 61 ms off. `syncqa.steadiness` now calls a stretch **`spot`**, not drift, when it is off by ≤ `SPOT_MS` (75) and both neighbouring stretches are on time (a part played a little early or late; the tempo is steady). Ho Hey now PASSes; `qa.py --selftest` still 72 of 72 (every broken sync fails). Keep ear-confirmed songs as the calibration cases; loosen further only from what the user hears.
- Trap seen in the preview: a `<dialog>` `close` event can arrive late in the unfocused browser pane, so a test that clicks OK and reads state at once sees nothing; dispatch `close` by hand or wait.

## Practice tab = foundations, no songs (2026-10-27, asked by the user)

- The Practice page teaches the basics: **Warm-ups, Scales, Chords and changes, Rhythm and timing, Technique, Ear and theory**, plus a 10-minute **Today's warm-up** routine (a checklist). Data and exercise text are in `js/foundations.js` (`EXERCISES`, `FOUNDATIONS`, `ROUTINE`; pure, no page code), the page is `js/practicehub.js`. `tests/foundations.test.mjs` parses every exercise with alphaTab (4/4 full bars, real frets, effects present, every exercise on the page once, titles unique).
- **Why songs showed up there:** the page listed every `kind: 'tex'` song, and imported PDF tabs are `tex` too. It now lists only `chartType(s) === 'exercise'` (the rule that already hides exercises from the library). Exercises you made yourself (a scale from the Scales page, a backing track) sit in a small "Your own exercises" panel; the two seeded demos are not repeated there.
- A card saves the exercise as a library entry (found again by **title**, so its practice time adds up and nothing is saved twice) and opens the player. A routine step ticks itself from today's sessions (an exercise by its title, a drill by its id), or by hand (`fretboard-routine` in localStorage, with the day, so it resets by itself).
- To add an exercise: put it in `EXERCISES` (title, tempo, level, tip, `tex()`) and in a category of `FOUNDATIONS`; run `node scripts/test.mjs`. Strings in the text count 6 (low E) to 1.

## Chord sheet viewer (2026-10-27, asked by the user)

- The text view (`kind: 'text'`) is a slim one-row bar (☰ library, title, key chip, transpose, capo, A−/A+, auto-scroll, Edit, ⋯ menu) over the lyrics; `body.in-text` hides the global top bar. The ⋯ menu holds the rest (Fit, Fold repeats, chord shapes, video, Play as tab, Perform, chord names). On phones the bar is two rows.
- **Stored vs edited:** a song is still stored as UG-style chords-over-words text (`song.data`, a head plus `[Section]` headers): playback sync, share, library detection and the UG helper read it. The **editor shows ChordPro** (`[G]` inline, `editorText` / `fromEditor` in `js/texttab.js`, `sheetToChordPro` / `readChordPro` in `js/chordpro.js`); `{G}` is read too (`curlyChords`), `[G]` is what is written. The editor has a live preview.
- `js/chordsheetview.js` (pure) builds the view: `readSections`, `foldRepeats`, `capoPlan`, `viewHtml`. `tests/chordsheetview.test.mjs` covers it, the `{G}` reading and the sheet → ChordPro → sheet round trip.
- **Repeats:** the first occurrence is shown in full; an identical later section (≥ 2 lines, or the same name) becomes `↻ Chorus ×N`. `song.fold === false` shows everything.
- **Capo:** `song.capo` is the capo fret (null = the sheet's own). Shapes shown = written chords + transpose + sheet capo − capo; the key chip moves only with transpose.
- **Fit:** `fit()` first tries **two columns** (on any screen wide enough for two) at the biggest text (24 down to 12) that fits the whole song on screen (the user asked, 2026-10-27); if two can't hold it (or tab lines don't fit across), the biggest text with the fewest columns (1–3); else one column that scrolls. `song.textSize` set by A−/A+ is kept; null = auto. The video docks beside (≥ 1000 px) or under the song; it never floats over the chords.
- **Floating tools (2026-10-28, asked by the user, from two reference screenshots):** a column of tiles at the right edge (`#tx-tools`, `initTools` in `js/texttab.js`); the song keeps its own room beside it (`--tools-w` on `#view-text`, set by `layoutTools`). The top bar lost A−/A+ and the ▶ scroll button to it. Top to bottom:
  - ⚡ **Quick start:** to the top, a 4-beat count-in at the song's tempo (`countIn`, `js/sheetclick.js`), then auto-scroll (the click goes on if it was on). Tap again to cancel.
  - ▶ **Video / backing track:** the video if one is open closes it; else a two-button pick: **Video** (the song's linked one, or finds one) or **Backing track** (`openBacking`: the sheet's chords, one bar each, in the key it sounds in, `backingTex` pop style, opened in the player as a library song "<title> – backing (Pop)", reused by title).
  - 🔍 **Zoom ±:** text size steps (`SIZES`), kept in `song.textSize`; Fit is in ⋯.
  - ✎ **Notes:** with it on, tap a line or a section's name: write a note (≤ 400 chars), pick one of 4 colours, or leave it empty to just colour the line. Stored in `song.annotations = [{ k, text, color, label, at }]`, **not** in `song.data`, so sync, share and the UG helper are untouched. `k` = `lineHash` / `sectionHash` (`js/chordsheetview.js`): a note is tied to what the line says, so the same line written twice shows it twice, and a note survives edits elsewhere. When its line changes it moves to "Notes on lines you changed" at the end (`orphanNotes`, `js/sheettools.js`). Not exported to ChordPro/PDF.
  - 🥁 **Metronome** (click at the song's tempo, `js/sheetclick.js`; the tempo is changed in ⋯) with, right under it, the **scroll group**: **+** faster, **↓** start/stop (shows the speed 1–20), **−** slower. `pxPerSecond` = speed × 6.
  - Pure parts are tested in `tests/sheettools.test.mjs`.
- **Trap:** the Edit tool turns `styles.css` (mixed endings, CRLF majority) into all CRLF; give unchanged lines their HEAD endings back (or let `ship.mjs` flag it) before committing.

## Android Back and the history (`js/layers.js`)

- Each open layer (the ☰ drawer, a sheet, the ⚙ menu, the tempo or video pop-up, full screen) adds one history entry, so Android Back closes it first. Layers are found from body classes and `.sheet[hidden]` by a MutationObserver.
- A layer closed from the screen calls `history.back()` to drop its entry. **Not when a link moved the page meanwhile:** tapping a song in the drawer closed the drawer, and that Back undid the link, so the library opened no song (fixed `92facfb`). The check waits one tick (`setTimeout`), because the observer runs before the link changes the address.
- `route()` calls `resetLayers()` on every page change.

## Preview checks: other traps

- **Never navigate the preview to a non-HTML file** (e.g. a .pdf or LICENSE): it pops a Save dialog on the user's screen. Fetch it from page JS instead.

## Sound engine: our patches to alphaTab's synth

- `vendor/alphatab/alphaTab.js` is **generated**: edit `scripts/vendor.mjs`, then run `node scripts/vendor.mjs`. Each patch throws if alphaTab's code changes, so an upgrade can't silently drop one.
- The soundfont is `vendor/soundfont/MuseScore_General.sf3` (downloaded once, never in the APK). It was made for FluidSynth, and alphaTab's synth (a TinySoundFont port) reads it differently. The patches:
  1. **NaN guard:** a bad sample is dropped and the voice's low-pass filter is cleared. Before, one NaN silenced the whole song (When I Go Down went silent at bar 18).
  2. **Stereo samples load** (`sampleType & 7`). alphaTab loaded only mono samples. The grand piano is stereo, so it played nothing.
  3. **Modulators:** alphaTab ignores soundfont modulators. `fbCollectMods` / `fbApplyMods` apply the ones that move the filter (`initialFilterFc`, `modEnvToFilterFc`) by velocity or key when a note starts. Without them the piano's filter stayed closed near 80 Hz.
  4. **Volume:**
     - Velocity layers are read at FluidSynth's 0.4× attenuation. Only the part above an instrument's loudest layer is scaled.
     - **Floor:** a normal hit (velocity 95, middle C) is never quieter than 20 dB, the quietest guitar preset. Quieter instruments are lifted as a whole (`fbLift`).
     - The guitars measure exactly as before. Keep it that way: guitar sound comes first.
  5. **Direct audio channel:** the synth worker and the AudioWorklet talk over their own `MessageChannel` (`fb.direct`). The main thread no longer passes the sound along.
     - Why: alphaTab queues only about 0.2 s of sound. When the page stalled (a redraw, an import, a busy PC, a background tab), the sound had gaps and the song fell behind. 0.25 s stalls lost 1.4 s in 4 s.
     - Checked: 0.6 s page stalls, and every CPU core busy, lose nothing.
     - To measure: play, block the page with a busy loop, and compare `api.timePosition` progress with wall time.
  6. **Drum sounds on a second drum channel:** alphaTab loads drum samples only for keys played on channel 9. A channel set to bank 128 (`ownDrumChannels` moves a second percussion track there) counts too now. Without it, When I Go Down's drums and percussion were silent. That .gp5 also gives both tracks one shared `playbackInfo`, so `ownDrumChannels` copies it before moving a track.
- **To measure the sound** in the preview:
  - `api.exportAudio(new alphaTab.synth.AudioExportOptions())` with `playbackRange` and `trackVolume` (a Map of track index → volume), then `render(500)` until it returns null. Sum the RMS and count NaN.
  - Use the default sample rate (22050 gives NaN everywhere).
  - Volume 0 doesn't hide a NaN track (NaN × 0 = NaN).
- Reference: When I Go Down `.gp5`, bars 18–20, solo RMS:
  - acoustic guitar (track 0) 0.0347
  - piano (track 4) 0.0146

## Where we left off (2026-10-27)

- **Roadmap board (live, editable Kanban):** https://claude.ai/artifact/6bKMech8PfTJJwNHbYdVf7 (replaces the old 5udvK5… link, which this account can't open). The cards and goals live in the artifact's database (`cards`, `goals`), not in the page. The user edits, drags and ticks steps on the page; the page updates live.
  - **Keep it current (the user asked, 2026-10-27):** whenever work starts, finishes, fails or turns up a new job, update the board with the ArtifactData tool (`update` a card's `col`, `pos`, `steps`, `why`; `set` a new card; batch for several). Moving a card to done: `col: "done"` and `pos` below the lowest in that column. Tick steps by rewriting the `steps` array. Always set `upd` to `Date.now()`. Read the card first and pass `if_version`.
  - **Scheduled sync (2026-10-27):** the scheduled task `roadmap-board-sync` runs every day at 9:00 (while the app is open; a missed run happens on next launch). It reads `git log` and `TODO.md`, ticks finished steps, moves cards to done only on proof from git, and adds cards for new jobs in TODO.md. It never moves cards between other columns, never marks the PC check or the Be My Escape / Stupid Deep card done, and never edits files or pushes. Change its time or prompt with the scheduled-tasks tools.
  - **Card fields:** `area` (a goal name), `col` (avenue, next, doing, done), `pos` (order in the column, smaller is higher), `title`, `why`, `time`, `cpu` (none, light, heavy, GPU), `wifi`, `crit`, `unlocks`, `how` (commands in backticks), `steps` (`[{t, d}]`).
  - **Source:** `roadmap/board.html` is the page only. `roadmap/board-seed.json` is the starting content, for rebuilding the database. Republish the page with the Artifact tool and the same URL (keep `capabilities: {db:{}, user:{}}`). The same list, in words, is "Roadmap: what's next" at the top of `TODO.md`. Keep them in step.
- **PC:** on 2026-10-26 the PC smelled like burning with the CPU near 100%. Nothing heavy (sync ladder, training) until the user says it was checked.
- **Latest APK:** 1.52 is built (`Fretboard-1.52.apk`); the phone may still have 1.48. `node scripts/apk.mjs --no-bump` installs it.
- **Sync ladder (latest work, 2026-10-26):** see "Sync ladder: where it stopped" in `TODO.md`. Ho Hey started ~0.9–1 s late; `wavefit.py` (2026-10-27) now puts bar 1 right on the note starts, but the user has not listened yet (import `Ho_Hey.fretboard` with "Replace it"). The 12 recordings are downloaded, so public Wi-Fi is fine.
- **Be My Escape and Stupid Deep:** sync waits for the user to listen and confirm.
- **Done and pushed 2026-10-23/26:** songs page redesign, sharing to MusicStand / OnSong / SongbookPro, ChordPro and chord-chart PDF import, chord sheets, Power Tab import, round-trip test 7 of 7 (99.6%), library fix (`92facfb`), helper claim lock, ladder on official audio, fake-recording sync test 5 of 5, data factory 300 of 300.
- **Open:** the full list, in order, is "Roadmap: what's next" in `TODO.md`.
