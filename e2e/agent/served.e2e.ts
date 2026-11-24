import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { openApp } from './support/launch.ts';
import { readRuntimeInfo } from './support/runtime.ts';

const kept = (browser: Browser) =>
  browser.evaluate<string[]>(async () => {
    const all = (s: Storage) => Object.keys(s).map((k) => `${k}=${s.getItem(k) ?? ''}`);
    const dbs = (await indexedDB.databases()).map((d) => d.name ?? '');
    return [...all(localStorage), ...all(sessionStorage), document.cookie, ...dbs].filter(Boolean);
  });

test('the launch link connects the page, which keeps its token nowhere', async ({ app, browser, screen }) => {
  const secret = (await readRuntimeInfo(app.baseUrl)).token.slice(4);
  const used = await openApp(app, browser);
  await expect(screen.getByRole('navigation', 'Areas')).toBeVisible();
  await expect(screen.getByRole('main', 'Workspace').getByRole('region', /^NQ [FGHJKMNQUVXZ]\d 5m$/)).toBeVisible();
  await expect(browser.locator('.t-annun')).toHaveCount(0);
  expect((await kept(browser)).join('\n')).not.toContain(secret);
  expect(await browser.cookies()).toEqual([]);

  await browser.reload();
  await expect(screen.getByRole('navigation', 'Areas')).toBeVisible();
  await expect(browser.locator('.t-annun')).toHaveCount(0);
  const afterReload = await kept(browser);
  expect(afterReload.join('\n')).not.toContain(secret);
  expect(afterReload.filter((k) => k.startsWith('tessera.reload-ticket'))).toEqual([]);

  const outstanding = (await readRuntimeInfo(app.baseUrl)).ticket;
  await browser.evaluate((ticket: string) => {
    location.hash = `ticket=${ticket}`;
    return null;
  }, used);
  await expect(browser).toHaveURL('/');
  await expect(screen.getByRole('navigation', 'Areas')).toBeVisible();
  await expect(browser.locator('.t-annun')).toHaveCount(0);
  expect((await readRuntimeInfo(app.baseUrl)).ticket).toBe(outstanding);

  const opened = await browser.evaluate(() => {
    const probe = window.open('/?window=probe', 'tessera-probe', 'popup,width=800,height=600');
    (window as { probe?: Window | null }).probe = probe;
    return probe !== null;
  });
  expect(opened).toBe(true);
  await expect
    .poll(
      () =>
        browser.evaluate(() => {
          const w = (window as { probe?: Window | null }).probe!;
          return Boolean(w.document.querySelector('nav[aria-label="Areas"]') && !w.document.querySelector('.t-annun'));
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  const probeKept = await browser.evaluate(() => {
    const w = (window as { probe?: Window | null }).probe!;
    const all = (s: Storage) => Object.keys(s).map((k) => `${k}=${s.getItem(k) ?? ''}`);
    const held = [...all(w.localStorage), ...all(w.sessionStorage), w.document.cookie].filter(Boolean);
    w.close();
    return held;
  });
  expect(probeKept.join('\n')).not.toContain(secret);
});
