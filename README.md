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
3. To add it, drag it onto the library or click **Import files**. Plain-text tabs work too: either **Paste text tab** or import a `.txt` file.

## Features

- **Player:** shows the tab with a cursor that follows playback. You can switch tracks, mute or solo tracks, switch between tab only / tab + notation / notation only, choose page or horizontal layout, and zoom.
- **Speed:** 25–150%, with an approximate BPM shown. The app remembers the speed and track for each song.
- **Looping:** drag across the tab to select bars, then turn on **Loop**. Escape clears the selection.
- **Speed trainer:** loops your selection and raises the tempo by a set step every N loops until it reaches the target.
- **Count-in and click track** while a song plays.
- **Metronome:** subdivisions, accent on beat 1, tap tempo, and a speed builder that adds X BPM every N bars.
- **Tuner:** uses your mic. It has 9 tunings and reference tones you can play.
- **Text tabs:** chords, tab lines and section headers are highlighted. Text size and auto-scroll speed are adjustable.
- **Practice log:** counts the time a song is actually playing, or the time a text tab is open. Shows today, last 7 days, day streak, time per song and top speed.

Keyboard shortcuts in the player: `Space` play/pause, `[` / `]` speed ±5%, `L` loop on/off, `Esc` clear selection.

Everything is stored only in this browser (IndexedDB). Clearing site data deletes your library.

## On your phone

The mic (tuner) only works over HTTPS or on localhost. To use the app on a phone, host this folder on a static HTTPS host such as GitHub Pages, with `vendor/` committed, and use "Add to Home Screen". The app also works offline once it has loaded.
