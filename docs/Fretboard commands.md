# Fretboard commands

Run every command in PowerShell 5.1. Project folder: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`

Python for the sync tools: `C:\Users\natha\.fretboard\yt2gp5-venv\Scripts\python.exe`

Prefix for commands run from the project folder:

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star";
```

## Run the app

The web app is plain files. A small Node server shows them in the browser; the same files go to the website and into the APK.

### Your own copy of the app

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node server.mjs
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\server.mjs`
- What it does: Serves the app at http://localhost:8420 from the project files.
- How it fits: The importer, the player and the chord sheet all run from here. Never start a second server on 8420, you may be using it.
- Opens: http://localhost:8420

### Preview copy for checking changes

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; $env:PORT=8421; node server.mjs
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\server.mjs`
- What it does: The same server on port 8421.
- How it fits: Test a change here without touching your own copy. The UG helper accepts pages from 8420, 8421 and GitHub Pages only. Claude's preview uses the "fretboard" entry in .claude\launch.json.
- Opens: http://localhost:8421

### Install the packages

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; npm install
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\package.json`
- What it does: Installs alphaTab 1.8.4 and then builds the patched copy by itself (scripts\vendor.mjs runs afterwards).
- How it fits: Needed once on a new computer. vendor\alphatab\alphaTab.js is generated; never edit it.

## Test and ship

Run the tests, then ship. A push to main updates the website and the UG helper, which downloads its files from there.

### Run every test

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\test.mjs
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\test.mjs`
- What it does: Runs all 35 files in tests\*.test.mjs and prints one line each. Exit 1 if any fails.
- How it fits: Run it after any change to js\ugtab.js, js\pdftab.js, js\chordsheet.js or js\player.js, and before shipping.

### Every test, plus the round-trip import test

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\test.mjs --round
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\test.mjs`
- What it does: The same, then the round-trip import test (about 6 s more).
- How it fits: Use it after an importer change: the round-trip score should not drop.

### Run one test file

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node tests\songmeta.test.mjs
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\songmeta.test.mjs`
- What it does: Runs a single test file. Swap songmeta for any name in the tests folder.
- How it fits: Quicker than the whole set while you work on one part.

### Round-trip import test

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tests\roundtrip\roundtrip.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\roundtrip\roundtrip.py`
- What it does: Draws each song in tests\roundtrip\songs as UG-style tab PDFs, reads them back with the importer and prints a score per song and check. Options: -k NAME, --keep, --verbose.
- How it fits: The importer's safety net. Needs Python Playwright with Chromium; no server needed. Exits 1 below the pass mark in config.json.

### Check before shipping (changes nothing)

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\ship.mjs --check
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\ship.mjs`
- What it does: Looks for flipped line endings and for files that must not be committed (out\, APKs, _xxx folders).
- How it fits: The dry run of the next command.

### Ship: commit named files and push to main

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\ship.mjs -m "message" file1 file2
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\ship.mjs`
- What it does: Fixes flipped line endings, refuses out\, APKs and _xxx folders, commits only the files you name and pushes to main.
- How it fits: A push to main updates the website and the UG helper. Restart the helper to pick up a helper fix.

### See what changed before committing by hand

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; git diff --stat
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- What it does: Lists changed files and line counts.
- How it fits: A small edit that shows hundreds of changed lines means the line endings flipped. ship.mjs fixes that for you.

### Rebuild the patched alphaTab

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\vendor.mjs
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\vendor.mjs`
- What it does: Regenerates vendor\alphatab\alphaTab.js with our sound patches (NaN guard, stereo samples, modulators, volume floor, direct audio channel, second drum channel).
- How it fits: Run it after editing scripts\vendor.mjs. Each patch throws if alphaTab changes, so an upgrade cannot drop one silently. Guitar sound comes first.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\vendor\alphatab\alphaTab.js`

### Set drum sample loudness in the soundfont

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\drum_levels.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\drum_levels.py`
- What it does: Sets how loud single drum samples (ride, hi-hat) play in MuseScore_General.sf3, in place, same file size.
- How it fits: Running it twice changes nothing. Used so the ride and hi-hat do not vanish in a band mix.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\vendor\soundfont\MuseScore_General.sf3`

## Android phone

One script builds the APK, checks it is under 30 MB and installs it on the Pixel 8a over USB. The soundfont is never bundled.

### Build, install on the phone, bump the version

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\apk.mjs
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\apk.mjs`
- What it does: Bumps versionCode and versionName, builds the release APK, checks it is under 30 MB, keeps Fretboard-<version>.apk and installs it on the Pixel 8a, then checks the version.
- How it fits: The last step of a release. APK 1.53 is built and held until sync results are consistent. Afterwards send APK_PATH to the user.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\Fretboard-<version>.apk`

### Rebuild or reinstall the same version

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\apk.mjs --no-bump
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\apk.mjs`
- What it does: Same, without a new version number.
- How it fits: This is the command that puts the held APK 1.53 on the phone.

