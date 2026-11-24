import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { ImportResult } from '../../packages/protocol/src/gen/ImportResult.ts';
import type { ToolResult } from '../../packages/protocol/src/gen/ToolResult.ts';
import { readRuntimeInfo, RuntimeRpc } from './support/runtime.ts';
import { openApp } from './support/launch.ts';

const AREAS = [
  { name: 'Desk', selector: '.ar-desk', panels: ['.dockview-theme-tessera'] },
  { name: 'Markets', selector: '.mk-page', panels: ['.mk-nav', '.mk-table', '.mk-side'] },
  { name: 'Analyst', selector: '.ag', panels: ['.ag-side', '.ag-main', '.ag-foot'] },
  { name: 'Indicators', selector: '.ia-page', panels: ['.ia-cat', '.ia-detail'] },
  { name: 'Research', selector: '.rs', panels: ['.rs-list', '.rs-body'] },
  { name: 'Journal', selector: '.jr-page', panels: ['.jr-pagehead', '.jr-body'] },
  { name: 'Settings', selector: '.st-page', panels: ['.st-nav', '.st-body'] },
] as const;

for (const viewport of [
  { width: 1067, height: 667 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(
    `every area fits at ${String(viewport.width)} × ${String(viewport.height)}`,
    { requires: ['browser'], timeout: 180_000, tags: ['design', 'smoke'] },
    async ({ app, screen, browser }) => {
      await browser.setViewport(viewport);
      await openApp(app, browser);
      const nav = screen.getByRole('navigation', 'Areas');
      await expect(nav).toBeVisible();
      await expect(browser.locator('.t-splash')).toHaveCount(0);
      await browser.evaluate(async () => {
        await document.fonts.ready;
        return true;
      });

      for (const area of AREAS) {
        const button = nav.getByRole('button', area.name);
        await button.tap();
        await expect(button).toHaveAttribute('aria-current', 'page');
        await expect(nav.getByRole('button')).toHaveCount(7);
        const page = browser.locator(area.selector);
        await expect(page).toBeVisible();

        if (area.name === 'Desk') {
          await expect(screen.getByRole('region', 'QQQ 5m')).toBeVisible();
        } else if (area.name === 'Markets') {
          await expect(screen.getByLabel('Search markets')).toBeVisible();
          await page.getByRole('option', 'QQQ').tap();
          await expect(page.getByRole('region', 'QQQ details')).toBeVisible();
        } else if (area.name === 'Analyst') {
          await expect(page.getByRole('textbox', 'Ask the analyst')).toBeVisible();
        } else if (area.name === 'Indicators') {
          await expect(page.getByRole('region', 'Inputs')).toBeVisible();
        } else if (area.name === 'Research') {
          await expect(page.getByRole('button', 'New study')).toBeVisible();
        } else if (area.name === 'Journal') {
          await expect(page.getByRole('heading', 'Dashboard')).toBeVisible();
        } else {
          await expect(page.getByRole('region', 'General')).toBeVisible();
        }

        const layout = await browser.evaluate(
          ({ selector, panels }) => {
            const root = document.querySelector(selector)!;
            const bounds = (el: Element) => {
              const rect = el.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              };
            };
            return {
              viewport: { width: innerWidth, height: innerHeight },
              documentWidth: document.documentElement.scrollWidth,
              page: bounds(root),
              panels: panels.map((name) => {
                const el = root.querySelector(name);
                return { name, rect: el ? bounds(el) : null };
              }),
            };
          },
          { selector: area.selector, panels: [...area.panels] },
        );
        expect(layout.documentWidth, `${area.name}: the document does not scroll sideways`).toBeLessThanOrEqual(
          viewport.width,
        );
        for (const { name, rect } of [{ name: area.name, rect: layout.page }, ...layout.panels]) {
          expect(rect, `${area.name}: ${name} exists`).not.toBeNull();
          if (!rect) continue;
          expect(rect.width, `${area.name}: ${name} has usable width`).toBeGreaterThan(40);
          expect(rect.height, `${area.name}: ${name} has usable height`).toBeGreaterThan(28);
          expect(rect.x, `${area.name}: ${name} starts in the window`).toBeGreaterThanOrEqual(0);
          expect(rect.right, `${area.name}: ${name} fits the window width`).toBeLessThanOrEqual(
            layout.viewport.width + 1,
          );
          expect(rect.bottom, `${area.name}: ${name} fits the window height`).toBeLessThanOrEqual(
            layout.viewport.height + 1,
          );
        }
        await app.screenshot(`design-${area.name.toLowerCase()}-${String(viewport.width)}x${String(viewport.height)}`);
      }

      await nav.getByRole('button', 'Desk').tap();
      await expect(screen.getByRole('region', 'QQQ 5m')).toBeVisible();
      await expect(nav.getByRole('button', 'Desk')).toHaveAttribute('aria-current', 'page');
    },
  );
}

test(
  'search and keyboard navigation preserve the area being worked on',
  { requires: ['browser'], tags: ['design', 'smoke'] },
  async ({ app, screen, browser }) => {
    await openApp(app, browser);
    const nav = screen.getByRole('navigation', 'Areas');
    await nav.getByRole('button', 'Markets').tap();
    const markets = screen.getByRole('region', 'Markets');
    const search = markets.getByLabel('Search markets');
    await search.fill('QQQ');
    await expect(markets.getByRole('option', 'QQQ')).toBeVisible();
    await expect(markets.getByRole('option')).toHaveCount(1);
    await search.press('ArrowDown');
    await expect(markets.getByRole('region', 'QQQ details')).toBeVisible();

    await nav.getByRole('button', 'Journal').tap();
    const journal = screen.getByRole('region', 'Journal');
    await journal.getByRole('button', 'Analytics').tap();
    await expect(journal.getByRole('heading', 'Analytics')).toBeVisible();
    await nav.getByRole('button', 'Markets').tap();
    await expect(search).toHaveValue('QQQ');
    await expect(markets.getByRole('region', 'QQQ details')).toBeVisible();
    await nav.getByRole('button', 'Journal').tap();
    await expect(journal.getByRole('heading', 'Analytics')).toBeVisible();

    await browser.keyboard.press('Control+,');
    await expect(nav.getByRole('button', 'Settings')).toHaveAttribute('aria-current', 'page');
    const settings = screen.getByRole('region', 'Settings');
    const settingSearch = settings.getByLabel('Search settings');
    await expect(settingSearch).toBeVisible();
    await browser.keyboard.press('/');
    await expect(settingSearch).toBeFocused();
    await settingSearch.fill('Reduce motion');
    await expect(settings.getByRole('listbox', 'Settings found').getByRole('option')).toHaveCount(1);
    await settingSearch.press('Enter');
    await expect(settings.getByRole('region', 'Appearance')).toBeVisible();
    await expect(settings.getByRole('switch', 'Reduce motion')).toBeFocused();
    await browser.keyboard.press('Escape');
    await expect(nav.getByRole('button', 'Journal')).toHaveAttribute('aria-current', 'page');
    await expect(journal.getByRole('heading', 'Analytics')).toBeVisible();
  },
);

const JOURNAL_CSV = [
  'Id,ContractName,EnteredAt,ExitedAt,EntryPrice,ExitPrice,Fees,PnL,Size,Type',
  ...[
    ['2026-09-28', '09:35', '10:05', 482, 483.5, 'Long'],
    ['2026-09-28', '11:00', '11:20', 485, 484.5, 'Long'],
    ['2026-09-29', '09:45', '10:30', 487, 485, 'Short'],
    ['2026-09-29', '12:00', '12:35', 483, 484.5, 'Long'],
    ['2026-09-30', '10:15', '10:40', 484, 483, 'Long'],
    ['2026-09-30', '13:00', '13:30', 485, 486, 'Long'],
    ['2026-10-01', '09:40', '10:00', 487, 486, 'Short'],
    ['2026-10-01', '11:20', '11:45', 486, 485.5, 'Long'],
    ['2026-10-02', '09:35', '10:00', 483, 485, 'Long'],
    ['2026-10-02', '11:00', '11:20', 487, 488, 'Short'],
    ['2026-10-02', '12:15', '12:55', 486, 487.5, 'Long'],
  ].map(([date, entryAt, exitAt, entry, exit, side], i) =>
    [
      `design-${String(i)}`,
      'QQQ',
      `${String(date)}T${String(entryAt)}:00-04:00`,
      `${String(date)}T${String(exitAt)}:00-04:00`,
      entry,
      exit,
      1,
      (Number(exit) - Number(entry)) * (side === 'Long' ? 1 : -1) * 100,
      100,
      side,
    ].join(','),
  ),
].join('\n');

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(
    `populated review and editing views at ${String(viewport.width)} × ${String(viewport.height)}`,
    { requires: ['browser'], timeout: 180_000, tags: ['design'] },
    async ({ app, screen, browser }) => {
      const rpc = await RuntimeRpc.open(await readRuntimeInfo(app.baseUrl));
      let importId: string | null = null;
      try {
        const imported = await rpc.tool<ImportResult>('journal.import_csv', {
          csv: JOURNAL_CSV,
          filename: 'design-review-synthetic.csv',
          platform: 'projectx',
          account: { name: `Design review ${String(viewport.width)}` },
        });
        importId = imported.importId;
        expect(imported.errors).toEqual([]);
        expect(imported.trades).toBe(11);
        await browser.setViewport(viewport);
        await openApp(app, browser);
        const nav = screen.getByRole('navigation', 'Areas');
        await expect(nav).toBeVisible();
        await expect(browser.locator('.t-splash')).toHaveCount(0);
        const shot = (name: string) =>
          app.screenshot(`design-${name}-${String(viewport.width)}x${String(viewport.height)}`);

        await nav.getByRole('button', 'Journal').tap();
        const journal = screen.getByRole('region', 'Journal');
        await expect(journal.getByRole('heading', 'Today')).toBeVisible();
        await expect(journal.getByRole('heading', 'P&L calendar')).toBeVisible();
        await shot('journal-populated');
        await journal.getByRole('button', 'Analytics').tap();
        await expect(journal.getByRole('heading', 'Cumulative P&L')).toBeVisible();
        await shot('journal-analytics');
        await journal.getByRole('button', 'Trades').tap();
        await expect(journal.getByRole('row').filter({ hasText: 'QQQ' })).toHaveCount(11);
        await shot('journal-trades');
        await journal.getByRole('row').filter({ hasText: 'QQQ' }).first().getByRole('cell', 'QQQ').tap();
        await expect(journal.getByRole('button', 'Mark as reviewed')).toBeVisible();
        await expect(journal.getByRole('button', 'Back to the trades')).toBeVisible();
        await expect(browser.locator('.jr-tchart-plot canvas').first()).toBeVisible();
        const tradePlot = await browser.evaluate(() => {
          const rect = document.querySelector('.jr-tchart-plot')!.getBoundingClientRect();
          return { height: rect.height, right: rect.right, bottom: rect.bottom };
        });
        expect(tradePlot.height).toBeGreaterThan(viewport.height / 2);
        expect(tradePlot.right).toBeLessThanOrEqual(viewport.width);
        expect(tradePlot.bottom).toBeLessThanOrEqual(viewport.height);
        await shot('journal-trade-detail');
        await journal.getByRole('button', 'Mark as reviewed').tap();
        await expect(journal.getByRole('button', 'Reviewed')).toHaveAttribute('aria-pressed', 'true');
        await journal.getByRole('button', 'Back to the trades').tap();
        await expect(journal.getByRole('row').filter({ hasText: 'QQQ' })).toHaveCount(11);

        await nav.getByRole('button', 'Research').tap();
        const research = screen.getByRole('region', 'Research');
        await research.getByRole('button', 'New study').tap();
        await expect(research.getByRole('textbox', 'Hypothesis')).toBeVisible();
        await shot('research-form');

        await nav.getByRole('button', 'Indicators').tap();
        const indicators = screen.getByRole('region', 'Indicators');
        await indicators.getByRole('button', 'New indicator').tap();
        await expect(indicators.getByRole('button', /^Run(?: |$)/)).toBeVisible();
        await expect(indicators.getByRole('button', /^Save(?: |$)/)).toBeVisible();
        await shot('indicator-editor');

        await nav.getByRole('button', 'Markets').tap();
        const markets = screen.getByRole('region', 'Markets');
        await markets
          .getByRole('navigation', 'Lists')
          .getByRole('button', /^Connections/)
          .tap();
        await expect(markets.getByRole('listbox', 'Connections')).toBeVisible();
        await shot('markets-connections');

        await nav.getByRole('button', 'Settings').tap();
        const settings = screen.getByRole('region', 'Settings');
        await settings.getByRole('navigation', 'Settings').getByRole('button', 'Appearance').tap();
        await expect(settings.getByRole('region', 'Appearance')).toBeVisible();
        await shot('settings-appearance');
      } catch (error) {
        await app.screenshot(`design-populated-before-cleanup-${String(viewport.width)}x${String(viewport.height)}`);
        throw error;
      } finally {
        if (importId) await rpc.tool('journal.delete_import', { id: importId });
        rpc.close();
      }
    },
  );
}

