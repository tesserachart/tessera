import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { openApp } from './support/launch.ts';

test('the shell states its environment and what sends', async ({ app, browser, screen }) => {
  await openApp(app, browser);

  const analyst = screen.getByRole('complementary', 'Analyst');
  await expect(analyst.getByText(/^Sees NQ [FGHJKMNQUVXZ]\d 5m/)).toBeVisible();
  await expect(analyst.getByText(/No AI provider connected/)).toHaveCount(0);
  const line = analyst.getByRole('textbox', 'Ask the analyst');
  await line.fill('Why did the flip hold?');
  await line.press('Enter');
  await expect(analyst.getByText(/^No AI provider connected/)).toBeVisible();
  await expect(line).toHaveValue('Why did the flip hold?');
  await line.fill('');

  await analyst.getByRole('tab', /^Trade/).tap();
  const panel = analyst.getByRole('region', 'Trading panel');
  await expect(panel).toContainText('a click sends');
  await analyst.getByRole('tab', /^Analyst/).tap();
  await expect(analyst.getByRole('tab', /^Analyst/)).toHaveAttribute('aria-selected', 'true');

  await expect(browser.locator('html')).toHaveAttribute('data-env', 'paper');
});
