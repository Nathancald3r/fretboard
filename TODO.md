# Fretboard: open work (moved out of CLAUDE.md)

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
