# Icons

Every meaning has its own icon, drawn once in `packages/ui/icons/icons.svg` as 1.5 px strokes on the 20 px grid. On a 2x screen an icon draws that stroke. On a 1x screen it draws the pixel cut `build-icons.mjs` snapped for its size (11, 12, 14, 16 or 20 px), so no line has a half-tone edge. An icon's size is its `--icon`; nothing sets an icon's width or height.

## Entry points

- The panel header (`button "Split chart"`, `button "Pop out"`, `button "Maximise"`, `button "More"`, `button "Close …"`), the chart bar's Trade toggle and the Trade panel's tab: three different pictures (two panes, a notched ticket, corner brackets).
- The area rail: Desk, Markets, Analyst, Indicators, Research, Journal, Trade copier, Feedback, Settings, each with its own icon.
- The drawing rail, the indicator legend (settings, Hide or Show, Remove), the composer (attach, send), the Trade ticket's working orders (cancel order).

## Recipe

`node .agents/skills/verify-tessera/scripts/icon-sharpness.ts [evidence dir] [ui dir] [pr|main]` starts its own sim runtime, opens every area at 1x and then at 2x, and saves `<scene>-<area>-<scale>x.png`. With `pr` it fails on any icon that draws the stroke at 1x, or whose box is not its `--icon` size, and lists them in `<scene>-soft.txt`. With main's `dist` as the ui dir and `main` it saves main's screens for the same areas.

## End state

- `ok: every icon draws its pixel cut at 1x`.
- At 2x the same icons draw the stroke: smooth diagonals and curves, square ends.
- No two icons in a screen share a picture; `packages/ui/test/icons.test.tsx` keeps every pair apart except six siblings that differ by one mark (lock and unlock, shown and hidden, pop out and dock back, trend line and ray, the two volume profiles, add and cross line).
