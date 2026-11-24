import type { Browser } from '@e2e-dev/web';
import { tileWindowSearch } from '../../packages/bridge/src/types.ts';
import { expect, test } from './support/fixtures.ts';
import { headerProblems } from './support/headers.ts';
import { openApp } from './support/launch.ts';

const headersClean = (browser: Browser) =>
  expect.poll(() => browser.evaluate(headerProblems), { timeout: 10_000 }).toEqual([]);

const centreOf = (browser: Browser, selector: string) =>
  browser.evaluate((s: string) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, selector);

async function dragTab(browser: Browser, from: string, to: string, end: 'drop' | 'cancel'): Promise<void> {
  const a = await centreOf(browser, from);
  const b = await centreOf(browser, to);
  if (!a || !b) throw new Error(`nothing to drag from ${from} to ${to}`);
  await browser.mouse.move(a.x, a.y);
  await browser.mouse.down();
  for (let i = 1; i <= 10; i++)
    await browser.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10 + 4);
  if (end === 'cancel') await browser.keyboard.press('Escape');
  await browser.mouse.up();
}

const tab = (kind: string) => `.dock-tab[data-kind="${kind}"]`;

test(
  'every panel header stays clean: Indicators dragged over Trade and let go or cancelled, narrow widths, many tabs, and a pop-out',
  { requires: ['browser'], timeout: 300_000 },
  async ({ app, browser, screen, runtime }) => {
    const layoutId = runtime.hello.defaultLayoutId;
    const stored = await runtime.tool<{ dock: unknown; charts: unknown; activeChartId: string | null }>('layout.get', {
      layoutId,
    });
    await browser.setViewport({ width: 1600, height: 1000 });
    await openApp(app, browser);
    await expect(browser.locator('.t-splash')).toHaveCount(0);
    await screen.getByRole('navigation', 'Areas').getByRole('button', 'Desk').tap();
    const desk = screen.getByRole('main', 'Workspace');
    try {
      await expect(desk.getByRole('button', /^Account: Paper,/)).toBeVisible();
      await headersClean(browser);

      const addHere = browser.locator(`.panel-header:has(${tab('trade')}) [aria-label="Add a panel here"]`);
      await addHere.tap();
      await screen.getByRole('menuitem', /^Indicators/).tap();
      await headersClean(browser);

      await dragTab(browser, tab('indicators'), `.panel-header:has(${tab('chart')}) .dock-actions`, 'cancel');
      await headersClean(browser);
      await dragTab(browser, tab('indicators'), tab('trade'), 'drop');
      await headersClean(browser);
      await dragTab(browser, tab('indicators'), tab('chart'), 'drop');
      await expect(browser.locator(`.panel-header:has(${tab('chart')}) ${tab('indicators')}`)).toHaveCount(1);
      await headersClean(browser);
      await dragTab(browser, tab('indicators'), tab('trade'), 'drop');
      await expect(browser.locator(`.panel-header:has(${tab('trade')}) ${tab('indicators')}`)).toHaveCount(1);
      await headersClean(browser);

      for (const title of ['Journal', 'Alerts']) {
        await addHere.tap();
        await screen.getByRole('menuitem', new RegExp(`^${title}`)).tap();
        await headersClean(browser);
      }

      for (const chrome of ['custom', 'browser']) {
        await browser.evaluate((c: string) => {
          document.querySelector('.t-shell')?.setAttribute('data-chrome', c);
          return null;
        }, chrome);
        for (const width of [1600, 1100, 760]) {
          await browser.setViewport({ width, height: 900 });
          await headersClean(browser);
        }
      }

      await browser.setViewport({ width: 1600, height: 1000 });
      await desk.getByRole('toolbar', 'Chart').first().getByRole('button', 'Pop out').tap();
      const tileId = 'chart-1';
      await browser.goto(
        `/${tileWindowSearch({ kind: 'chart', id: `pop-${layoutId}-${tileId}`, title: 'NQ', params: { layoutId, tileId, panelId: tileId } })}`,
      );
      await browser.setViewport({ width: 900, height: 600 });
      await screen.getByRole('button', 'Trade', { exact: true }).tap();
      await expect(screen.getByRole('button', /^Account: Paper,/)).toBeVisible();
      for (const width of [900, 560, 380, 320]) {
        await browser.setViewport({ width, height: 600 });
        await headersClean(browser);
      }
    } finally {
      await browser.goto('/healthz');
      await runtime.tool('layout.save', {
        layoutId,
        dock: stored.dock,
        charts: stored.charts,
        ...(stored.activeChartId ? { activeChartId: stored.activeChartId } : {}),
      });
    }
  },
);