### Build only, skip the phone

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\apk.mjs --no-install
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\apk.mjs`
- What it does: Builds and size-checks the APK without installing it.
- How it fits: Use it when the phone is not plugged in.

### Which version is on the phone?

```
& "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe" -s 49111JEKB02598 shell dumpsys package app.fretboard | Select-String versionName
```

- Run from: anywhere
- Script: `C:\Users\natha\AppData\Local\Android\Sdk\platform-tools\adb.exe`
- What it does: Asks the phone for the installed versionName.
- How it fits: adb is not on the PATH, and -s is needed because an offline emulator also shows in adb devices.

### Install a built APK by hand

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe" -s 49111JEKB02598 install -r android\app\build\outputs\apk\release\app-release.apk
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\AppData\Local\Android\Sdk\platform-tools\adb.exe`
- What it does: Installs the release APK over USB, keeping app data (-r).
- How it fits: What apk.mjs does for you at its last step.

### Build the release APK by hand

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\android"; ./gradlew --console=plain assembleRelease -q
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\android`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\android\gradlew.bat`
- What it does: Builds android\app\build\outputs\apk\release\app-release.apk. The copyWeb task copies the web files into the APK.
- How it fits: apk.mjs runs this for you. Run it from the android folder.

## Get official tabs (UG helper)

The helper drives its own Chrome window and saves an official Ultimate Guitar song as one PDF per instrument plus Chords.txt. Fretboard converts the PDFs.

### Start the UG helper

```
& "$env:USERPROFILE\Fretboard UG helper\start.cmd"
```

- Run from: anywhere
- Script: `C:\Users\natha\Fretboard UG helper\start.cmd`
- What it does: Downloads the latest helper files from the website, then starts the helper on 127.0.0.1:9231 with its own Chrome (debug port 9222).
- How it fits: Same as the "Start UG helper" shortcut. Fretboard's "Find tabs online" talks to it. A fix reaches you only after a push and a restart of the helper.

### Set up or refresh the helper

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\ug_helper_setup.py --refresh
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\ug_helper_setup.py`
- What it does: Copies ug_watch.py and ug_collect.py from the Fretboard website into the installed helper folder and writes start.cmd.
- How it fits: Start.cmd runs this first. Without --refresh it is the one-time setup (also installs Playwright for Python).
- Writes: `C:\Users\natha\Fretboard UG helper`

### Run the helper from the project folder

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & ".\UG helper.cmd"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\UG helper.cmd`
- What it does: Opens the collector Chrome and links it to Fretboard. Leave the window open.
- How it fits: The development copy of the helper (tools\ug_watch.py). The installed copy above is what you normally use.

### Save one official UG song by hand

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\ug_collect.py "<song url>"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\ug_collect.py`
- What it does: Saves every track of an official song as a PDF into Downloads\UG Songs\<Song> - <Artist> (Key X), plus Chords.txt. Options: --only "Lead Guitar,Piano", --no-ui, --gp.
- How it fits: The helper runs this for you from Fretboard. Collector Chrome must be running with a UG Pro login. Exit 0 done, 1 failed, 2 skipped, 3 cancelled.
- Writes: `C:\Users\natha\Downloads\UG Songs`

### Save a Songsterr song as PDFs

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\songsterr_pdf.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\songsterr_pdf.py`
- What it does: Uses Songsterr's own Print button to save one PDF per track. Needs an account that can print (Songsterr Plus).
- How it fits: Sign in and open the song in the collector Chrome first. Never replaces existing files.
- Writes: `C:\Users\natha\Downloads\Songsterr Songs`

