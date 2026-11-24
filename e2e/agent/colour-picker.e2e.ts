import { expect, test } from './support/fixtures.ts';
import { openApp } from './support/launch.ts';
import type { RuntimeRpc } from './support/runtime.ts';

async function line(runtime: RuntimeRpc) {
  const layout = await runtime.layout(runtime.hello.defaultLayoutId);
  return layout.charts['chart-1']?.drawings?.find((d) => d.kind === 'horizontal_line');
}

const lineColour = async (runtime: RuntimeRpc) => (await line(runtime))?.style.color;

test("a horizontal line takes the colour dragged across the picker's field, live", async ({
  app,
  browser,
  runtime,
  screen,
}) => {
  await openApp(app, browser);
  const desk = screen.getByRole('navigation', 'Areas').getByRole('button', 'Desk');
  await desk.tap();
  await expect(desk).toHaveAttribute('aria-current', 'page');
  const chart = screen.getByRole('region', /^NQ [FGHJKMNQUVXZ]\d 5m$/);
  await screen.getByRole('toolbar', 'Drawing tools').getByRole('button', 'Horizontal line').tap();
  const tile = await chart.boundingBox();
  if (!tile) throw new Error('the NQ chart is not on screen');
  await browser.mouse.move(tile.x + tile.width * 0.45, tile.y + tile.height * 0.55);
  await browser.mouse.down();
  await browser.mouse.up();

  const bar = screen.getByRole('toolbar', 'Horizontal line style');
  await expect(bar).toBeVisible();
  await expect.poll(() => lineColour(runtime)).toBe('mist');

  await bar.getByRole('button', /^Colour: Mist/).tap();
  const field = await screen.getByRole('slider', 'Saturation and brightness').boundingBox();
  if (!field) throw new Error('the colour field is not on screen');
  const at = (fx: number, fy: number) => browser.mouse.move(field.x + fx * field.width, field.y + fy * field.height);

  await at(0.95, 0.05);
  await browser.mouse.down();
  await at(0.7, 0.2);
  await expect.poll(() => lineColour(runtime)).toMatch(/^#[0-9a-f]{6}$/);
  const midway = await lineColour(runtime);
  await at(0.4, 0.35);
  await expect.poll(() => lineColour(runtime)).not.toBe(midway);
  await browser.mouse.up();

  const picked = await lineColour(runtime);
  expect(picked).toMatch(/^#[0-9a-f]{6}$/);
  await expect(bar.getByRole('button', /^Colour: /)).toHaveAccessibleName(`Colour: ${picked!}`);
  await expect(screen.getByRole('radiogroup', 'Recent colours').getByRole('radio', picked!)).toBeVisible();

  const drawingId = (await line(runtime))!.id;
  await runtime.tool('chart.remove_drawing', { layoutId: runtime.hello.defaultLayoutId, tileId: 'chart-1', drawingId });
  await expect.poll(() => line(runtime)).toBeUndefined();
});
