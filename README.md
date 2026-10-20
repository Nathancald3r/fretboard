# Fretboard

A personal guitar practice app, built on the open-source [alphaTab](https://alphatab.net) library. It does the main things Songsterr does, for free and offline, using tab files you supply.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:8420. `npm install` copies alphaTab into `vendor/`. After that the app is just static files.

## Getting tabs

1. In **Find tabs online**, search Ultimate Guitar (with the Guitar Pro filter) or Songsterr. Each search opens in a new tab.
2. Download a Guitar Pro file (`.gp`, `.gp5`, `.gpx`, …). On Ultimate Guitar a free account is enough for most of them.
3. Back in Fretboard, press **Import new downloads**. The first time, pick your Downloads folder; after that one click imports every tab file downloaded in the last 14 days that isn't in the library yet. (Chrome and Edge on desktop. Elsewhere, drag the file onto the library or use **Import files**.)
4. For a plain-text tab, copy it on the site and press **Paste from clipboard**, or import a `.txt` file.

Tabs can't be fetched automatically: both sites forbid scraping in their terms, so the app only opens their search and imports what you download.

## Features

- **Player:** shows the tab with a cursor that follows playback. Everything for playback sits in a bar docked at the bottom: a song position bar you can click to jump, back/play/stop, time, the current and next chord, the tempo in BPM, loop, count-in, click, play-along and the shown track with one-click **M**ute and **S**olo. **Tracks**, **Speed**, **Click**, **Recording**, **View**, **Sound**, **Amp** and **Sing** open as panels above the bar (`Esc` closes them). Clicking a spot in the tab while it plays jumps there (with count-in on, it counts you in again first). The bar keeps clear of the Windows taskbar and a phone's home bar; if anything still covers it, **View → Space under the play bar** raises it.
- **Library, search and setlists:** the ☰ button opens a sidebar with your library and setlists (create, reorder, play through with Prev / Next in the player). The search box in the top bar jumps to any song from anywhere.
- **Chords:** chord names are drawn above the tab, and the play bar shows the chord now → next. They come from the file when it has them (Guitar Pro chord names); otherwise they are guessed per bar (or half bar) from the notes of all tracks, so treat those as a hint. Turn them off under **View**.
- **Speed:** set the tempo in BPM (type it, or −/+ for 5 BPM steps), or pick a percentage (25–200%) under **Speed**. The pitch never changes, for the synth and for recordings. The app remembers the speed and track for each song, and shows tempo changes as the song plays.
- **Looping:** drag across the tab to select bars, then turn on **Loop**. Escape clears the selection.
- **Speed trainer:** loops your selection and raises the tempo by a set step every N loops until it reaches the target.
- **Click and count-in** (⚙ next to Click): click sound (woodblock, beep, cowbell, bell, synth tom or the classic metronome), volume, quarter notes / 8ths / triplets / 16ths, accent on beat 1; count-in sound, volume, length (half a bar to 2 bars) and subdivision, with a preview. The click is written into the song's MIDI, so it stays exact at any speed; the count-in is timed to the measured audio delay so the song starts on the beat.
- **Tracks:** one list for picking the shown track and mixing: click a name to show that track, and set each track's volume, mute and solo. The mix is saved with the song.
- **Play along with the recording:** under **Recording**, add the song's audio file (MP3, M4A, WAV…) or a YouTube link; `R` switches between the synth and the recording. The tab cursor follows the recording at any speed without changing pitch. To line the tab up, play it and tap `T` on beat 1 of each bar; every tap becomes a sync point (nudge ±10/50 ms or reset any time). Audio files are stored in this browser.
- **Tone:** Warm (default), Balanced, Dark or Bright EQ on the playback. Under **Sound**, you can load any `.sf2`/`.sf3` soundfont (for example GeneralUser GS or MuseScore General) for more realistic instruments. The app remembers it in this browser.
- **Amp (plug in your guitar):** in the player, open **Amp**, pick your audio interface and press **Turn amp on**. Your guitar runs through a noise gate, drive (clean / crunch / high gain), bass/mid/treble/presence, a speaker cabinet (4×12, 2×12, 1×12 or none), delay and reverb, and plays along with the song. Six built-in tones (Clean, Edge of breakup, Classic rock crunch, 80s lead, Modern high gain, Blues); tweak one and **Save as new…** to keep your own, and tick **Load this tone when … opens** to attach it to the song. **Mute the tab's guitar** silences the track you're reading so you play that part, and **Song volume** sets the backing level. The panel shows input level and the measured latency. Use wired headphones on an audio interface: speakers feed back, and Bluetooth adds too much delay. **Demo riff** in the Input list previews tones without a guitar. **Output** sends the amp straight to the interface's own outputs (lowest delay), and the panel lists tips to get the delay down; a browser can't use ASIO drivers, so expect about 15–30 ms in total.
- **Sing (singing mode):** pick the song's vocal track in the track picker, open **Sing**, choose your microphone and press **Start singing mode**, then play the song and sing. The play bar shows the written note and whether you're on it, flat or sharp (in cents), with a lane of the last few seconds of your pitch (the green band is ±50 cents). Every song or loop ends with a score, the share of note time sung within ±50 cents, plus notes hit, % flat / sharp / not sung and your average offset. Singing the right note in another octave counts as in tune (shown separately in the breakdown), and the first 120 ms of each note is not scored. Wear headphones, or the mic hears the song. **Mute the vocal track** lets you sing the part alone; **Test voice** in the microphone list sings the melody itself so you can try it without a mic. Pitch detection (YIN) and scoring live in `js/singcore.js` with tests in `tests/sing.test.mjs`.
- **Metronome:** subdivisions, accent on beat 1, tap tempo, and a speed builder that adds X BPM every N bars.
- **Tuner:** uses your mic. It has 9 tunings and reference tones you can play.
- **Text tabs:** chords, tab lines and section headers are highlighted. Text size and auto-scroll speed are adjustable. Tab lines can be played as a score (rhythm is guessed from the spacing).
- **Nashville numbers:** switch a chord sheet's chords to numbers (G D/F# Em7 C in G → 1 5/7 6m7 4). The key is detected from the chords, or you can set it.
- **Scales:** 12 scales (major, minor, pentatonics, blues, the modes, harmonic and melodic minor) in any key and every position, shown on a fretboard diagram with degrees or note names. **Practice in player** turns the position into an exercise (up and down, in 3s or in 4s) that you can loop and run through the speed trainer.
- **Chords & keys:**
  - **Circle of fifths:** click any key to see its key signature, its scale, and the seven chords in it. Each chord shows its Roman numeral and Nashville number, and you can switch to 7th chords. Click a chord to see and hear it, or play common progressions (pop, blues, jazz ii–V–I, minor rock) at any tempo. **Backing track** opens a progression in the player with drums, bass and rhythm guitar (rock, pop, ballad or funk) at your tempo, to jam over, loop, slow down or mute parts.
  - **Chord finder:** 15 chord types in every key. Shows open shapes plus E- and A-shape barre chords, with each dot labelled by its interval.
  - **Chord changes:** a one-minute drill for any pair of chords. Your best and recent scores are saved for each pair.
  - **Fretboard notes:** a quiz to name the highlighted note. You choose the strings, the frets and whether to include sharps and flats.
- **Practice log:** counts the time a song is actually playing, or the time a text tab is open. Shows today, last 7 days, day streak, time per song and top speed.

Keyboard shortcuts in the player: `Space` or `K` play/pause, `←` / `→` (or `J` / `;`) previous/next bar (`Shift` for 4 bars), `↑` / `↓` previous/next line, `Home` or `Backspace` back to the start (or the start of the selection), `End` last bar, `[` / `]` tempo ±5 BPM, `L` loop, `C` count-in, `B` click, `M` / `S` mute / solo the shown track, `R` recording on/off, `T` tap beat 1 to sync the recording, `Esc` close the open panel, or clear the selection. With count-in on, every start counts you in, including after jumping to a bar.

Everything is stored only in this browser (IndexedDB). Clearing site data deletes your library.

## On your phone

The mic (tuner) only works over HTTPS or on localhost. To use the app on a phone, host this folder on a static HTTPS host such as GitHub Pages, with `vendor/` committed, and use "Add to Home Screen". The app also works offline once it has loaded.
