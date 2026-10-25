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

## UG PDF songs as .gp (2026-10-24)

The user asked: "import the PDF-only UG songs through Fretboard, save each as .gp, add them to songs.json, find their official audio, and score them."

- **Usable folders** in `C:\Users\natha\Downloads\UG Songs` (PDF parts, no .gp yet): **Be My Escape** (Relient K), **Champion** (Bethel Music, Key Bb), **How Great Is Our God** (Chris Tomlin, Key C#), **Trust In God** (Elevation Worship, Key C).
- **Not usable:** Candlelight (only .txt tabs), Champion (Maverick City), Rest On Us and Sun Come Down (chords only, no notes). "When I Go Down Power" duplicates a song that already has a .gp. Here I Am To Worship, How He Loves and When I Go Down already have .gp files.
- **Converter: done** (`ug_to_gp.py` → `render.js ugFolderToGp`, Fretboard's own PDF importer + alphaTab's Gp7Exporter → `cache/ug/Artist - Title.gp`).
  - It reads the files listed in the helper's `fretboard-run.json` (the latest capture). A folder captured twice also holds old files, e.g. Be My Escape's old `Drums.pdf` (one squeezed low-res picture, 77 bars) beside the new `Drums (2).pdf`.
  - **Bar-count guard:** the song's length is the bar count most parts agree on. A part that read more or fewer bars is left out of the .gp and printed as `WRONG BAR COUNT` (`--keep-off` keeps it).
  - Drum reader fixes (pushed in `80869d9`): a one-bar last line is found, and a multi-bar rest's wide "4" is read. Be My Escape drums 77 → 103 of 103, Trust In God 175 → 181, How Great Is Our God 185 → 188.
  - **Still left out** (2026-10-24): 10000 Reasons Piano 77/78 and Tambourine 76/78; Champion Piano 59, Synth Pad 60, Drums 206, Shaker 163 of 207; How Great Is Our God Bass 185/188; Stupid Deep Finger Snap 49/54 (Hand Clap unread); Trust In God Piano 73, Tambourines 159, Shaker 158 of 181. Piano and pad (sheet music) and one-line percussion are the weak readers.
- **Hand run on 4 official songs (2026-10-24): 0 of 4 sync with one steady tempo** (`out/sync4.log`, `qa.json` FAIL for all that have one).
  - **Champion:** 75% of notes within 30 ms, but the whole song is −420 ms off; drifts in bars 21–24, 93–108, 133–140, 157–192; 22 stretches half a beat out.
  - **Trust In God:** 43% within 30 ms; drifts in bars 1–4, 33–36, 73–88, 169–181.
  - **Here I Am To Worship:** no official audio matches the tab (4:28). The fan upload used has 9 s more at the start. 57% within 30 ms; drifts in bars 5–16, 53–56, 77–84.
  - **How Great Is Our God:** no upload matches (the "0–10 s chords differ" on all; the "(Audio)" one is 6 s longer at 10–20 s). 75% within 30 ms, whole song −1 ms, but bars 5–40 and 185–188 drift (a free intro or a bar more/less in the tab).
  - **Why:** live-feel worship recordings change speed, and two of the tabs are not cut to the official recording. One steady tempo can't line these up; only Be My Escape (LISTEN) comes close.
- **One tempo per section (the user asked, 2026-10-24).** When one tempo drifts, `syncqa` tries one tempo per tab section (`section_tempo`, at the tab's Intro/Verse/Chorus marks, cut to 16 bars at most, each within 6% of the average; `--one` turns it off). It is kept only when the drift goes down **and** the note starts don't get worse. `qa.py` allows a tempo change of up to 12% where a section starts.
  - **The line-up now picks the eighth note by harmony** (`locate`). The note starts line up just as well an eighth note either way in a strummed song: Champion's one-tempo line looked "420 ms off" and half its stretches "half a beat out". That was the note starts locking an eighth off; the harmony match has one clear peak, at 0. `one_tempo`, `steadiness`, `whole song off` and `qa.py` all use it. Self-test: Be My Escape 9 of 9. Its old "listen to bars 35–50" is gone, and it now reads OK on one tempo.
  - **Result: it helps 1 of 4.** Trust In God: notes within 30 ms 40% → 53%, drift 16 → 5 bars (bars 85–88 and the last bar left). Champion, How Great Is Our God and Here I Am To Worship keep one tempo: every section came out at 100 ± 0.4% (those bands play to a click), and the section fit made the note starts worse (Stupid Deep 64% → 47%).
  - **So the drift left is not tempo:** a free intro, a bar more or less in the tab, or the wrong recording (3 of the 4 fail the "match" check). Champion also starts 0.2 s before the video does (bar 1 at −0.205 s, clamped to 0, so "speed jumps at bar 2").
- **Where the tabs differ (2026-10-24, `syncqa.differences`).** Every 2 bars, how far the recording is from the sync (searched over more than a bar either way). The kinds are a bar more/less, a step, an intro, the ending and a spot. `syncqa` prints them and `qa.py` turns a drift they explain into LISTEN (a bar more or less stays FAIL). Self-test still 9 of 9.
  - **No song has a bar more or less.** Every one comes back to 0 after a bad stretch.
  - **Free intro:** How Great Is Our God bars 1–4 (the recording is 1.2 s out), Champion bars 1–2.
  - **Endings held or slowed:** Here I Am To Worship 77–84, How Great 185–186, Be My Escape 95–103.
  - **Spots where the tab's part differs** (1–2 bars, then right again): Champion 145–146 and 189–190, How Great 135–146, Trust In God 87–88, Stupid Deep 45–46.
  - **Steps of 50–90 ms** (How Great 7–42, Here I Am 9–14 and 51–58, Champion 93–200): the sound says the recording is early there, but moving those bars made the note starts line up worse (How Great 72% → 66%). So they are probably the measure, not the sync; listen.
  - **Still unexplained:** Champion 129–140, 149–152 and 165–168; Trust In God 1–4; Stupid Deep 1–4 and 37–44. All are a third to half a beat out, where the note starts can't tell one eighth note from the next.
  - **Gate now:** How Great Is Our God fails only on "match" (its intro and the recording's 6 s longer 10–20 s); Trust In God and Here I Am are down to bars 1–4 / 5–8.
- **Free intro allowed (2026-10-24):** `qa.free_intro` makes a failed "match" a LISTEN when every failing stretch is in the tab's first 20 s (other chords, or the band up to 10 s longer), the key is the same and nothing is left over at the ends. How Great Is Our God now gets LISTEN (was FAIL); the self-test on it is 9 of 9. Trust In God, Stupid Deep and Be My Escape still FAIL on drift (steady).
- **Next:** check by ear whether the 50–90 ms steps are real (How Great bars 7–42). Then build one command from a UG link (helper `--no-ui` → `ug_to_gp` → `songdb scan/find/verify --official` → `listen --export`). An agent review (2026-10-24) agreed on this order.

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

**The quality gate (2026-10-24, night): `qa.py`.** One verdict per exported song, so the workflow can run on its own. `listen.py --export` prints it and saves `qa.json` beside the song.
- **PASS**: ship it. **LISTEN**: passes, but a person should hear the bars it names. **FAIL**: don't ship.
- The checks: the whole-song match, sync points for every bar inside the recording, no bar-to-bar speed jump over 1 %, the whole song within 15 ms *and* clearly locked (lag-0 line-up 0.08 over the average shift), no drifting 4-bar stretch.
- **Proven:** `qa.py --selftest` breaks each good song nine ways: moved 30 ms, moved 60 ms, half a beat, 1 % fast, a bar lost, one bar jumping, the wrong recording, and the tab a bar short with a steady sync. Every break must fail and the song as made must pass. Be My Escape: 9 of 9 right.
- Now: Be My Escape LISTEN (bars 37–40, 93–96, 101–103); Stupid Deep FAIL (drifts); Trust In God and Champion FAIL (old bar-fitted syncs, never redone).
- Add a good song to the self-test whenever one passes: more songs make the limits more trustworthy.

**Next, after the user confirms:**
1. Commit and push.
2. Build the APK if the user wants it on the phone.
3. Redo Trust In God (`syncqa.py "Trust In God"`) the same way and check its whole_song_off.
4. Later: drop or fix the Beat This! bar list (it should use the tab's sound per bar, like `lag_curve` but per section).

**Steady vs stretched, by ear (2026-10-24, night):** `compare.py NAME` writes both. The user heard Be My Escape: stretched drifts and gets worse, steady is right up to bar 90. After bar 90 the tab's outro is another arrangement than the recording's (tab 14 bars in a 2-bar pattern, recording 20 bars in a 3-bar pattern, same tempo; found by matching each tab bar's chords to each recording bar). No sync fixes that. The user's rule: when the lengths differ, don't squeeze them to end together; the tab may end first (or get rests at the end). Be My Escape stays steady.

**synctoolbox key points (2026-10-24, night): no.** `anchors.py` lines the tab's sound up with the recording by synctoolbox (MrMsDTW, chroma + note starts), keeps a key point at each section start and one steady tempo between. Notes within 30 ms, current vs key points: Be My Escape 66 vs 60 %, Trust In God 43 vs 46 %, Stupid Deep 64 vs 53 %, Here I Am To Worship 55 vs 22 %, How Great Is Our God 71 vs 39 %, Champion 75 vs 30 %. Its path wobbles 15-300 ms section to section and sits ~35 ms late; the current one-tempo line-up is within ~5 ms where the tab and recording agree. Songs over 5 min need 25 frames/s (50 took 16-18 GB). Chart: `out/anchors.html`.

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