### Turn UG PDFs into .gp files

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tests\yt2gp5\ug_to_gp.py "C:/Users/natha/Downloads/UG Songs" -k "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\ug_to_gp.py`
- What it does: Reads each song folder's part PDFs with Fretboard's own importer and writes Artist - Title.gp. Drop -k to do every folder.
- How it fits: Feeds songdb.py. fromlink.py does this step by itself.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\cache\ug`

## Make a synced song

From a YouTube link to a song whose tab plays in step with that exact video. These live in tests/yt2gp5 and run in the yt2gp5 Python environment.

### YouTube link to synced song, one command

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\fromlink.py "<youtube link>"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\fromlink.py`
- What it does: Finds the official UG tab, saves its PDFs, makes the .gp, adds the song with that exact video, lines it up (one steady tempo, then wavefit) and prints the .fretboard file and the QA verdict. Options: --ug URL, --title, --artist, --again.
- How it fits: The whole pipeline in one step. Exit 0 PASS, 2 LISTEN, 3 FAIL, 1 error. Never run two at once: they share the collector Chrome. Import the result with "Replace it".
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\listen\<song>\`
- Heavy on the PC

### Sync ladder: every song in order

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\ladder.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\ladder.py`
- What it does: Runs fromlink.py for each song in ladder.json, one at a time, simplest first, and writes out\ladder.md (verdict, tempo, notes within 30 ms, why it failed).
- How it fits: The yardstick for the pipeline. Songs are the same twelve every time, so results can be compared across changes.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\ladder.md`
- Heavy on the PC

### Ladder: one song

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\ladder.py -k "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\ladder.py`
- What it does: Only the song whose name contains the text.
- How it fits: Quick re-test of one song after a change.

### Ladder: print the last results

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\ladder.py --table
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\ladder.py`
- What it does: Prints the table from the last results without running anything.
- How it fits: Also: --tracks guitar (guitar,bass; guitar,bass,drums; all) redoes only the line-up on those tracks.

### Listen: tab over its YouTube recording

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\listen.py "Ho Hey" --again
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\listen.py`
- What it does: Plays each tab track with Fretboard's synth, stretches it to follow the recording and opens a page with the recording in the left ear and the tab in the right. Options: --url, --export, --fit, --raw, --no-wavefit.
- How it fits: The by-ear check. fromlink.py calls this; wavefit runs after its one-tempo fit.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\listen\<song>\`
- Heavy on the PC

### Write only the .fretboard file

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\listen.py "Ho Hey" --export
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\listen.py`
- What it does: One steady tempo and the right start, then wavefit, then the gate. No listening page.
- How it fits: The quick way to get a song file for import.

