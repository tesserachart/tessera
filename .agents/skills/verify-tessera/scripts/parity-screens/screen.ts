import type { Locator, Page } from 'playwright';

export interface Screen {
  name: string;
  open: (page: Page) => Promise<void>;
  target?: (page: Page) => Locator;
  live?: RegExp;
}

export const areas = (page: Page) => page.getByRole('navigation', { name: 'Areas' });

export const area = (label: string) => async (page: Page) => {
  await areas(page).getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('region', { name: label, exact: true }).first().waitFor({ timeout: 240_000 });
};

export const settingsPage = (label: string) => async (page: Page) => {
  await area('Settings')(page);
  await page
    .getByRole('region', { name: 'Settings', exact: true })
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: label, exact: true })
    .click();
};
