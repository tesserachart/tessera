import { expect, test } from './support/fixtures.ts';
import { openApp } from './support/launch.ts';

test('a timeframe the agent picks for the second chart stays after a reload', async ({
  app,
  agent,
  browser,
  runtime,
  screen,
}) => {
  await openApp(app, browser);
  const es = screen.getByRole('main', 'Workspace').getByRole('region', /^ES [FGHJKMNQUVXZ]\d /);
  const timeframe = es.getByRole('button', /^Timeframe /);
  await expect(timeframe).toHaveAccessibleName('Timeframe 1m');

  await agent.act('Change the timeframe of the {symbol} chart to {timeframe}', {
    params: { symbol: 'ES', timeframe: '30m' },
  });

  await expect(timeframe).toHaveAccessibleName('Timeframe 30m');
  await expect
    .poll(async () => (await runtime.layout(runtime.hello.defaultLayoutId)).charts['chart-2']?.timeframe, {
      timeout: 10_000,
    })
    .toBe('30m');

  await browser.reload();
  await expect(screen.getByRole('navigation', 'Areas')).toBeVisible();
  await expect(browser.locator('.t-annun')).toHaveCount(0);
  await expect(timeframe).toHaveAccessibleName('Timeframe 30m');
  await expect(screen.getByRole('region', /^ES [FGHJKMNQUVXZ]\d 30m$/)).toBeVisible();
  await expect(
    screen.getByRole('region', /^NQ [FGHJKMNQUVXZ]\d 5m$/).getByRole('button', /^Timeframe /),
  ).toHaveAccessibleName('Timeframe 5m');
});
