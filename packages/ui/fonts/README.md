# Bundled fonts

Every family here is under the SIL Open Font License 1.1, and its licence text ships next to it. The app loads them
from this package only, so it works offline. `src/styles/fonts.css` declares them, `src/fonts.ts` waits for the brand
faces (`BRAND_FACES`), and the stacks are `--font-serif`, `--font-sans` and `--font-fig` in `src/styles/tokens.css`.

| File                            | Family                                                  | Source (google/fonts @ `9710da1e`)                 | Licence                   |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------------- | ------------------------- |
| `InstrumentSerif-Regular.woff2` | Instrument Serif Regular                                | `ofl/instrumentserif/InstrumentSerif-Regular.ttf`  | `InstrumentSerif-OFL.txt` |
| `InstrumentSerif-Italic.woff2`  | Instrument Serif Italic                                 | `ofl/instrumentserif/InstrumentSerif-Italic.ttf`   | `InstrumentSerif-OFL.txt` |
| `InstrumentSans-VF.woff2`       | Instrument Sans (variable: wdth 75–100, wght 400–700)   | `ofl/instrumentsans/InstrumentSans[wdth,wght].ttf` | `InstrumentSans-OFL.txt`  |
| `TesseraFigures-Regular.woff2`  | Tessera Figures (derived from Instrument Serif Regular) | `make_tessera_figures.py`                          | `TesseraFigures-OFL.txt`  |
| `TesseraKeys.woff2`             | Tessera Keys (original)                                 | `make_tessera_keys.py`                             | `TesseraKeys-OFL.txt`     |

The upstream TTFs were converted to woff2 with fontTools, with nothing removed; the sans file is renamed because
brackets in a file name trip some bundlers. Instrument Sans has `tnum`, so `--font-fig` is Instrument Sans with
tabular figures.

## Tessera Figures

A figures-only, tabular cut of Instrument Serif Regular: it keeps `0-9 . , + − % $ :` and the space, gives every digit
the same advance with its ink centred, drops kerning, and is renamed `Tessera Figures` (Instrument Serif declares no
Reserved Font Name). No font stack names it now; it is still declared and in `BRAND_FACES`. Rebuild it from this
directory with fontTools and brotli (`pip install fonttools brotli`):

```sh
python3 make_tessera_figures.py InstrumentSerif-Regular.woff2 TesseraFigures-Regular.woff2 420
```

The last argument is the digit advance in font units. A rebuild matches the committed file
(`sha256 15d96b395fa633565dd26ead0a10bad2c5a933a957a863b27764fa4214580c77`) in glyphs, metrics, cmap and names; only
`head`'s checksum may differ.

## Tessera Keys

The ten code points Instrument lacks, ⌘ ⇧ ⌥ ⌃ ⏎ ↵ ⇥ ⇤ ⌫ and Δ, drawn in the icons' grammar (square ends, straight
strokes, no curves) at Instrument Sans's cap height. Every stack lists it straight after the text face, and its
`unicode-range` holds exactly those code points. Do not write ≥, ≤, ≈ or ▸: no bundled face has them. Rebuild it with
`python3 make_tessera_keys.py`; a rebuild has the committed file's outlines and cmap
(`sha256 dce8e3c472e27746f8924556cd54151e9d5eadf49092779f21b4be0e86c8dcc6`).