### Song list: add Guitar Pro files

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\songdb.py scan tests\yt2gp5\cache\ug --official
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\songdb.py`
- What it does: Adds every Guitar Pro file found in the folder to songs.json. Also: find (suggest a video for each song), set NAME URL, report, verify.
- How it fits: songs.json pairs each tab with its recording; the sync tools read it. verify downloads the suggestions in your order (official audio first) and confirms the first that matches all the way through.

### YouTube search (as JSON)

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\ytfind.py "Artist Title official" -n 10
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\ytfind.py`
- What it does: Prints the matching videos as JSON. Nothing is downloaded.
- How it fits: Used by the song worker, which ranks the list with js\ytsearch.js (the artist's own channel and "official" first, never covers).

## Check and fix sync

Line a tab up with its video, judge the result with the gate (PASS, LISTEN, FAIL), and move bars by eye and ear when it needs a person.

### Fit the sync with the wave fitter

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\wavefit.py "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\wavefit.py`
- What it does: Lines the tab up with the video by note starts, chords and bar lines, plus a search for the right start and a beat-grid try. Writes only when the gate likes the result better and keeps a .before-wavefit backup. About 10 s a song.
- How it fits: Moves only bar start times; the sheet music is untouched. Import the file with "Replace it".
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\listen\<song>\<song>.fretboard`

### Same, but only measure

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\wavefit.py "Ho Hey" --check
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\wavefit.py`
- What it does: Judges and prints; writes nothing.
- How it fits: Use it before trusting a change to wavefit.

### Fitter self-test with fake recordings

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\wavefit.py --selftest
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\wavefit.py`
- What it does: Fake recordings (copy, late 3 s, ±3% speed, noisy) with a known truth.
- How it fits: Must stay 20 of 20 after any change to wavefit.

### Try every way of syncing, keep the best

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\fixsync.py "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\fixsync.py`
- What it does: Tries the file as made, its variants, one tempo, one tempo per section and drum-clock moves, judges each with the gate and keeps the best. --all does every song, --dry only prints.
- How it fits: The older fixer; listen.py and wavefit now cover most of it.

### The gate: verdict for one song

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\qa.py "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\qa.py`
- What it does: PASS, LISTEN or FAIL and why: match, lock, speed jumps, steadiness, drums, points.
- How it fits: Everything that decides what reaches the phone. The song worker delivers only a PASS. --all judges every song in out\listen.

### Gate self-test

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\qa.py --selftest
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\qa.py`
- What it does: Each good song must pass and each of its syncs broken on purpose must fail.
- How it fits: Last result 90 of 90. Run after changing the gate.

### One song two ways, to compare by ear

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\compare.py "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\compare.py`
- What it does: Writes "(steady)" and "(stretched)" .fretboard files beside the song and prints the gate's verdict for both.
- How it fits: Import both and play them with Mine on.

### Key points by synctoolbox

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\anchors.py "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\anchors.py`
- What it does: Key points at each section start with one steady tempo between them.
- How it fits: Tried on 2026-10-24 and beaten by wavefit; kept for comparison.

### Wave aligner: line the video up by eye and ear

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\aligner.py "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\aligner.py`
- What it does: Two waveforms on the tab's time with bar lines and note ticks. Drag to move the video, S saves, ? lists the shortcuts. Options: --port N, --no-open.
- How it fits: The by-hand fix when wavefit cannot. Save writes new syncPoints into the song's .fretboard (first version kept as .before-aligner); import with "Replace it". Needs numpy.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\listen\<song>\`
- Opens: http://127.0.0.1:8433

### Drum clock: how far the beat sits from the sync

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\drumclock.py "Ho Hey"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\drumclock.py`
- What it does: Splits the recording once into drums, bass, other and vocals (Demucs) and measures the beat's offset every 4 bars, to a few ms.
- How it fits: Feeds the gate's drum check. --selftest moves stretches 30, 60 and 90 ms and each must be found.
- Heavy on the PC

### Prove the sync on a known answer

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\synctest.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\synctest.py`
- What it does: The tab's own sound as a "recording", moved and slowed by known amounts; every bar must land within 20 ms.
- How it fits: If this fails, the fault is in the sync, not in the song.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\synctest.json`

## Measure sync

Numbers instead of opinions: a benchmark where the right bar times are known, and a report and dashboard that show whether each change helped.

### Show the improvement table and redraw the dashboard

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\syncreport.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\syncreport.py`
- What it does: Reads stored results (about 2 s) and prints the ladder of steps: plain wavefit, harmony, ending, bars, polish, wide start.
- How it fits: Writes out\truthbench\report.md and tests\yt2gp5\history\dashboard.html. Options: --refresh, --md, --save, --open.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\history\dashboard.html`

### Judge the real songs again

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\syncreport.py --refresh
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\syncreport.py`
- What it does: Runs the gate on each song in out\listen (about 4 s a song) instead of using saved verdicts.
- How it fits: Do it after a wavefit change.

### Save a snapshot to the history

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\syncreport.py --save "what changed"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\syncreport.py`
- What it does: Keeps the numbers, constants and git commit in history\sync-history.json.
- How it fits: Identical numbers are not added twice. Do it after each wavefit change.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\history\sync-history.json`

### Open the dashboard

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\syncreport.py --open
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\syncreport.py`
- What it does: Redraws the dashboard from the history and opens it in the browser.
- How it fits: One page, no scripts, no downloads.

### Truth benchmark: build the cases

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\truthbench.py build --songs 16
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\truthbench.py`
- What it does: Makes cases from AAM songs (real mixes with exact bar times) with different clocks, contents and starting lines. A few minutes, once.
- How it fits: Needs the AAM data from tools\datasets.py. Light CPU: 2 processes, 2 threads each.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\truthbench`

### Truth benchmark: run chosen variants

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\truthbench.py run --variants +bars+harmony+ending
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\truthbench.py`
- What it does: Fits every case with each of wavefit's tries and counts good (within 50 ms), ok (150 ms), bad and declined. About 25 min at 2 jobs.
- How it fits: Options: --split train|val, --by-case. This is how a wavefit change is judged on exact numbers.
- Heavy on the PC

### Truth benchmark: sweep one setting

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\truthbench.py sweep LAMBDA 0.01,0.02,0.04 --split train
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\truthbench.py`
- What it does: Runs the benchmark once per value of a constant.
- How it fits: Tune on train, check on val so overfitting shows.
- Heavy on the PC

### Calibrate the wide start search

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\startcal.py --jobs 2
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\startcal.py`
- What it does: For each case and starting line, the shift wavefit finds and its gain next to the true shift.
- How it fits: Not part of the pipeline. Used to pick START_GAIN and START_MIN.
- Heavy on the PC

## Stems and note checks

Splitting a recording into instruments and checking what the tab says against what is heard. Also the YouTube to Guitar Pro notebook tests.

### Good stems of a recording

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\stems.py "<youtube link>"
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\stems.py`
- What it does: Six stems (drums, bass, vocals, guitar, piano, other) as WAV, plus a listening page where each stem has Solo and Mute. Options: --uvr, --bssw, --page.
- How it fits: htdemucs_ft for drums, bass and vocals; htdemucs_6s for guitar and piano. Open the page through the dev server.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\stems\<song>\`
- Heavy on the PC

### Guitar-notes check

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\notecheck.py -k champion
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\notecheck.py`
- What it does: How many of the official tab's guitar notes basic-pitch hears in the recording, per Demucs model. Options: --models, --cpu 0.6, --gpu 0.85.
- How it fits: Uses the song's own sync, so it needs no chord line-up.
- Heavy on the PC

### Stem model test

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\sepcheck.py --part a
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\sepcheck.py`
- What it does: Today's split against the RoFormer models: part a scores true stems, part b scores real recordings by guitar notes.
- How it fits: Used to pick the separation chain. --page writes listening pages.
- Heavy on the PC

### Score the notebook on real recordings

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\real.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\real.py`
- What it does: Downloads each song's audio, plays the Guitar Pro file once, lines the two up by chords and scores the notebook's code.
- How it fits: Writes out\real\scorecard.md, results.json and a history line.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\out\real\scorecard.md`
- Heavy on the PC

### Score the notebook on synthesised songs

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\run.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\run.py`
- What it does: Plays each Guitar Pro song with Fretboard's soundfont, runs the notebook's own code and scores stems, notes, tempo, bar lines and key.
- How it fits: Writes scorecard.md and flags any score that fell since the last run.
- Heavy on the PC

### Run the notebook's offline cells

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tests\yt2gp5\test_notebook.py tools\colab\youtube_to_gp5.ipynb out\nbtest
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tests\yt2gp5\test_notebook.py`
- What it does: Runs input check, Demucs on CPU, basic-pitch, Guitar Pro writing and zip on made-up audio. Options: --full, --model NAME.
- How it fits: A smoke test before using the notebook on Colab.

### Rebuild the Colab notebook

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; & "$env:USERPROFILE\.fretboard\yt2gp5-venv\Scripts\python.exe" tools\colab\build_notebook.py tools\colab\youtube_to_gp5.ipynb
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\colab\build_notebook.py`
- What it does: Builds youtube_to_gp5.ipynb from the cell sources in the script.
- How it fits: The notebook must also run cheaply on a free Colab T4.
- Writes: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\colab\youtube_to_gp5.ipynb`

## Training data (TabMaker)

Download approved commercial-use datasets, turn them into labelled examples and look at them. Long jobs; they hold themselves to 60% of the CPU.

### Find new dataset candidates

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\datasets.py find
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\datasets.py`
- What it does: Lists candidates in CANDIDATES.md for a person to approve.
- How it fits: Step 1. Nothing is downloaded until you approve.
- Writes: `C:\Users\natha\fretboard-data\CANDIDATES.md`

### Download the approved datasets

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\datasets.py get
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\datasets.py`
- What it does: AAM, Guitar-TECHS, E-GMD and Groove: resumable, checked, with CREDITS.md. --budget GB limits the size.
- How it fits: Speed follows the network type (80% of the line at home, 1 MB/s on a Public network); --net home|public and --cap MBps override.
- Writes: `C:\Users\natha\fretboard-data`
- Heavy on the PC

### Training data: status

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\datasets.py status
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\datasets.py`
- What it does: What is downloaded and what is missing.
- How it fits: Check before starting the factory.

### Make training examples

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\datafactory.py run --aam 20
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\datafactory.py`
- What it does: For each AAM song: Spleeter 5 stems (mono 22 kHz FLAC) plus labels.json (notes per stem, beats, chords). Also Guitar-TECHS clips with string and fret. About 100 s a song on CPU, capped at 7 of 12 cores.
- How it fits: Step 2. Resumable. Makes its own Python 3.10 environment (Spleeter needs 3.11 or older). Options: --from N, --no-gtechs, --gpu.
- Writes: `C:\Users\natha\fretboard-data\factory`
- Heavy on the PC

### Check the labels line up with the stems

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\datafactory.py check --n 5
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\datafactory.py`
- What it does: Shifts the labels over each stem's onsets: lined up means the best shift is 0 ms.
- How it fits: Step 3.

### Rebuild the training index

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\datafactory.py index
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\datafactory.py`
- What it does: Judges older examples and writes train_index.json (hours per instrument). Stems with "use": false are skipped in training.
- How it fits: Step 4.
- Writes: `C:\Users\natha\fretboard-data\factory\train_index.json`

### Look at the examples in a browser

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\factoryview.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\factoryview.py`
- What it does: Progress of the run, and each example: play a stem with tones at the label onsets, waveform, piano roll with beats and chords.
- How it fits: Read-only; can run during a run. Options: --port N, --no-open.
- Opens: http://127.0.0.1:8432

## Autopilot and phone worker

Things that run while you are away: Claude working through a task list, and the worker that fetches songs you ask for on the phone.

### Autopilot: do the next open task

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\autopilot.py
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\autopilot.py`
- What it does: Runs Claude headless on the next open task in autopilot\tasks.md, checks the work, retries on a failure, has a cheaper model review it, then marks it done, waiting [?] or stuck [!].
- How it fits: Never skips permissions. Create autopilot\STOP to stop after the current step. Questions go to autopilot\questions.md.
- Heavy on the PC

### Autopilot: keep going

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\autopilot.py --loop
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\autopilot.py`
- What it does: Until the list is done, the day's budget is spent, or STOP exists.
- How it fits: Use it while you are away.
- Heavy on the PC

### Autopilot: status

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; python tools\autopilot.py --status
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\tools\autopilot.py`
- What it does: What is done, waiting and open. --dry-run shows the next prompt and runs nothing.

### Song worker: show what was asked

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\songworker.mjs --dry
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\songworker.mjs`
- What it does: Syncs the private library and lists the songs you asked for on the phone. Runs nothing.
- How it fits: The worker is one more device of the same library. Needs %USERPROFILE%\.fretboard\sync.json set up once (repo and token, the same as the app's Sync panel).

### Song worker: one round

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\songworker.mjs
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\songworker.mjs`
- What it does: For each asked song: finds the video, runs fromlink.py and delivers it only on a PASS. Otherwise a short reason goes on the placeholder.
- How it fits: Phone: Ask my computer. Computer: this. Phone: the finished song arrives by sync. One worker at a time; PAUSE file in %USERPROFILE%\.fretboard\worker holds it.
- Heavy on the PC

### Song worker: keep going

```
cd -LiteralPath "C:\Users\natha\Desktop\[4] Project Database\Claude\Song star"; node scripts\songworker.mjs --loop --every 5
```

- Run from: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star`
- Script: `C:\Users\natha\Desktop\[4] Project Database\Claude\Song star\scripts\songworker.mjs`
- What it does: A round every 5 minutes (--every MIN) until stopped.
- How it fits: Not set up as a scheduled task yet.
- Heavy on the PC

## How the commands fit together

- A song asked for on the phone: Phone (Ask my computer) → Song worker: one round → YouTube search (as JSON) → YouTube link to synced song, one command → The gate: verdict for one song → Phone (sync delivers a PASS)

- A song by hand, from a link: Start the UG helper → YouTube link to synced song, one command → Fit the sync with the wave fitter → Wave aligner: line the video up by eye and ear → The gate: verdict for one song → App (Replace it)

- Measure and tune the sync: Download the approved datasets → Truth benchmark: build the cases → Truth benchmark: run chosen variants → Show the improvement table and redraw the dashboard → Save a snapshot to the history → Open the dashboard

- Training data for TabMaker: Find new dataset candidates → Download the approved datasets → Make training examples → Check the labels line up with the stems → Look at the examples in a browser

- Change the app and ship it: Preview copy for checking changes → Run every test → Round-trip import test → Check before shipping (changes nothing) → Ship: commit named files and push to main → Build, install on the phone, bump the version
