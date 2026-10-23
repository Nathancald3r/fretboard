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
3. **The importer:** `importFiles` → `importPdfParts` → `readParts` (in `js/app.js`).
   - **Each PDF:** `pdfToTab` (`js/pdftab.js`) → `findStaves` + `readStrip` (`js/ugtab.js`).
     - Drums and shaker go through `findDrumStaves` / `readDrumStrip` (`js/ugdrums.js`) instead.
     - A part with no strips becomes sheet music.
   - **Combining the parts:** `ugToAlphaTex(parts[0].strips, { extra: parts.slice(1) })`. Every part is cut or padded to the first part's bar count.

### How the helper captures a track (`save_track` / `PAGES_JS` in `ug_collect.py`)

- **Switch the view first.** Before saving, it sets the player's Settings → Notation to **Tablature** (`notation(pg, "Tablature")`), then puts the user's own choice back afterwards. Settings shows the user's choice as "St. + Tab"; to restore it, pick the option "Standard + Tablature".
  - Why: in "Standard + Tablature" the note lengths exist only in the music staff, so the tab has no rhythm stems. Every note then reads as a quarter note, and the time signature comes out wrong (13/4 was seen).
- **Take two pictures every time:** one at the top and one scrolled to the end. `PAGES_JS` matches the two by their ink-per-row profile and joins them.
  - The canvas (`#xtz_canvas`) is viewport-sized and sticky, so one picture never covers a long song.
  - Never skip the second picture on a "looks complete" check: the song can end in the gap between two lines.
- **Wait for a steady picture:** `steady()` takes pictures until two in a row agree.

### Reading the tab, and the traps already hit (keep these)

- **Song length:** every part must read the same number of bars as the song (Here I Am To Worship: 85).
  - To check, read each part with `pdfToTab` and compare `bars`.
  - To find where a part gains or loses a bar, compare the bars read per line with the bar numbers printed at the start of each line.
- **`findStaves`:**
  - **Line detection:** a staff line covers 45% of the page width, *or* is one unbroken run of 15% of it. A one-bar last line is short, and missing it lost a bar.
  - **Thick bands are not staff lines.** A band more than twice the median line thickness (a beam, a block of words) is dropped. It shifted a staff a string down.
  - **Seven equally spaced lines** means a six-line staff plus a stray line. Keep the six whose gaps fit best.
  - **A five-line run is a music staff:** skip all of it. Don't step one line on, or its last four lines read as a bass staff (that gave 275 bars).
  - **All of a staff's lines start at the same x.** A beam over a music staff starts after the clef.
- **`pdftab.js` `tabSize`:** keep only staves whose line spacing is within 20% of the page's median. A music staff with a ledger line or beam can pass as tab.
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

## Where we left off (2026-10-22)

- Commits `ad7a620`, `cf606de` and `12f34f7` are pushed. Official UG songs now import with every part in sync and exact guitar rhythms.
- Here I Am To Worship (8 parts) reads 85 bars in every part, 4/4 at ♩=76.
- For the user to get it: restart the helper (Start UG helper), re-save the song with Replace, then import the new PDFs.
