# Round-trip import test

Measures how precisely the PDF tab importer reads a song: each song here is drawn as UG-style tab PDFs
(one per track), read back with the real importer, and scored bar by bar against the original.

    python tests/roundtrip/roundtrip.py [-k NAME] [--keep] [--verbose]

- `config.json`: the pass mark, the score weights, paper size (`letter` or `a4`), and per-song settings
  (`"songs": { "file.gp": { "pass": 0.8, "tracks": [0, 2] } }`).
- `--keep` writes the PDFs, the importer's alphaTex and `report.json` to `out/` (not committed).

## Adding a song

Drop a `.gp`/`.gp3`–`.gp5`/`.gpx` file or an alphaTex file (`.atex`) into `songs/`. Only use songs
you may share: every song here now was written for this test by the project (own work, free to use).
`sources/` holds the alphaTex that `songs/07-two-tracks.gp` was exported from (alphaTab's Gp7Exporter).

## Limits

The PDFs come from alphaTab styled like UG's Tablature view, not from UG: the font differs, and the
stems and TAB clef are patched in `harness.js` to look like UG's. A low score means the importer
misread what a UG-like page shows; check the PDF with `--keep` before blaming the importer.
