# Brand assets

| File                | Where                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| `wordmark.svg`      | the wordmark, large: the splash, About (Settings › App) and the website's footer        |
| `wordmark-text.svg` | the wordmark, small: the website's nav (`apps/site`) and Cloud's pages (`apps/cloud`)   |
| `mark.svg`          | the keyed T as a file; in the app, draw it with `Mark` (its states move)                |
| `appicon.svg`       | the app icon's source; its PNG, ICNS and ICO cuts are in `apps/desktop/src-tauri/icons` |

The favicons (at rest and "a draft waits") are in `apps/desktop/public`. The T appears in five places only: the app
icon, the favicon, the Tessera menu button at the top of the rail, the splash and the draft card's head.

## Up and down

Settings › Chart › Colours and text › Up and down colours offers two pairs: **Tessera**, the default, teal up
(`#2fd3b4`) and red down (`#e0523f`), and **Jade · coral** (`#5fc79c` up, `#ec7b78` down). Every up and down colour
on a chart derives from the pair (`palette.up` and `palette.down`, `UP_DOWN_PAIRS` in
`crates/tessera-protocol/src/chart_theme.rs`); `--color-up` and `--color-down` in `src/styles/tokens.css` are the same
hexes, and `apps/desktop/test/chart-theme.test.tsx` holds them together. Up and down mark price and P&L only, never a
button, an error, a rule or the environment.
