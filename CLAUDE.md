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
    - Save writes new `syncPoints` into the song's newest `.fretboard` in `tests/yt2gp5/out/listen/<song>/` (first version kept as `.fretboard.before-aligner`); import it in Fretboard with "Replace it". Save also writes `syncOffset: 0`, `videoMaster: 0`, `videoBpm: 0`, because "Replace it" keeps the library song's old values of those, and a leftover app nudge sat on top of the new times. Audio comes from `tests/yt2gp5/cache/real/`, so the song must have been through `fromlink.py`/`listen.py`. It opens on the tab's first note at the 3 s zoom.
    - **Trap (fixed):** `decodeAudioData` resamples to the browser's rate (48000 here), not the file's 22050. The page indexes samples with `S.rate`, so it must be set from `buf.sampleRate`; before, every waveform was drawn 2.2× too late (no peak at the first guitar notes).
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
- **Sync ladder (latest work, 2026-10-26):** see "Sync ladder: where it stopped" in `TODO.md`. Ho Hey starts ~0.9 s late; `fix_start` exists but its check rejects the move. The 12 recordings are downloaded, so public Wi-Fi is fine.
- **Be My Escape and Stupid Deep:** sync waits for the user to listen and confirm.
- **Done and pushed 2026-10-23/26:** songs page redesign, sharing to MusicStand / OnSong / SongbookPro, ChordPro and chord-chart PDF import, chord sheets, Power Tab import, round-trip test 7 of 7 (99.6%), library fix (`92facfb`), helper claim lock, ladder on official audio, fake-recording sync test 5 of 5, data factory 300 of 300.
- **Open:** the full list, in order, is "Roadmap: what's next" in `TODO.md`.
