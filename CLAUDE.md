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

- **Dev server:** `node server.mjs` serves http://localhost:8420, the user's own copy. `PORT=8421` is the preview.
  - Use preview_start with the `fretboard` entry in `.claude/launch.json`.
  - Never start a second server on 8420: the user may be using it.
- **Tests:** `for f in tests/*.test.mjs; do node "$f" || echo FAIL $f; done` (Git Bash). Run them after any change to `js/ugtab.js`, `js/pdftab.js`, `js/chordsheet.js` or `js/player.js`.
- **Round-trip import test:** `python tests/roundtrip/roundtrip.py` (`-k NAME`, `--keep`, `--verbose`).
  - Draws each song in `tests/roundtrip/songs/` as UG-style tab PDFs (Letter), reads them back with `pdfToTab` and `ugToAlphaTex`, and prints a score per song and check. Exits 1 below the pass mark in `config.json`.
  - Needs Python Playwright with Chromium; no server (it serves itself on a free port). About 6 s.
  - The PDFs are alphaTab's, styled like UG (stems and TAB clef patched in `harness.js`). See `tests/roundtrip/README.md`.
  - Use it to check an importer change: the score should not drop.
- **Website:** GitHub Pages from `Nathancald3r/fretboard`, branch `main`.
  - A push to `main` updates the website **and** the UG helper, which downloads its files from there.
  - The user has approved pushing helper/importer fixes.
- **Android:**
  - Bump `versionCode` and `versionName` in `android/app/build.gradle`.
  - Build with `cd android; ./gradlew --console=plain assembleRelease -q`. The output is `android/app/build/outputs/apk/release/app-release.apk`. The web files are copied into the APK by the `copyWeb` task.
  - Check the APK is under 30 MB, then send it with SendUserFile.

## Line endings: check before every commit

- `js/ugtab.js` is stored with **CRLF** line endings. `tools/ug_collect.py` and most other files use **LF**.
- `sed -i` or a Python rewrite can flip the line endings, and the commit then shows the whole file as changed.
- **Before committing, run `git diff --stat`.** If a small edit shows hundreds of changed lines, restore the original endings first:
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

## Where we left off (2026-10-24)

- Android 1.47 (versionCode 48) is the latest APK (sharing to MusicStand/OnSong). Chord sheet features (`a7d07bf`) are pushed but not in an APK yet.
- Pushed: the Songs page redesign, sharing, the .ptb reader, the mixer preview and instrument picker, drum fixes, the round-trip import test.
- Still open for When I Go Down (PDF import, 114 bars), details in `TODO.md`:
  - piano part line 3 is lost: 37 bars
  - drums and percussion don't read multi-bar rests
