# Fretboard: open work (moved out of CLAUDE.md)

## Roadmap: what's next (2026-10-27)

Live, editable board: https://claude.ai/artifact/6bKMech8PfTJJwNHbYdVf7 (page `roadmap/board.html`, starting cards `roadmap/board-seed.json`; the cards live in the artifact's database). Wi-Fi OK = nothing to download.

**Next up, in order**
1. Get the PC checked (burning smell, 2026-10-26). No long CPU/GPU runs before that.
2. Ho Hey's start and ending: `python tests/yt2gp5/wavefit.py "Ho Hey"` is done (bar 1 at 2.467 s, intro 98.2%, the band slows ~3% in the last 9 s, gate FAIL only on bars 37-40). The user heard the first version perfect up to bar 47; the ending fix is new. Next: the user imports `tests/yt2gp5/out/listen/The_Lumineers_-_Ho_Hey_official/Ho_Hey.fretboard` with "Replace it", listens, and fine-tunes in `python tools/aligner.py "Ho Hey"` if needed. Then run wavefit on the other ladder songs. Light CPU, Wi-Fi OK.
3. Sync ladder stage 1: 10 of 12 songs PASS, guitar only (`python tests/yt2gp5/ladder.py --tracks guitar`). Heavy CPU, Wi-Fi OK.
4. Plain hands-off docs before 2026-11-04: one page per job (song from a link, UG helper, APK, data factory), each with its one command and what PASS / FAIL means.
5. **Phone → computer → phone** (the user, 2026-10-27: no APK on the phone until sync is consistent). Built: the phone's "Ask my computer" placeholder (`js/wanted.js`) and `node scripts/songworker.mjs` (a second sync device; only a QA PASS is delivered, else a reason on the placeholder). Next: the user puts the sync repo + token in `%USERPROFILE%\.fretboard\sync.json`; run `--dry`, then one real song; calibrate the gate by ear (Viva La Vida bars 1-8); a scheduled task once the PC is checked; then `node scripts/apk.mjs --no-bump` (1.53 is built).

**Avenues (pick from these after)**
- Sync: stage 2 guitar+bass; stage 3 guitar+bass+drums; longer songs (needs downloads, home net); Battle Belongs drift (section tempo only where proven); Be My Escape / Stupid Deep: user listens, then commit; the wave overlay aligner is built (`python tools/aligner.py "Ho Hey"`, see CLAUDE.md): next, use it on Ho Hey bars 1-16 by ear and save.
- Import: When I Go Down (piano line 3, drums/percussion multi-bar rests); Here I Am To Worship wrong chords; Trust In God leftovers; UG workflow steps 4 (review) and 6 (auto checks); quicker PDF reading (cheap test before each dynamics read).
- Songbook: live mode with page turns; chord chart as a laid-out PDF; "Open in app" on the helper's Done window; check shares in MusicStand, OnSong, SongbookPro.
- Practice tab phase 1 (below): clean-speed loop first.
- App: install APK 1.52 on the phone; banjo tuning; instrument load time (measured 2026-10-27: a 6-track song is ready ~16 s after it opens, of which the 40 MB soundfont download is ~0.15 s locally, so the wait is the synth preparing the instruments; "Loading instruments" line and queued Play are done; per-track loading only if still too slow).
- TabMaker: train on the 300 factory examples, on free Colab (T4) so the PC stays cool (needs home net).

## YouTube → GP5 (Colab notebook + test loop, 2026-10-24)

The plan, the file list, where it stands and the next steps are all in `tests/yt2gp5/PLAN.md`. Start there.

## Practice tab: guitar skills first (the user's plan, 2026-10-25)

Research with sources: `practice-research.md` in the session notes (summary here). What works: fix the exact hard spot slowly until it stays right, timing feedback, spaced review. Skip streaks, XP, video libraries, whole-song scores.

