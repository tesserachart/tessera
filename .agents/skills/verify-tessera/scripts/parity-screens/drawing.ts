import type { Page } from 'playwright';
import type { Screen } from './screen.ts';

const chart = (page: Page) => page.getByRole('region', { name: 'NQ Z6 5m' });

const SETTLED_MS = 3_000;

const chartSettled = async (page: Page) => {
  let last = await chart(page).screenshot();
  let since = Date.now();
  while (Date.now() - since < SETTLED_MS) {
    await page.waitForTimeout(400);
    const next = await chart(page).screenshot();
    if (!next.equals(last)) since = Date.now();
    last = next;
  }
};

const drawTrendLine = async (page: Page) => {
  await chartSettled(page);
  await page.getByRole('button', { name: 'Trend line' }).first().click();
  const box = await chart(page).boundingBox();
  if (!box) throw new Error('the NQ chart has no box');
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.45);
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.6);
  await page.getByRole('button', { name: 'Remove trend line' }).waitFor();
};

export const screens: Screen[] = [
  { name: 'drawing-style-bar', open: drawTrendLine, target: chart },
  {
    name: 'drawing-locked',
    open: async (page) => {
      await drawTrendLine(page);
      await page.getByRole('button', { name: 'Lock', exact: true }).click();
      await page.getByRole('button', { name: 'Unlock', exact: true }).waitFor();
    },
    target: chart,
  },
];
