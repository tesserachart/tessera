# Colour picker

Every colour the user picks in Tessera comes from one picker (`ColorPicker` in `packages/ui`): a saturation and brightness field, a hue strip, an opacity slider where the value can carry one, the preset swatches, the recent colours and a small hex field. Dragging any of them changes the colour live; a whole drag is one undo step on a drawing.

## Sub-features

- `colour-drag` dragging the field, the hue strip or the opacity slider recolours the target on every move, before the button is released.
- `colour-one-undo` a drag on a drawing's colour is one undo step (`chart.undo_drawing`), not one per move.
- `colour-swatch-name` a palette swatch (`mist`, `up`, …) stays a palette name in the runtime, also when only the opacity changes, so it follows the chart theme; a dragged colour is `#rrggbb`, or `#rrggbbaa` below 100% opacity.
- `colour-recent` the colour let go of joins `Recent colours`, shared by every picker; colours passed mid-drag do not.
- `colour-everywhere` the same picker on: a drawing's `Colour` and `Text colour` (style bar), an indicator's plot, fill and colour inputs, Settings › Chart › Chart colours and drawing tool defaults, a custom indicator's colour inputs, the journal's tag colour and its trade chart's `Line colour`.

## How to get to it (user POV)

- Draw with `toolbar "Drawing tools"` › `button "Horizontal line"` and a tap on the chart; the line's `toolbar "Horizontal line style"` has `button "Colour: Mist"`.
- Settings › Chart › Chart colours: `button "Background: #05080b"` and its neighbours.

## Driving it with the e2e MCP

Preconditions: the baseline in `README.md`.

- **Drag.** Draw a horizontal line on `region "NQ Z6 5m"`, tap `button "Colour: Mist"`. The popover shows `slider "Saturation and brightness"`, `slider "Hue"`, `slider "Opacity"`, `radiogroup "Swatches"` and `textbox "Colour, hex"`. The e2e grammar cannot hold a button down, so drag with Playwright's `mouse.down`/`move`/`up` over the field's box: between moves, `layout.get '{"layoutId":"default"}'` shows `charts["chart-1"].drawings[…].style.color` already changed. `e2e/agent/colour-picker.e2e.ts` does exactly this.
- **Stored.** After the drag the trigger reads `button "Colour: #rrggbb"` and `layout.get` has the same colour; `chart.undo_drawing` once brings back the colour before the drag.

## Gotchas

- Recent colours live in the page's local storage, so a fresh session starts with none.