**Phase 1: guitar hands (build first).** All checked by the phone's mic (pitch + onset detection in the browser).
1. **Clean-speed loop:** pick bars in any song; it loops them, +5% tempo after 3 clean passes, -5% after a miss. Shows the best clean tempo per spot.
2. **Strum timing:** a click (any time signature) and the mic marks each strum early/late in ms; worship strum patterns (down, down-up, 16ths, 6/8).
3. **Scales and shapes:** major/minor pentatonic, major scale, CAGED chord shapes drawn on the neck; played up and down with a click, tempo rises as it gets clean.
4. **Chord changes:** two chords, count clean changes per minute (G-C, D-G, Em-C...), from the songs you play.
5. **Fret notes:** "play C on string 5"; the mic checks it; misses come back sooner (spaced repetition); a heat map of weak frets.
6. **Daily 30 min:** timing 5, scale 5, chord changes 5, fret notes 5, hard spots from your songs 10. A log of clean tempos, changes per minute and fret-note accuracy, a weekly chart.

**Phase 2: later.** Ear training (name the 1-7 note or chord in a key), theory on the neck (why 1-4-5-6m works in every key, the number system), tab and sheet-music reading drills, memorising worship sets (form outline, chart that fades, recall before Sunday), levels with a weekly self-test.

## The UG workflow: search, pick, save in the background, review, import (the user's plan, 2026-10-23)

**The user's answers:** skip the review when the automatic checks pass; the recording for syncing is YouTube (UG's linked video); build setup + queue + background first.

**Done (2026-10-23): parts 2, 3 and 5's queue side.** The collector reports each file's state to the helper (`/report`); the helper keeps the songs (`/status` `songs`, version 5), queued tabs, and Fretboard's `/retry` (`--only --out --yes --add`, `--shots` for "Try another way") and `/drop` (one track: its PDF deleted and `dropped` in `fretboard-run.json`; the whole song: `cancel.flag` while it saves, else only its files and the empty folder). A song with a file not saved is **held** (`missing` in its manifest; reloaded when the helper starts) and isn't auto-imported until each file is retried or left out. Fretboard's **UG downloads** panel (`showQueue`, folds to one line) and the **Added** dialog with Open song (`showAdded`). **Not tested on real UG yet:** a real retry run and a Cancel song mid-save. **Still to do:** 1 (setup prompts), 4 (review), 6 (checks), notices for cut lyrics / stretched sheets, closing the helper when the queue is empty.

