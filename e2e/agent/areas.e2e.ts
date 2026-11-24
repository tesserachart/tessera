import { expect, test } from './support/fixtures.ts';
import { openApp } from './support/launch.ts';

const AREAS = [
  { area: 'Trade', tile: /^NQ [FGHJKMNQUVXZ]\d 5m$/, current: 'Trade' },
  { area: 'Research', tile: 'Research', current: 'Research' },
  { area: 'Journal', tile: 'Journal', current: 'Journal' },
  { area: 'Connections', tile: 'Connections', current: null },
  { area: 'Analyst', tile: 'Analyst', current: null },
  { area: 'Settings', tile: 'Settings', current: null },
] as const;

for (const { area, tile, current } of AREAS) {
  test(`the agent opens the ${area} area`, async ({ app, agent, browser, screen }) => {
    await openApp(app, browser);
    const nav = screen.getByRole('navigation', 'Areas');
    const start = area === 'Trade' ? 'Research' : 'Trade';
    await nav.getByRole('button', start).tap();
    await expect(nav.getByRole('button', start)).toHaveAttribute('aria-current', 'page');

    await agent.act('Open the {area} area', { params: { area } });

    if (current) await expect(nav.getByRole('button', current)).toHaveAttribute('aria-current', 'page');
    else await expect(browser.locator('.t-areas [aria-current="page"]')).toHaveCount(0);
    if (area === 'Trade') await expect(browser.locator('.stage-bar .stage-sym')).toHaveText(/^NQ [FGHJKMNQUVXZ]\d$/);
    else await expect(browser.locator('.stage-bar .stage-sym')).toHaveCount(0);
    await expect(browser).toHaveTitle(/^NQ [FGHJKMNQUVXZ]\d [\d,.]+ /);
    await expect(screen.getByRole('main', 'Workspace').getByRole('region', tile)).toBeVisible();
  });
}
