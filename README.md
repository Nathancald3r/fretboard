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

- **Player:** shows the tab with a cursor that follows playback. Everything for playback sits in a bar docked at the bottom that is always visible: a song position bar you can click to jump, play/stop, time, the current and next chord, speed, loop, count-in, click and the track picker. **Trainer**, **Tracks** (mute / solo), **View** (layout, tab/notation, zoom, chords), **Sound** and **Amp** open as panels above the bar (`Esc` closes them). The bar keeps clear of the Windows taskbar (including an auto-hiding one) and a phone's home bar; if anything still covers it, **View → Space under the play bar** raises it.
- **Chords:** chord names are drawn above the tab, and the play bar shows the chord now → next. They come from the file when it has them (Guitar Pro chord names); otherwise they are guessed per bar (or half bar) from the notes of all tracks, so treat those as a hint. Turn them off under **View**.
- **Speed:** 25–150%, with an approximate BPM shown. The app remembers the speed and track for each song.
- **Looping:** drag across the tab to select bars, then turn on **Loop**. Escape clears the selection.
- **Speed trainer:** loops your selection and raises the tempo by a set step every N loops until it reaches the target.
- **Count-in and click track** while a song plays.
- **Tone:** Warm (default), Balanced, Dark or Bright EQ on the playback. Under **Sound**, you can load any `.sf2`/`.sf3` soundfont (for example GeneralUser GS or MuseScore General) for more realistic instruments. The app remembers it in this browser.
- **Amp (plug in your guitar):** in the player, open **Amp**, pick your audio interface and press **Turn amp on**. Your guitar runs through a noise gate, drive (clean / crunch / high gain), bass/mid/treble/presence, a speaker cabinet (4×12, 2×12, 1×12 or none), delay and reverb, and plays along with the song. Six built-in tones (Clean, Edge of breakup, Classic rock crunch, 80s lead, Modern high gain, Blues); tweak one and **Save as new…** to keep your own, and tick **Load this tone when … opens** to attach it to the song. **Mute the tab's guitar** silences the track you're reading so you play that part, and **Song volume** sets the backing level. The panel shows input level and the measured latency. Use wired headphones on an audio interface: speakers feed back, and Bluetooth adds too much delay. **Demo riff** in the Input list previews tones without a guitar.
- **Metronome:** subdivisions, accent on beat 1, tap tempo, and a speed builder that adds X BPM every N bars.
- **Tuner:** uses your mic. It has 9 tunings and reference tones you can play.
- **Text tabs:** chords, tab lines and section headers are highlighted. Text size and auto-scroll speed are adjustable. Tab lines can be played as a score (rhythm is guessed from the spacing).
- **Nashville numbers:** switch a chord sheet's chords to numbers (G D/F# Em7 C in G → 1 5/7 6m7 4). The key is detected from the chords, or you can set it.
- **Scales:** 12 scales (major, minor, pentatonics, blues, the modes, harmonic and melodic minor) in any key and every position, shown on a fretboard diagram with degrees or note names. **Practice in player** turns the position into an exercise (up and down, in 3s or in 4s) that you can loop and run through the speed trainer.
- **Chords & keys:**
  - **Circle of fifths:** click any key to see its key signature, its scale, and the seven chords in it. Each chord shows its Roman numeral and Nashville number, and you can switch to 7th chords. Click a chord to see and hear it, or play common progressions (pop, blues, jazz ii–V–I, minor rock) at any tempo.
  - **Chord finder:** 15 chord types in every key. Shows open shapes plus E- and A-shape barre chords, with each dot labelled by its interval.
  - **Chord changes:** a one-minute drill for any pair of chords. Your best and recent scores are saved for each pair.
  - **Fretboard notes:** a quiz to name the highlighted note. You choose the strings, the frets and whether to include sharps and flats.
- **Practice log:** counts the time a song is actually playing, or the time a text tab is open. Shows today, last 7 days, day streak, time per song and top speed.

Keyboard shortcuts in the player: `Space` play/pause, `←` / `→` previous/next bar (`Shift` for 4 bars), `Home` back to the start (or the start of the selection), `End` last bar, `[` / `]` speed ±5%, `L` loop on/off, `C` count-in, `M` click, `Esc` close the open panel, or clear the selection. With count-in on, every start counts you in, including after jumping to a bar.

Everything is stored only in this browser (IndexedDB). Clearing site data deletes your library.

## On your phone

The mic (tuner) only works over HTTPS or on localhost. To use the app on a phone, host this folder on a static HTTPS host such as GitHub Pages, with `vendor/` committed, and use "Add to Home Screen". The app also works offline once it has loaded.
