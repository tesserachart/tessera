import { expect, test } from './support/fixtures.ts';
import { openApp } from './support/launch.ts';

interface Positions {
  positions: { accountId: string; qty: number }[];
}

test(
  'the first fill moves nothing on the desk: the charts keep their size and the order buttons their place',
  { requires: ['browser'], timeout: 180_000 },
  async ({ app, browser, screen, runtime }) => {
    await browser.setViewport({ width: 1920, height: 1080 });
    await openApp(app, browser);
    await expect(browser.locator('.t-splash')).toHaveCount(0);
    await screen.getByRole('navigation', 'Areas').getByRole('button', 'Desk').tap();
    const ticket = screen.getByRole('region', 'Ticket: NQ Z6');
    const positionsTab = browser.locator('.dock-tab-title').filter({ hasText: /^Positions/ });
    await expect(ticket.getByRole('button', 'Buy market')).toBeEnabled();
    await expect(browser.locator('.positions-tile.is-flat')).toHaveCount(1);
    const desk = () =>
      browser.evaluate(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const rect = (el: Element) => {
          const r = el.getBoundingClientRect();
          return [r.left, r.top, r.width, r.height].join(' ');
        };
        const named = (name: string) => document.querySelector(`[aria-label="${name}"]`)!;
        return {
          charts: ['NQ Z6 5m', 'ES Z6 1m'].map((name) => rect(named(name))),
          order: [...named('Ticket: NQ Z6').querySelectorAll('[aria-label="Order"] button')].map(rect),
        };
      });
    const steadyDesk = async () => {
      let last = JSON.stringify(await desk());
      await expect
        .poll(async () => {
          const now = JSON.stringify(await desk());
          const same = now === last;
          last = now;
          return same;
        })
        .toBe(true);
      return JSON.parse(last) as Awaited<ReturnType<typeof desk>>;
    };
    const before = await steadyDesk();

    try {
      await ticket.getByRole('button', 'Buy market').tap();
      await expect(positionsTab).toHaveText('Positions 1');
      const { positions } = await runtime.tool<Positions>('portfolio.get_positions', {});
      expect(positions.map((p) => [p.accountId, p.qty])).toEqual([['paper-main', 1]]);
      const after = await steadyDesk();
      expect(after.charts, 'both charts keep their size').toEqual(before.charts);
      expect(before.order.length).toBeGreaterThan(10);
      expect(after.order, 'every order button stays under the pointer').toEqual(before.order);
      await positionsTab.tap();
      await expect(screen.getByRole('table', 'Positions, orders and fills')).toBeVisible();
      await expect(screen.getByRole('row', /^NQ Z6 Long 1 20,641\.50/)).toBeVisible();
    } finally {
      await ticket.getByRole('button', 'Flat').tap();
      await expect(positionsTab).toHaveText('Positions');
    }
  },
);
