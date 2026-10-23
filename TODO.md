# Fretboard: open work (moved out of CLAUDE.md)

## UG helper: a whole official song back to ~30 s (now 54 s)

**Goal (the user's words):** "get the full process down in 30 seconds, there is a bunch of wasted time in the process". No pointless waits, and never at the cost of picture quality or cut words.

**Where it stands:** `b87c4a5` saved Here I Am To Worship (8 tracks + chords) in ~33 s. Of that, `printed_lines` (UG drawing its own print pictures) took ~24.6 s. `108be84` fixed the words and notes cut at each print page's foot, and the doubled lines, but a save now takes **54 s**.

**Last timed run (`108be84`, `prof.py`), 54.1 s in total:**
- `printed_lines` 39.9 s over 12 prints:
  - the 4 untabbed tracks take ~2.1 s each, about as before
  - the fretted tracks, tab view and then Standard + Tab: 4.31, 2.86, 2.21, 3.7, **9.59**, 4.04 and 2.51 s
- `write_pdf` 23.8 s, written in the background: 1.2 s each for the untabbed tracks; 4.87, 2.74, **8.41** and 2.82 s for the fretted ones
- The run ends with an 8.41 s PDF write and a 2.82 s one *after* the last print, so ~4 s of tail isn't hidden behind the next track.

**What changed in `108be84` that can cost time:**
1. `PRINT_H` 6000 (was 1000): UG lays out and draws a 12000-px canvas for every print. At 1000 the page-foot cut stays, because nothing is drawn below the page.
2. The `getImageData` hook in `GRAB_JS` makes one extra-tall read per line, so each read covers the line plus up to one more line height. Each read of Print's canvas costs ~0.1 s.
3. `PAGES_JS` `pixels()` counts every pixel of every picture (on top of `mend`), and `repeats()` compares neighbouring pictures. The Standard + Tab pictures are big.

**Plan (measure first, one change at a time, using `%TEMP%\ugp\prof.py`; reload the UG tab with `reload.py` before each run):**
1. A/B one fretted track (Acoustic, both views): `printed_lines` at `PRINT_H` 1000 vs 6000, and at 6000 with the hook on vs off. That shows whether the time is UG's drawing or our hook.
2. Find the smallest height that still works. The canvas must be taller than 10000 px plus one line (try 5300, i.e. 10600 px at 2×), and the result must have no cuts.
3. If the tall screen is the cost, use it only where a cut can happen: the screen just over one page, or only for tracks long enough to need a second page.
4. `write_pdf`: time `PAGES_JS` per part. Count pixels every 2nd column, read each picture's pixels once (shared by `mend`, `inked` and `repeats`), and skip `repeats` when the two pictures' row counts can't match.
5. Take the longest track's prints earlier, so its PDF write overlaps the other prints instead of trailing at the end.
6. Check whether the Standard + Tab print is needed for every fretted track (Fretboard reads only the dynamics and words from it). If a track has none, skip it.

**Done when:** a full save of Here I Am To Worship takes ~30 s, every part reads 85 bars, and the PDFs show no cut words or notes and no doubled lines (render with `fitz` and look).

**The rest of the 33 s at `b87c4a5`** (besides the 24.6 s of print): `pick_track` 2.8 s, `notation` 1.7 s, `sharp_screen` 0.9 s, chords 0.8 s. These are small, so the time to win is in the prints and the PDF writes.

**Already tried, don't repeat:**
- Printing tracks in parallel tabs: slower, because UG's drawing is all CPU work.
- Picking tracks by pressing them from page JS (`PRESS_JS`): unreliable, so `pick_track` keeps the locator click.
- Lowering the picture scale: never, it costs quality.
- Print time is all UG CPU work: about 1.1 s of layout plus 0.35 s for `toDataURL` per print. There are no timers or network waits to cut.
- With the Instruments panel open, the score is 1582 px wide (4 bars a line); closed, 2214 px (6 bars). The note pixel scale is the same, but a wider score means fewer, wider pictures. Measure whether closing the panel before printing saves time.

**Watch out:**
- The collector Chrome on 9222 is shared with other sessions. Say when you're using it.
- The preview stalls on page 5 of Rhythm Guitar in `pdfToTab` (old and new PDFs alike). Check the bars another way, or look into that stall.

## Importing the PDFs ("Reading the PDFs" dialog): make it quicker

**What the user saw:** the dialog "Reading the PDFs, 1 of 10: Vocal · page 4 of 4, line 1 of 2" takes a long time. The user wants the whole import quicker. Not measured yet.

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

**Done when:** a full official song (8–10 PDFs) imports in a few seconds per part, and every part still reads the same bars, notes, lyrics and dynamics as before. Compare against the current output before and after.

**Watch out:** run the tests after changing `js/ugtab.js` or `js/pdftab.js`. In the preview, run `pdfToTab` with `{ lyrics: false }` unless lyrics are what you're testing.

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
| Acoustic p4 | 107 | Measured before the rest-line fixes; re-check. 10 pages, about 3 min. |
| Piano p7 | 37 ✗ | Line 3 (bars 28–104) is all multi-bar rests and is lost. `findStaves` finds the staff (ys ≈ 575…651), so the loss is later. Debug `readStrip` on that staff: probably `barLines` (bar lines with ticks or 2 breaks) or `tabSize`. |
| Drums p2 | 56 ✗ | `readDrumStrip` (`js/ugdrums.js`) doesn't read multi-bar rests. Add the empty bar + big number logic that `readStrip` has (`readRestCount`, `bar.rest`). |
| Percussion p1 | 33 ✗ | Same as Drums. |

Other notes:
- `findStaves` has a new rule: two lines 3 or 5 spaces apart, joined by ≥ 3 bar lines, are filled in as a staff. It isn't proven to help yet; remove it if it doesn't.
- The `.gp5` of this song imports its drums as piano (channel 11, program 0). Check the GP5 import's percussion detection.
- When done:
  - Run the tests and push.
  - Tell the user to restart the UG helper.
  - Delete the old When I Go Down card and re-import.
