# Fretboard: open work (moved out of CLAUDE.md)

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
