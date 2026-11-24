import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { openApp } from './support/launch.ts';

test('the shell connects and shows the desk', async ({ app, browser, screen }) => {
  await openApp(app, browser);

  const nav = screen.getByRole('navigation', 'Areas');
  await expect(nav).toBeVisible();
  await expect(browser.locator('.t-annun')).toHaveCount(0);
  await expect(browser).toHaveTitle(/^NQ [FGHJKMNQUVXZ]\d [\d,.]+ [+−]?[\d.]+% · Paper$/);
  await expect(screen.getByRole('group', 'Watchlist')).toBeVisible();
  await expect(browser.locator('.t-floor .t-ear')).toContainText('paper-main');

  const stage = browser.locator('.stage-bar');
  await expect(stage.getByRole('button', /^Symbol /)).toHaveAccessibleName(/^Symbol NQ [FGHJKMNQUVXZ]\d$/);
  await expect(stage.getByRole('group', 'Timeframe').getByRole('button', '5m')).toHaveAttribute('aria-pressed', 'true');

  const nq = screen.getByRole('region', /^NQ [FGHJKMNQUVXZ]\d 5m$/);
  await expect(nq.getByRole('button', /^Timeframe /)).toHaveAccessibleName('Timeframe 5m');
  await expect(nq.getByText(/^\d+ bars$/)).toHaveCount(1);

  const es = screen.getByRole('region', /^ES [FGHJKMNQUVXZ]\d 1m$/);
  await expect(es.getByRole('button', /^Timeframe /)).toHaveAccessibleName('Timeframe 1m');
});