1. **One-time setup:** Fretboard asks to turn on auto-import from a folder (it makes one, or you pick one), then offers the UG helper and explains it: Official songs (UG Pro) give one PDF per track from the version you picked; Pro / Guitar Pro give the .gp file; chords, tab, bass, ukulele and drum tabs give one file each. **The helper runs hidden**, no command prompt in front.
2. **Pick songs:** search from Fretboard, the helper's Chrome comes to the front to pick the version, then you're back in the app. Several songs can be queued while you keep using the app. One song at a time, at a person's pace (nothing hidden: no bot-hiding).
3. **Save in the background:** a folder per song, a status per file. A bad file never stops the others; it waits for you: Retry, Try another method, Cancel. A song moves on only when all its files are settled; finished songs don't wait for it. Cancel one file, several, or the whole song (only those files / the folder are deleted). Problems it can't fix (cut lyrics, stretched sheets) are notified. When done, it closes the windows it opened and the helper when nothing is left.
4. **Review (Official only):** opens only when a check flags something (any song's review can still be opened). The PDFs zoomable, two tracks side by side, quick track switching; per track Retry / Try another method / Cancel, each saving a diagnostic report.
5. **Import:** reviewed songs import by themselves. Success: a dialog with the song's name and details and **Open song**. Problems: to the import status.
6. **Automatic checks** on the PDFs and the conversion: same bar count in every track, nothing cut or stretched, time signature and tempo agree.
7. **Sync to a recording (separate test project, later):** find the right YouTube version, line up the start, match tempo, time signature and sections; if the arrangement differs, adapt (add rests, skip parts). Test and improve on its own first.

## Trust In God fixes (the user's Notion list, 2026-10-23): what's left

The song: official UG, Elevation Worship, key C, 181 bars. Its PDFs are in `%USERPROFILE%\Downloads\UG Songs\Trust In God - Elevation Worship (Key C)\`.
Done (`ec69318`): piano ties (also over the bar line and into a line), triplets (long "⌐3¬" and short "(3)" brackets), bracketed notes held, the bridge's fake sharps (a "(" read as a flat), lyrics, LG3 bar 135, section labels, count-in, the Outro slowdown, the helper's tray Quit.

1. **Roman numerals:** the key part is done (`40ea297`). The spelling waits for the user's examples.
2. **Dynamics p, f, mf:** done. Read from the sheet music under each staff (`scoreDynamics`). Still missed: a mark printed on top of a lyric word (the f under mp at bars 24, 26, 34, 47, 85).
3. **Lyrics, helper capture bug:** the Vocal PDF's words at bars 141–143 are cut in the PDF itself (only the letter tops), though it was saved after the cut-words fix (`108be84`). Fretboard borrows those words from another part. Test the helper's capture on this song with the collector Chrome running.
4. **alphaTab draws a 4-note triplet as two "3"s** (16+8, 8+16): it plays right but looks different from UG's one bracket.

## Chord charts as a songbook: columns, ChordPro in and out, live mode, Roman numerals fix (the user's plan, 2026-10-23, partly done)

**The goal:** chord charts that feel like Planning Center Music Stand when playing live, with the range of SongbookPro, and files that open cleanly in SongbookPro, OnSong and Music Stand.

**Where things are now (context):**
- A chord sheet is a song with `kind: 'text'` (IndexedDB `songs`, `js/db.js`); its text is `song.data`. It opens in the text view (`js/texttab.js`: `openText`, `render`, `initText`; markup in `index.html` under `#tx-…`, styles `.tx-…` in `styles.css`).
- **The sheet's head:** the UG helper writes a header (title, `Key:`, `Capo:`, `Tuning:`, `From: <UG url>`); `sheetHead()` reads it. `song.strum` holds the strumming patterns (`{ part, bpm, per, triplet, strokes }`, UG codes 1 down, 101 up, 3/103 accented, 2/102 muted, 0 none), `song.recording` the video.
- **What a song remembers:** `song.transpose`, `song.chordMode` (`letters` / `nashville` / `roman`), `song.key` (the key for numbers, or `auto`), `song.textSize`, `song.scrollSpeed`, `song.tempo`.
- **Chord names:**
  - `highlight(text, rename)` draws chord lines and keeps each chord in its column.
  - `toNashville` / `toRoman` are in `js/theory.js`, `shiftChordName` in `js/transpose.js`, and `detectKey` guesses the key from the chords.
- **Other pieces:**
  - Perform mode (`setPerform`, `body.performing`) is the existing "just the song, big" view.
  - The strum player is `js/strumplay.js` (its own hidden alphaTab player, looping).
  - Imports start in `importFiles` (`js/app.js`); the file input's `accept` list is in `index.html` (`#file-input`).
  - Auto-import from the Downloads folder is `js/quickimport.js`.
- **The UG helper's Done window** is drawn by `tools/ug_collect.py` (tkinter, "UG song collector"). The helper (`tools/ug_watch.py`, 127.0.0.1:9231) already talks to Fretboard (`/status`, `/report`, `/retry`, `/drop`). A fix reaches the user only after a push and a restart of the helper.
- Rules that apply:
  - Check the exports in the real apps, not just by eye.
  - Guitar sound comes first.
  - Line endings: `texttab.js` and `app.js` are CRLF; `theory.js`, `strumplay.js` and `index.html` are LF.

1. **Fix the Roman numerals (and Nashville numbers) — the user asked for this later.** What's known wrong:
   - **The key is guessed from the chords, not taken from the page.** A sheet of G, C/G and Em7 was guessed as C, so G showed as V instead of I. Fix:
     - Use the head's `Key:` minus its `Capo:`: the shapes' key, since the numbers are written over the shapes.
     - Fall back to `detectKey` only when there's no key line.
     - Weigh the first and last chord more, and slash chords by their top chord.
   - **Show which key the numbers count from** next to them, e.g. "Roman in G".
   - **Done 2026-10-23:** the key comes from `Key:` minus `Capo:` (`shapesKey` in `js/theory.js`), the Key menu says "Auto (G, from the page)", and a chip shows "Roman in G". Still to do: the spelling questions below, after the user says what looked wrong.
   - **Check the spelling** against what worship charts use:
     - minor lower case (vi) and diminished vii°; half-diminished as viiø7 or vii⌀7
     - slash basses: we write `IV/1`; charts may want `IV/I` or plain `IV` over a bass note
     - sus, add9 and maj7 suffixes
     - chords outside the key: bVII, and borrowed iv
     - minor keys: we count from the minor tonic, so C in Am is III; some charts count from the relative major instead
   - Ask the user what looked wrong before changing the spelling.
   - Tests are in `tests/theory.test.mjs`.
2. **Two columns: done 2026-10-24 (`a7d07bf`)**, a toggle in the sticky bar, saved per song (`song.columns`), sections never split (`.tx-sec`); phones stay one column. Not done: a section that won't fit moving whole to the next page. The plan was: the chart can split into two columns (a toggle beside Text size, saved per song). Sections never break across columns; a section that won't fit moves whole to the next column or page. Perform mode keeps the choice.
3. **Export: ChordPro done 2026-10-24** (`sheetToChordPro`, `js/sharecore.js`, `2b05e93`): Share sends a song or setlist to MusicStand / OnSong / SongbookPro as ChordPro, tabs and scores as a PDF with the song attached, several as a .zip with Setlist.txt (name, date, each song's key). Not checked yet in the real apps. Not done: a chord chart as a laid-out PDF (columns, text size). The plan was:
   - **ChordPro (.cho / .chordpro), the main one.**
     - Header: `{title}`, `{artist}`, `{key}`, `{capo}`, `{tempo}`, `{time}`.
     - Sections: `{start_of_verse: Verse 1}` … `{end_of_verse}`, and the same for chorus and bridge; other sections as `{comment}`.
     - Chords inline: `[G]As the [C/G]Spirit`.
     - Exports what is shown: transposed chords if transposed. Nashville or Roman only when chosen; the key stays in `{key}`.
   - **PDF:** what the page shows (columns, text size), one song per file, page breaks between sections.
   - **.txt:** chords over lyrics, as UG writes them.
   - Check each file by opening it in SongbookPro, OnSong and Music Stand. Their ChordPro readers differ: OnSong wants `{c:}` comments, Music Stand reads `{key}` and `{tempo}`.
4. **Import: done 2026-10-24 (`56ba75c`)**: ChordPro files and chord-chart PDFs (SongSelect style) come in as chord songs. The plan was:
   - ChordPro files: `.cho`, `.chordpro`, `.chopro`, `.pro`, and `.txt` with `{title}` or inline `[chords]`. Add them to `#file-input`'s `accept` and to `importFiles`.
   - Plain chords-over-lyrics `.txt`: already read as a text tab.
   - PDF chord charts (text PDFs): the chord line above each lyric line, kept by column position.
5. **Live mode for chord charts (Music Stand feel, SongbookPro range):**
   - A set list: songs in order. Turn pages and move to the next song by swipe or pedal (Page Down / arrow keys, Bluetooth page turners).
   - Page-at-a-time view (no scrolling while playing), with half-page turns as an option.
   - Per song: key, capo, transpose, columns, text size, Nashville / Roman, all remembered.
   - Notes and highlights drawn on the chart (kept per song), a metronome flash, the strum pattern on top.
   - Big, high-contrast, dark or light; the screen stays awake.
   - Build on Perform mode and the existing Live mode (`js/livemode.js`) rather than starting over.
6. **UG helper's Done window ("UG song collector"):** add an **Open in app** button beside Open folder and Close.
   - It opens Fretboard (the website, or the Fretboard tab already open) on the song. If auto-import hasn't brought the song in yet, it imports it first, so there's no Import files / select all / Create song step.
   - The helper can tell Fretboard over `ug_watch.py` (a "ready, open it" flag Fretboard picks up on its 4 s check), or open the website with the song's folder in the address.

**Done 2026-10-24 (`a7d07bf`):**
- Hover or tap a chord: its diagram, other shapes (Open, E/A/D shape, `shapesFor` in `js/chordshapes.js`), tap to hear, and "Use this shape". Saved shapes apply to every song (IndexedDB kv `chordShapes`, `"root:type" → frets`).
- "Chord shapes" strip: every chord in the song as a diagram.
- Edit opens a chord sheet as ChordPro (`editorText` / `fromEditor` in `texttab.js`) and saves it back as chords over the words, keeping the head and From link.
- The control bar (auto-scroll, speed, transpose) is sticky; on phones it's one row you swipe.
- ChordPro export for sharing (`sheetToChordPro` in `js/sharecore.js`) came with the sharing work (`2b05e93`).

**Done already (2026-10-23):**
- The strum pattern plays on loop: ▶ Play at the song's tempo, and Slow practice from 60%, +5% every two loops.
- Roman numerals are a Chords option.
- Each track keeps its own capo and key.
- The player's Tuning menu, with its "Not the original key" badge.

## Chord sheet viewer redesign (2026-10-27): what's left

Done: one-row bar, fit to the screen, capo, ChordPro editor, folded repeats (see CLAUDE.md "Chord sheet viewer"). Small gaps:
- Android Back doesn't close the ⋯ menu first (it isn't a layer in `js/layers.js`); a tap outside closes it.
- A chord wider than its word hangs over the plain words after it; when the next word has its own chord, the line gets a small gap instead.
- Not checked on the phone itself (only the preview at 375 wide); the APK is held.
- Floating tools (2026-10-28): the metronome's BPM is only editable in ⋯ (a tap on the tile only starts/stops); notes show on every identical line and aren't in the ChordPro/PDF export; the backing track is Pop style only (the Backing page has more); the quick start can't start the YouTube video (the embed has no play API loaded).

## UG helper: a whole official song in ~30 s (done 2026-10-23, keep for reference)

- **Now:** Here I Am To Worship (8 tracks + chords) saves in **20 s**. The fretted tracks' Standard + Tab prints are off by default: they were the longest (~15 s together), and Fretboard reads only dynamics and words from them.
  - The option: the checkbox "Also save the Standard + Tab pages" on Fretboard's UG helper line (helper `/settings`, saved in `settings.json` beside the helper; `ug_collect.py --notation`).
- The floor is UG drawing its own print pictures (pure CPU work), ~2 s per track.
- **Measured, don't redo:**
  - `PRINT_H` 1000 is ~8 s quicker but brings back the page-foot cuts. 5400 is too short: a Standard + Tab line can be 1770 px tall, so the canvas needs 10000 + 1770.
  - Print time grows with the canvas height, and almost every print spans 2+ pages, so a tall canvas only where needed saves nothing.
  - The `getImageData` hook costs ~1 s at most.
  - Writing the PDFs in the background slows the prints by ~4 s, but writing them afterwards is slower overall.
  - Instruments panel closed: a narrower print with smaller notes. Lower quality: no.
- **Already tried, don't repeat:**
  - Printing tracks in parallel tabs: slower, because UG's drawing is all CPU work.
  - Picking tracks by pressing them from page JS (`PRESS_JS`): unreliable, so `pick_track` keeps the locator click.
  - Lowering the picture scale: never, it costs quality.

## Importing the PDFs ("Reading the PDFs" dialog): make it quicker

**What the user saw:** the dialog "Reading the PDFs, 1 of 10: Vocal · page 4 of 4, line 1 of 2" takes a long time. The user wants the whole import quicker.

**Done (2026-10-23): How He Loves' 10 PDFs now read in 88 s in the preview** (each fretted part took several minutes):
- Tesseract turned each canvas into a PNG with `toBlob`, which Chrome puts off to idle time: **~1 s per read**. It now gets `canvas.toDataURL()` (14 ms). A notation-heavy PDF: 108 s → 16 s.
- `notationMarks` draws each staff's box once (`drawBox`) and cuts every read from it. It used to render the page again for each of its ~240 reads per part (~65 ms each). A fretted part: ~32 s → ~15 s.
- The progress bar moves page by page within each part.
- Results unchanged (bars, dynamics, words) on all of How He Loves' parts.

**Still possible:** ~200 of a fretted part's ~240 reads are dynamics candidates (noteheads, symbols) that never come back as a dynamic; each costs ~50 ms of OCR. A cheaper test before reading them, or reading parts in parallel (below), would cut more.
**Misread section names get through as words:** "Intrelude", "rre-vnorus" (Interlude, Pre-Chorus) are put on notes as text marks. `SECTION` in `notationText` only matches exact names.

**How it works now** (`readParts` in `js/app.js` → `pdfToTab` in `js/pdftab.js`):
- The parts are read **one after another**, each page in turn. Two `pdfToTab` calls at once hang, because they share one Tesseract worker (`js/uglyrics.js`).
- For each page, `renderInk` draws the page at least once. A tab page whose staff size is off is drawn again at the right scale, plus up to two more times (1.01× / 0.99×) when a pale staff line goes missing.
- **Vocals:** every line's words go through Tesseract (`readLyricLine`). That is the step in the screenshot.
- **Fretted parts** also carry "Standard + Tablature" pages after a "Notation" page. `notationMarks` runs Tesseract over each line's music staff, only to find dynamics and words like "let ring". In the preview that took **about 40 s per page**, so a 24-page Acoustic Guitar PDF takes minutes.

**Plan (measure first):**
1. Time each part and each step (render, `findStaves`/`readStrip`, lyrics, `notationMarks`) on Here I Am To Worship's 8 PDFs and When I Go Down's. Log it to the console from `readParts`.
2. **Notation pages:** run Tesseract only where there is ink above the staff that isn't notes (dynamics and words are rare). Or read them in one pass per page instead of per line. Or make reading them an option. This is probably the biggest win.
3. **Read parts in parallel:** give each part its own Tesseract worker (or a small pool), then read 2–4 parts at once. Most of the work is pdf.js drawing and our pixel loops, which can run side by side. Keep an eye on memory on the phone.
4. **Draw each page once:** the helper's PDFs are made from known print pictures (1582 px wide, fixed staff size), so the right scale can come from the PDF's image size instead of a first render. Or read the embedded line pictures straight from the PDF (pdf.js operator list) and skip drawing the page at all.
5. Move the pixel work (`findStaves`, `readStrip`, `notationMarks`) into a Web Worker so the page stays responsive and parts can overlap.
6. Small one: the dialog's bar looks full at "1 of 10". Check that `progress.max` is set to the number of parts.

7. **Bug: the dialog froze at "1 of 10: Vocal · page 4 of 4, line 1 of 2"**, and songs still seemed to be added in the background. Not reproduced yet. Likely causes:
   - **Two imports running at once** (e.g. the UG helper's auto-import plus one the user started, or the same files imported twice). Both share the one Tesseract worker in `js/uglyrics.js`, and two `pdfToTab` calls at once are already known to hang. The songs "added in the background" would be the other import.
   - **A Tesseract `recognize` that never returns:** `readLyricLine` has no timeout. "line 1 of 2" is shown after line 1, so it was stuck on line 2's words.
   - **To fix:**
     - allow one import at a time (queue the next one, or say "an import is already running")
     - give `recognize` a timeout: drop that line's words, restart the worker, carry on
     - make Cancel stop it even mid-`recognize`
     - log which step each part is on
   - **Done when:** importing the same 10 PDFs twice in a row (and while the helper auto-imports) never freezes, and Cancel always works.
8. **Bug: Cancel doesn't stop the import properly** (the user pressed it on the frozen dialog above).
   - Now `say()` throws `Cancelled` only when the next progress message comes. A part stuck inside `pdfToTab` (in `recognize`, `page.render` or a pixel loop) never gets there, so Cancel does nothing.
   - **Fix:**
     - Close the dialog at once and mark the import cancelled.
     - Make every `await` in `pdfToTab` and `readLyricLine` check the flag.
     - Terminate the Tesseract worker (`closeLyricReader`) and destroy the pdf.js document, so the stuck work ends.
     - Make sure nothing from a cancelled import is added later, and that the next import starts clean.
   - **Done when:** Cancel at any moment closes the dialog within a second, adds nothing, and a new import right after works.

**Done when:** a full official song (8–10 PDFs) imports in a few seconds per part, and every part still reads the same bars, notes, lyrics and dynamics as before. Compare against the current output before and after.

**Watch out:** run the tests after changing `js/ugtab.js` or `js/pdftab.js`. In the preview, run `pdfToTab` with `{ lyrics: false }` unless lyrics are what you're testing.

## Bug: How He Loves Us plays out of sync (fixed 2026-10-23, keep for reference)

**Fixed:** 9 parts read 116 bars and Drums 117, not 128, and the tempo read 261.
- `findStaves`: the foot of the 8-bar intro rest's thick bar counted as a 7th staff line, so the first line (bars 1–12) was lost. A short line much closer than a staff space to another is now dropped.
- Drums: multi-bar rests are read (`restBar` + `readRestCount`), and a rest bar lying on the middle line no longer hides that line (the last line, bars 125–128, was lost).
- Tempo: digits are read with the rest-count reader (UG's own shapes) and the parts vote. The system-font match read 75 as 26 and When I Go Down's 68 as 66.
- Checked: all 10 tracks 128 bars, every bar adds up, tempo 75; Here I Am To Worship still 85 in every part.

**What the user saw:** in the imported How He Loves Us, some instruments come in early and others late. The tracks don't line up.

**Likely cause:** one or more parts read a different number of bars, or a bar of the wrong length, so everything after that point shifts. `ugToAlphaTex` cuts or pads every part to the first part's bar count, so a part that gains or loses a bar early stays shifted from there on.

**Plan:**
1. Get the song's PDFs again with the UG helper (or from the user's last save folder). Note the song's real bar count from the last bar number printed.
2. Read each part with `pdfToTab` in the preview (`{ lyrics: false }`, one at a time) and compare `bars` with the real count.
3. For each part that is off, compare the bars read per line with the bar numbers printed at the start of each line to find the line that gains or loses a bar. Then look at that line (render it with `fitz`) and fix the reader (`findStaves`, `barLines`, multi-bar rests, pickup bar...).
4. Also check the bar *lengths*: in `window.fretboardPlayer.api.score`, each track's bar beats must add up to `masterBars[i].calculateDuration()`. A wrong time signature, or a guessed note that rings too long, also makes parts drift.
5. Check the pickup (anacrusis) bar and repeats: a part that starts with a short bar or a repeat sign can line up differently from the others.

**Done when:** every part reads the song's bar count, every bar adds up, and playing it, all instruments come in together. Run the tests, and check Here I Am To Worship still reads 85 bars in every part.

## Bug: songs in the ☰ library didn't open (fixed 2026-10-24, keep for reference)

- **What the user saw:** tapping a song in the library left the song that was already open.
- **Why:** closing the drawer ran `history.back()` to drop the drawer's history entry (`js/layers.js`), and that Back undid the tap's move to `#song/N`.
- **Fix (`92facfb`):** the Back is skipped when the address changed since the layer opened, checked one tick later. Android Back and × still close the drawer. In Android 1.48.
- If a song still won't open: reload first (an open page keeps the old code), then check that song itself (a different cause).

## Bug: wrong chords and bad sound on imported songs (to fix later)

**What the user saw (screenshot, Here I Am To Worship, song 40, Verse 2 and Chorus):**
- Chord names don't match what's sung. Example: the sheet shows Esus4/B, E7, Bsus4 in Verse 2 and the player shows different chords on the same bars.
- The chords and the playback sound wrong. Guitar sound is top priority, so this is the most important part of the fix.
- Vocal timing is off: the sung words don't line up with the notes and the lyric bar.

**Likely causes (check these first):**
- `js/chordsheet.js` `sheetChords` matches the chord sheet to the sung words. A wrong match in a repeated section (chorus, verse 2) puts chords on the wrong bars.
- `prepareChords` in `js/player.js` replaces the song's chords with the sheet's chords. If the match is poor, the sheet chords are worse than the guessed chords. Consider falling back to the guessed chords when the match quality is low.
- The Tab's chord voicings and the sheet chord names may not agree (Esus2/F# vs Esus4/B). Check the transposition/capo and the key.
- Vocal timing: `sungWords` / `buildLyrics` ticks, and the bar start times from `barSpans`. Check the bar offset for songs with a count-in or a repeat.

**Plan (use few tokens):**
1. Reproduce on song 40 in the web preview (`#song/40`). Note the bars where chords go wrong.
2. Add a test in `tests/chordsheet.test.mjs` for the Verse 2 / Chorus bars from that screenshot. Expected: bar 18 Esus4/B, bar 19 E7, bar 20 Esus2/F#, bar 21 E7, bar 22 Asus2, bar 23 E7, and so on, as shown on the sheet.
3. Fix the matching for repeated sections (use the section label, e.g. "Chorus", when it's there).
4. If the match is weak, keep the song's own chords instead of the sheet's.
5. Fix the lyric timing: compare the sung-word ticks with the bar starts and correct the offset.
6. Listen check on guitar sound (guitar sound is top priority), then run `node tests/*.test.mjs`.
7. Test on web, then bump the Android version, build, install, and send the APK (under 30 MB).

**Done when:** the chords on song 40 match the sheet, the vocal lines up with the lyric bar, and the guitar sounds right.

## When I Go Down - Relient K: finish the PDF import (official UG song, 7 parts, 114 bars)

The PDFs are in `%USERPROFILE%\Downloads\UG Songs\When I Go Down - Relient K\`. Copy them into a temporary `_ug5/` folder to test, and delete it before committing.

Mapping:
- p1 Background Percussion
- p2 Drums
- p3 Bass
- p4 Acoustic
- p5 Electric (Matt Hoopes)
- p6 Electric (Matt Theissen)
- p7 Piano

Bars read per part with `pdfToTab` (lyrics off):

| Part | Bars | Note |
|---|---|---|
| Electric p5, Electric p6, Bass p3 | 114 ✓ | |
| Acoustic p4 | 114 ✓ | (2026-10-23) |
| Piano p7 | 37 ✗ | Line 3 (bars 28–104) is all multi-bar rests and is lost. `findStaves` finds the staff (ys ≈ 575…651), so the loss is later. Debug `readStrip` on that staff: probably `barLines` (bar lines with ticks or 2 breaks) or `tabSize`. |
| Drums p2 | 71 ✗ | Multi-bar rests on a five-line staff are read now (was 56). Find which lines still lose bars. |
| Percussion p1 | 33 ✗ | One-line staff: `restBar` in `js/ugdrums.js` skips one-line staves. Look at how its multi-bar rests are drawn. |

Other notes:
- `findStaves` has a new rule: two lines 3 or 5 spaces apart, joined by ≥ 3 bar lines, are filled in as a staff. It isn't proven to help yet; remove it if it doesn't.
- The `.gp5`'s drums: fixed 2026-10-23 (`394af4a`), they play. The `.ptb` of this song imports whole (114 bars, 7 tracks, `dba3976`).
- When done:
  - Run the tests and push.
  - Tell the user to restart the UG helper.
  - Delete the old When I Go Down card and re-import.

## Sync ladder: where it stopped (2026-10-26)
- 12 songs in `tests/yt2gp5/ladder.json`, all official studio audio / lyric videos; their recordings are already downloaded (cache/real), so public Wi-Fi is fine.
- Fake-recording test (`synctest.py`): 5 of 5 right (every bar within 17 ms).
- **Ho Hey starts ~0.9 s late** (user heard ~1 s). The intro runs ~2 % slower than the rest; one steady tempo fits the whole song and gives up bars 1-16. The music-video run measured per 4 bars: -0.85, -0.76, -0.39, -0.28, then 0 from bar 17. Stomps/shouts put bar 1 at ~0.72 s.
- `fix_start` in `syncqa.py` moves the first bars, but its check rejects it: onset match over bars 1-16 drops 0.034 → -0.079 while the harmony says -0.85 s. Next: find out which is right (listen; check the drum stem), then rerun Ho Hey on the new studio link (SuZytYa71lk).
- **Rerun on the studio link (SuZytYa71lk, 2026-10-27): FAIL, exit 3.** All 8 UG tracks saved, 51 bars. Mandolin read 45 of 51 bars (left out), Hand Clap skipped. One steady tempo puts bar 1 at 1.010 s, notes within 30 ms 41%, and the sync's own check says the whole song is -1 ms off. But `qa.py`'s lock says +488 ms and the tab barely lines up (-0.12, needs 0.08). Bars 1-10 read -767 ms (free intro or count-in); bars 9-16 are half a beat out. The two checks disagree, so the user listens to bars 1-16 first. File: `tests/yt2gp5/out/listen/The_Lumineers_-_Ho_Hey_official/Ho_Hey.fretboard`, report `sync_report.html` beside it.
- **Wave fitter (2026-10-27):** `tests/yt2gp5/wavefit.py` lines the tab up with the video by note starts (self-test 10 of 10, ≤ 7.4 ms). On Ho Hey it moved bar 1 from 3.448 s to 2.467 s and fixed the slow intro; median stretch error 9 ms vs 19 ms. `fix_start` is no longer the way. Remaining Ho Hey gate items: bars 37-40, 49-51 (musical differences).
- Then `python tests/yt2gp5/ladder.py` (12 songs), then `--tracks guitar`, `guitar,bass`, `guitar,bass,drums`.
