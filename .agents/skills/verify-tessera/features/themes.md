# Themes

One theme paints the whole app and its charts: `appearance.theme` (the theme shown), `appearance.themes` (the themes the trader saved) and `appearance.scheme` (Light, Dark or System, and the theme kept for each mode), resolved in `apps/desktop/src/theme/` and written to every `--color-*` custom property on `<html>`, with the page's `color-scheme`, `data-mode` and the desktop window's own frame and ground. The chart's colours follow the app's unless the chart sets its own (`appearance.chartTheme` is the chart part of the same object).

## Sub-features

- `theme-builtins` eight built-ins in five families, listed first and read-only: Tessera (the default) and Tessera Light, Solarized Dark and Light, Night Owl, Nord, Gruvbox Dark and Light. Each one's text reads 4.5:1 on every surface and its order colours 3:1 on its chart.
- `theme-scheme` Settings › Appearance › Appearance: Light, Dark or System (default Dark). System follows the computer's light or dark mode live, app and charts, and the desktop window's frame follows the OS. Each mode has its theme (Dark theme, Light theme; unset: Tessera and Tessera Light); when the mode changes, the theme shown, with its own colours or its saved link, is kept as its mode's theme and the other is shown. Only the main window flips the theme; pop-outs follow `appearance.theme`.
- `theme-switch` picking a theme repaints every surface at once, charts included, with no reload; a new window and a reload open on it with no flash of the theme before (the page keeps the last theme in local storage).
- `theme-saved` Save as… names the theme shown and shows the saved one; while a saved theme is shown, every colour change saves into it. Duplicate, Rename, Export… (a `.json` file), Delete, and Import… (that file) on Settings › Appearance › Saved themes. Deleting the shown theme keeps its colours.
- `theme-colours` Settings › Appearance › App colours: every app colour by role (surfaces, text, lines, accents, meaning, the order card, link and tag colours), with Reset to the built-in's. A pair that would not read is refused and named.
- `theme-agent` the analyst and MCP clients read the theme with `appearance.get_theme`, set it with one `settings.set` on `appearance.theme` (`{"preset": "solarized-light"}`, `{"mode": "light"}`, `{"surfaces": {"ground": "#…"}}`, `{"saved": "Night Desk"}`), and save it with `appearance.save_theme {"name": …}`.
- `theme-chart-look` Settings › Chart › Chart look puts Classic, Terminal or Graphite over the app theme; App theme is the theme's own chart. Up and down colours (Jade · coral) apply to Tessera's pair and are locked, with the reason in a tooltip, under a theme with its own.

## How to get to it (user POV)

- Settings › Appearance: `region "Theme"` with `radiogroup "Appearance"` (`radio "Light"`, `"Dark"`, `"System"`), the `Dark theme` and `Light theme` selects (that mode's built-ins, then its saved themes), `button "Save as…"` on the row of the mode shown, `button "Reset"` once the theme has colours of its own, and `button "Import…"`; `region "Saved themes"`; `region "App colours"`.
- The analyst: "make my whole app solarized light", "save this as Night Desk".

## Driving it

- `scripts/themes.ts [evidence dir] [ui dir] [pr|main] [runtime bin]` starts its own sim runtime, opens a Paper NQ long with a 40-tick stop and a 60-tick target, and for each built-in sets `appearance.theme` from the runtime and shoots the desk; for Tessera, Tessera Light, Solarized Light, Night Owl and a saved theme (`Day Desk`, Solarized Light with its own ground, panels and brand blue) it also shoots the Tessera menu, Settings › Appearance and the Journal. On every non-Tessera shot it lists any visible element still painted in Tessera's ground, panels, raised surface, hairline or text (`<label>-report.json`): the list must be empty. Then it clicks System and flips the page's `prefers-color-scheme` dark, light, dark, light: `follow` in the report must read `dark #05080b tessera`, then `light #c9dcf0 tessera-light` (the chart's own ground `#dbe8f5`), for the page's `data-mode`, the chart's ground pixel and `appearance.get_theme`, with no reload. With main's `dist`, main's runtime binary and `main` it shoots main's desk, menu, Settings › Chart and Journal.
- From a session: `runtime.ts <port> settings.set '{"key":"appearance.theme","value":{"preset":"night-owl"}}'`, then `runtime.ts <port> appearance.get_theme`: `mode` `dark`, `colors["surfaces.ground"]` `#011627`, and the page's `<html>` has `data-mode="dark"` and `--color-ink: #011627`.

## Gotchas

- The chart's own colours (Settings › Chart › Chart colours) win over the app's: a theme switch keeps them. Chart look's Reset (or `appearance.chartTheme {"reset": true}`) drops them.
- A theme's mode comes from its colours (ground lighter than text is light); `{"mode": …}` in a change only moves to the same family's other built-in (Tessera ↔ Tessera Light).
- The follower acts when the wanted mode changes, not on every theme change: an agent setting a light theme under Dark shows it until the next flip, which keeps it as the light theme.
- Headless Chromium starts with `prefers-color-scheme: light`; drive it with `page.emulateMedia({ colorScheme })`.
