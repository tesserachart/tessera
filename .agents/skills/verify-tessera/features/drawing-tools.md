# Drawing tools: cross line, trend angle, fib extension and fib fan

Four drawings ATAS and DeepCharts traders reach for, on the drawing rail with their families, edited and styled like the others, kept in templates and drawn by the agent with `chart.add_drawing`.

## Sub-features

- `cross-line` one anchor: a horizontal and a vertical line through a bar's time and price, its price on the axis; words and price on its horizontal arm like a horizontal line; an alert can watch its price.
- `trend-angle` two anchors: a trend line with a dashed level arm, an arc and its angle from the horizontal in degrees as the chart shows it (up positive, `−` down), extends like a trend line, Shift keeps it level; an alert can watch it.
- `fib-extension` three anchors (the move, then the end of its pullback): levels from the third anchor at its price plus the move times each level, as wide as the move; defaults 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2; the levels popover offers 1.272 to 4.236; labels show level and price.
- `fib-fan` two anchors: rays from the first through 0.382, 0.5 and 0.618 of the rise, read at the second anchor's time, with a dashed main line; Extension stops the rays at the second anchor or runs them right; labels show levels only.
- `drawing-templates` a template of any of the four keeps its style, label look and levels; `chart.apply_drawing_template` puts it on another of its kind.

## How to get to it (user POV)

- `toolbar "Drawing tools"`: right-click (or ArrowRight on) `button "Trend line"` for `menu "Lines"` › `Trend angle`; `button "Horizontal line"` for `menu "Horizontal and vertical"` › `Cross line`; `button "Fib retracement"` for `menu "Fibonacci"` › `Fib extension` or `Fib fan`. The group button then shows the last tool picked.
- Click each anchor on `region "NQ Z6 5m"`; the new drawing is selected with `toolbar "<Kind> style"`.
- A Fibonacci drawing's `button "Levels: …"` opens `dialog "<Kind> levels"`; `button "<Kind> templates"` › `Save as template…` saves its look.

## Driving it

Preconditions: the baseline in `README.md`.

- `node .agents/skills/verify-tessera/scripts/drawing-tools.ts [out dir] [ui dir] [label] [runtime bin]` starts its own sim runtime, screenshots the three group menus, draws each of the four on NQ 5m from the rail, adds 1.272 to the extension, saves it as the template `Targets`, stops the fan's rays, then has the agent add all four to the ES chart and apply `Targets` to its extension. It saves a screenshot and `layout.get` at each step under `.e2e/artifacts/verify/drawing-tools/`. With label `main` it only screenshots the menus.
- End state: `layout.get` › `charts` › `chart-1` › `drawings` holds the four user drawings on `NQZ6.CME` (the extension with three anchors and 1.272 among its levels, the fan with `extend: none`) and `chart-2` the agent's four on ES, the agent's extension with the template's levels; `chart.list_drawing_templates {kind: fib_extension}` lists `Targets`.

## Gotchas

- The trend angle's degrees are the chart's: zooming the price or time scale changes them, as in ATAS. The agent reads anchors, not the angle.
- An extension being placed previews its move after two clicks; the third click places it.
