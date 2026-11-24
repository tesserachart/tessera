import type { Browser } from '@e2e-dev/web';
import { expect, type App } from 'e2e';
import { readRuntimeInfo, type RuntimeInfo } from './runtime.ts';

let opened: string | null = null;

export async function nextLaunchTicket(baseUrl: string | undefined): Promise<RuntimeInfo & { ticket: string }> {
  for (let i = 0; i < 100; i++) {
    const info = await readRuntimeInfo(baseUrl);
    if (info.ticket && info.ticket !== opened) {
      opened = info.ticket;
      return { ...info, ticket: info.ticket };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the app command has no new launch ticket (e2e/agent/support/serve.ts)');
}

/** e2e step labels name `app.open` URLs. */
export async function openApp(app: App, browser: Browser, path = '/'): Promise<string> {
  const { ticket } = await nextLaunchTicket(app.baseUrl);
  await browser.route('**/e2e-entry', (route) =>
    route.fulfill({ status: 302, headers: { location: `${path}#ticket=${encodeURIComponent(ticket)}` } }),
  );
  try {
    await app.open('/e2e-entry');
  } finally {
    await browser.unroute('**/e2e-entry');
  }
  await expect(browser).toHaveURL(path);
  return ticket;
}