test(
  'a waiting paper draft folds the bracket and rejection restores the saved fold',
  { requires: ['browser'], tags: ['design'] },
  async ({ app, screen, browser }) => {
    const rpc = await RuntimeRpc.open(await readRuntimeInfo(app.baseUrl));
    let approval: NonNullable<ToolResult['approval']> | null = null;
    try {
      await browser.setViewport({ width: 1440, height: 900 });
      await openApp(app, browser);
      await expect(browser.locator('.t-splash')).toHaveCount(0);
      const nav = screen.getByRole('navigation', 'Areas');
      await nav.getByRole('button', 'Desk').tap();
      const bracket = browser.locator('.tk-bracket .tk-fold').first();
      await expect(bracket).toHaveAttribute('aria-expanded', 'true');
      await expect(screen.getByLabel('Stop distance')).toBeVisible();

      const result = await rpc.call<ToolResult>('tools.invoke', {
        name: 'orders.create_draft',
        input: { accountId: 'paper-main', instrument: 'QQQ', side: 'buy', qty: 1, orderType: 'market' },
      });
      approval = result.approval;
      expect(result.status).toBe('pending_approval');
      expect(approval).not.toBeNull();
      await expect(bracket).toHaveAttribute('aria-expanded', 'false');
      await expect(screen.getByLabel('Stop distance')).toHaveCount(0);
      await expect(browser.locator('.an')).toHaveAttribute('data-has-draft', 'true');
      await app.screenshot('design-desk-waiting-draft-1440x900');

      await bracket.tap();
      await expect(bracket).toHaveAttribute('aria-expanded', 'true');
      await bracket.tap();
      await expect(bracket).toHaveAttribute('aria-expanded', 'false');
      await rpc.call('approvals.resolve', {
        approvalId: approval!.approvalId,
        previewHash: approval!.previewHash,
        decision: 'reject',
      });
      approval = null;
      await expect(bracket).toHaveAttribute('aria-expanded', 'true');
      await expect(screen.getByLabel('Stop distance')).toBeVisible();
    } finally {
      if (approval) {
        await rpc.call('approvals.resolve', {
          approvalId: approval.approvalId,
          previewHash: approval.previewHash,
          decision: 'reject',
        });
      }
      rpc.close();
    }
  },
);
