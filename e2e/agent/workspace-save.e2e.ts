import { expect, test } from './support/fixtures.ts';
import { openApp } from './support/launch.ts';

test('a workspace saves like a document: a change waits for Save, and leaving without it brings the saved one back', async ({
  app,
  browser,
  runtime,
  screen,
}) => {
  await openApp(app, browser);
  const layoutId = runtime.hello.defaultLayoutId;
  const desk = screen.getByRole('main', 'Workspace');
  const menu = screen.getByRole('button', /^Tessera menu: /);
  const timeframeOf = async () => (await runtime.layout(layoutId)).charts['chart-1']?.timeframe;
  const change = async (tf: string) => {
    const tile = await desk.getByRole('region', /^NQ [FGHJKMNQUVXZ]\d /).boundingBox();
    if (!tile) throw new Error('the NQ chart is not on screen');
    await browser.mouse.move(tile.x + tile.width * 0.4, tile.y + tile.height * 0.4);
    await browser.mouse.down();
    await browser.mouse.up();
    await browser.keyboard.press('Control+k');
    await browser.keyboard.type(`Timeframe ${tf}`);
    await browser.keyboard.press('Enter');
    await expect(menu).toHaveAccessibleName(/ — Edited$/);
  };
  const switchTo = async (name: RegExp) => {
    await menu.tap();
    await screen.getByRole('menuitem', 'Switch workspace').tap();
    await screen.getByRole('menuitemradio', name).tap();
  };
  await expect(menu).not.toHaveAccessibleName(/Edited$/);

  await change('15m');
  await expect.poll(async () => (await runtime.layout(layoutId)).unsaved).toBe(true);
  await menu.tap();
  await screen.getByRole('menuitem', 'New workspace').tap();
  const ask = screen.getByRole('dialog', /^Save changes to “.+”\?$/);
  await expect(ask).toBeVisible();
  await ask.getByRole('button', 'Don’t save').tap();
  await expect(menu).toHaveAccessibleName(/^Tessera menu: Workspace \d+$/);
  await expect.poll(timeframeOf).toBe('5m');
  await expect.poll(async () => (await runtime.layout(layoutId)).unsaved ?? false).toBe(false);

  await switchTo(/^Day · /);
  await expect(desk.getByRole('region', /^NQ [FGHJKMNQUVXZ]\d 5m$/)).toBeVisible();
  await change('15m');
  await browser.keyboard.press('Control+s');
  await expect(menu).not.toHaveAccessibleName(/Edited$/);
  await expect.poll(timeframeOf).toBe('15m');

  await change('1h');
  await switchTo(/^Workspace \d+/);
  await ask.getByRole('button', 'Cancel').tap();
  await expect(menu).toHaveAccessibleName(/ — Edited$/);
  await switchTo(/^Workspace \d+/);
  await ask.getByRole('button', 'Save').tap();
  await expect(menu).toHaveAccessibleName(/^Tessera menu: Workspace \d+$/);
  await expect.poll(timeframeOf).toBe('1h');
  await expect.poll(async () => (await runtime.layout(layoutId)).unsaved ?? false).toBe(false);

  await switchTo(/^Day · /);
  await expect(desk.getByRole('region', /^NQ [FGHJKMNQUVXZ]\d 1h$/)).toBeVisible();
  const made = (await runtime.tool<{ layouts: { id: string }[] }>('layout.list', {})).layouts.filter(
    (l) => l.id !== layoutId,
  );
  for (const l of made) await runtime.tool('layout.delete', { layoutId: l.id });
});
