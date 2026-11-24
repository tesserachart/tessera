import { expect, test } from './support/fixtures.ts';
import { openApp } from './support/launch.ts';

test('the agent changes the chart symbol to NQ through the command palette', async ({
  app,
  agent,
  browser,
  runtime,
}) => {
  await openApp(app, browser);
  const symbol = browser.locator('.stage-bar').getByRole('button', /^Symbol /);
  await expect(symbol).toHaveAccessibleName('Symbol QQQ');

  await agent.act('Open the command palette, search for {symbol} and pick it to change the symbol of the QQQ chart', {
    params: { symbol: 'NQ' },
  });

  await expect(symbol).toHaveAccessibleName(/^Symbol NQ[FGHJKMNQUVXZ]\d\.CME$/);
  await expect(symbol).toContainText(/^NQ [FGHJKMNQUVXZ]\d/);
  await expect(browser).toHaveTitle(/^NQ [FGHJKMNQUVXZ]\d [\d,.]+ /);
  await expect
    .poll(async () => (await runtime.layout(runtime.hello.defaultLayoutId)).charts['chart-1']?.instrument)
    .toMatch(/^NQ[FGHJKMNQUVXZ]\d\.CME$/);
});

test('the agent changes the chart timeframe to 15m', async ({ app, agent, browser, runtime, screen }) => {
  await openApp(app, browser);
  const timeframes = browser.locator('.stage-bar').getByRole('group', 'Timeframe');
  await expect(timeframes.getByRole('button', '5m')).toHaveAttribute('aria-pressed', 'true');

  await agent.act('Change the timeframe of the QQQ chart to {timeframe}', { params: { timeframe: '15m' } });

  await expect(timeframes.getByRole('button', '15m')).toHaveAttribute('aria-pressed', 'true');
  await expect(screen.getByRole('region', 'QQQ 15m').getByRole('button', /^Timeframe /)).toHaveAccessibleName(
    'Timeframe 15m',
  );
  await expect(browser).toHaveTitle(/^QQQ [\d,.]+ /);
  await expect
    .poll(async () => (await runtime.layout(runtime.hello.defaultLayoutId)).charts['chart-1']?.timeframe)
    .toBe('15m');
});
