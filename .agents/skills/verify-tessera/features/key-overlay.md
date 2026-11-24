# Key overlay

Tapping ⌥ (Alt) or ⌘ (Ctrl elsewhere) on its own, or holding it for 400 ms, opens a list of every action whose key uses that modifier, read from the one command registry ⌘K reads (`apps/desktop/src/commands/modifierMap.ts`). It opens over the focused panel (a chart, the DOM, the analyst), or the top of the desk when nothing is focused, and never takes the focus: the chart or field keeps it, and typed keys go to the overlay only while it is open. An action that cannot run here is dimmed and says why (`Open a chart first`, `Focus a DOM first`).

## Sub-features

- `overlay-summon` a tap of ⌥ or ⌘ alone opens `dialog "⌥ keys"` or `dialog "⌘ keys"` on key-up; holding opens it after 400 ms and letting go keeps it open. A chord (⌥P, ⌘K), a ⌥ or ⌘ click, a press inside a text field or the palette, an open modal dialog and onboarding never open it.
- `overlay-rows` `listbox "⌥ actions"` groups its options by the registry's group, the focused panel's group first, each with its key on the right; `Draw: Fixed range volume profile` shows ⌥⇧P. Nothing in the list is defined outside the registry.
- `overlay-search` typing the rest of a chord highlights that row first (⇧P → `Draw: Fixed range volume profile`, P → `Volume profile: show or hide`); typing a name (`fib`) finds rows by title and keywords, like ⌘K. ↑ ↓ and Tab move, Enter or a click runs the highlighted row and closes the overlay.
- `overlay-dismiss` Esc, a second tap of the same modifier, a click outside, the window losing focus or a real chord close it; tapping the other modifier switches to its list.

## Recipe

1. Baseline desk. Click `region "NQ Z6 5m"`'s canvas so the chart has the focus.
2. `press Alt` (down and up). Expect `dialog "⌥ keys"` over the NQ chart with `Draw: Trend line ⌥T` … `Draw: Fixed range volume profile ⌥⇧P` under Chart.
3. `press Shift+P`. Expect `option "Draw: Fixed range volume profile"` selected. `press Enter`: the overlay closes, the chart's drawing rail shows the tool on, and the chart still has the focus.
4. Two clicks on the chart draw the profile; `layout.get '{"layoutId":"default"}'` holds a `volume_profile` layer with `period` `range` on `chart-1`.
5. `press Meta` then type `pal`: `Open command palette ⌘K` is the first row; Enter opens ⌘K, which still finds `Draw: Fixed range volume profile`.
