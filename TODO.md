# Fretboard: open work (moved out of CLAUDE.md)

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
3. **Export:**
   - **ChordPro (.cho / .chordpro), the main one.**
     - Header: `{title}`, `{artist}`, `{key}`, `{capo}`, `{tempo}`, `{time}`.
     - Sections: `{start_of_verse: Verse 1}` … `{end_of_verse}`, and the same for chorus and bridge; other sections as `{comment}`.
     - Chords inline: `[G]As the [C/G]Spirit`.
     - Exports what is shown: transposed chords if transposed. Nashville or Roman only when chosen; the key stays in `{key}`.
   - **PDF:** what the page shows (columns, text size), one song per file, page breaks between sections.
   - **.txt:** chords over lyrics, as UG writes them.
   - Check each file by opening it in SongbookPro, OnSong and Music Stand. Their ChordPro readers differ: OnSong wants `{c:}` comments, Music Stand reads `{key}` and `{tempo}`.
4. **Import:**
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
- The `.gp5` of this song imports its drums as piano (channel 11, program 0). Check the GP5 import's percussion detection.
- When done:
  - Run the tests and push.
  - Tell the user to restart the UG helper.
  - Delete the old When I Go Down card and re-import.
