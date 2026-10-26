# Goals (the user's own words, kept short)

- **Hands-off by 2026-11-04:** after that the user stops using Claude. Everything must run by itself, with plain docs.
  1. Stem test done; the winning split goes into the Colab notebook (`tools/colab/`).
  2. A drum track in the .gp5 from a video.
  3. One-click auto-sync with a clear pass/fail.
  4. One-step zip import with the video synced.
  5. A plain how-to guide.
  6. A final test on 3 new songs without Claude.
- **Practice tab, guitar skills first** (TODO.md "Practice tab"): clean-speed loop, strum timing, scales and
  shapes, chord changes per minute, fret notes with spaced repetition, a daily 30-minute plan with a log.
- **Guitar sound quality comes first**, above everything else.
- Fretboard is a PWA plus an Android APK under 30 MB; the soundfont is never bundled.
- Replies and docs: short, plain, simple bullets.

# The long-term plan: `autopilot/tabmaker_handoff.md` (the user's TabMaker handoff; private, not in git)

- **Now (to Nov 4): the personal tool.** The user chose this first (2026-10-25): best sound, any model.
- **Later: a sellable product.** Read the handoff before any work that touches it. Its rules, in short:
  - UG official tabs and the user's synced songs are a **private test set only**: never training data, never in the product.
  - Product code uses only commercially cleared models and data (Spleeter, Basic Pitch, AAM, Guitar-TECHS, E-GMD,
    Groove MIDI, own data). Demucs, the UVR/RoFormer models, madmom, YourMT3 and yt-dlp are personal-tool only.
  - The product takes uploaded audio; YouTube only through the embedded player. Add a Credits page.
- Don't build product-only work unless a task asks for it; keep personal-tool work from closing that door
  (keep stem splitting, note reading and syncing as swappable steps).
