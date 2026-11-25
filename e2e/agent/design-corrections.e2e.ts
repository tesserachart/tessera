import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { ToolResult } from '../../packages/protocol/src/gen/ToolResult.ts';
import { readRuntimeInfo, RuntimeRpc } from './support/runtime.ts';
import { openApp } from './support/launch.ts';

for (const viewport of [
  { width: 1067, height: 667 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(
    `review controls and compact entry at ${String(viewport.width)} × ${String(viewport.height)}`,
    { requires: ['browser'], timeout: 120_000, tags: ['design'] },
    async ({ app, screen, browser }) => {
      const rpc = await RuntimeRpc.open(await readRuntimeInfo(app.baseUrl));
      let approval: NonNullable<ToolResult['approval']> | null = null;
      const shot = (name: string) =>
        app.screenshot(`corrected-${name}-${String(viewport.width)}x${String(viewport.height)}`);
      try {
        await browser.setViewport(viewport);
        await openApp(app, browser);
        await expect(browser.locator('.t-splash')).toHaveCount(0);
        const nav = screen.getByRole('navigation', 'Areas');
        await nav.getByRole('button', 'Desk').tap();
        const compact = browser.locator('.an').getByRole('button', 'Turn on Codex');
        await expect(compact).toBeVisible();
        const entry = await browser.evaluate(() => {
          const body = document.querySelector('.an-body')!.getBoundingClientRect();
          const rows = document.querySelector('.an .ag-connect')!.getBoundingClientRect();
          return {
            body: { top: body.top, bottom: body.bottom, height: body.height },
            rows: { top: rows.top, bottom: rows.bottom, height: rows.height },
          };
        });
        if (entry.body.height >= entry.rows.height) {
          expect(entry.rows.top).toBeGreaterThanOrEqual(entry.body.top);
          expect(entry.rows.bottom).toBeLessThanOrEqual(entry.body.bottom);
        }
        await shot('analyst-compact');
        await expect(nav.getByRole('button', 'Desk')).toHaveAttribute('aria-current', 'page');
        await nav.getByRole('button', 'Journal').tap();
        await expect(browser.locator('.jd-empty')).toHaveText(
          'No trades yet. Import trades or connect an account to begin.',
        );
        await expect(browser.locator('.jd-empty button')).toHaveCount(0);
        await shot('journal-empty');

        await nav.getByRole('button', 'Research').tap();
        const research = screen.getByRole('region', 'Research');
        await expect(research.getByText('No research yet.')).toBeVisible();
        await expect(research.getByRole('button', 'Ask the analyst to test an idea')).toBeVisible();
        await shot('research-empty');

        await nav.getByRole('button', 'Desk').tap();
        const bracket = browser.locator('.tk-bracket .tk-fold').first();
        await expect(bracket).toHaveAttribute('aria-expanded', 'true');
        const before = await browser.evaluate(() => document.querySelector('.an')!.getBoundingClientRect().top);
        const result = await rpc.call<ToolResult>('tools.invoke', {
          name: 'orders.create_draft',
          input: {
            accountId: 'paper-main',
            instrument: 'QQQ',
            side: 'buy',
            qty: 1,
            orderType: 'limit',
            limitPrice: 487.8,
          },
        });
        approval = result.approval;
        expect(result.status).toBe('pending_approval');
        expect(approval).not.toBeNull();
        await expect(bracket).toHaveAttribute('aria-expanded', 'false');
        const draft = screen.getByRole('group', 'Draft');
        await expect(draft).toBeVisible();
        await expect(draft.getByRole('button', 'Edit')).toBeVisible();
        await expect(draft.getByRole('button', 'Reject')).toBeVisible();
        await expect(draft.getByRole('button', /^Approve/)).toBeEnabled();
        await expect(browser.locator('.an .t-figure-card')).toHaveText('487.80');
        const geometry = () =>
          browser.evaluate(() => {
            const slot = document.querySelector('.an .ag-waiting')!;
            const sr = slot.getBoundingClientRect();
            const body = document.querySelector('.an-body')!.getBoundingClientRect();
            const composer = document.querySelector('.an .ag-compose')?.getBoundingClientRect();
            const items = [
              ...document.querySelectorAll<HTMLElement>('.an .ag-waiting .t-figure-card, .an .ag-waiting .act button'),
            ].map((el) => {
              const r = el.getBoundingClientRect();
              return { text: el.textContent.trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            });
            return {
              card: ['.t-draft', '.t-card', '.act'].map((selector) => {
                const el = slot.querySelector(selector)!;
                const r = el.getBoundingClientRect();
                return {
                  selector,
                  width: r.width,
                  height: r.height,
                  columns: getComputedStyle(el).gridTemplateColumns,
                };
              }),
              slot: {
                left: sr.left,
                right: sr.right,
                top: sr.top,
                bottom: sr.bottom,
                height: sr.height,
                scroll: slot.scrollHeight,
                client: slot.clientHeight,
              },
              body: { top: body.top, bottom: body.bottom },
              composer: composer ? { top: composer.top, bottom: composer.bottom } : null,
              items,
            };
          });
        await browser.evaluate(async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return true;
        });
        const initial = await geometry();
        console.info('design correction geometry', JSON.stringify({ viewport, entry, draft: initial }));
        await shot('waiting-draft');
        const assertInside = (g: Awaited<ReturnType<typeof geometry>>, items = g.items) => {
          for (const item of items) {
            expect(item.left, `${item.text}: left edge in draft slot`).toBeGreaterThanOrEqual(g.slot.left - 1);
            expect(item.right, `${item.text}: right edge in draft slot`).toBeLessThanOrEqual(g.slot.right + 1);
            expect(item.top, `${item.text}: top edge in draft slot`).toBeGreaterThanOrEqual(g.slot.top - 1);
            expect(item.bottom, `${item.text}: bottom edge in draft slot`).toBeLessThanOrEqual(g.slot.bottom + 1);
            expect(item.bottom, `${item.text}: stays above composer`).toBeLessThanOrEqual(g.body.bottom + 1);
          }
        };
        expect(initial.items).toHaveLength(4);
        expect(initial.composer).not.toBeNull();
        expect(
          Math.abs(initial.slot.bottom - initial.body.bottom),
          'the waiting draft stays at the composer’s edge',
        ).toBeLessThanOrEqual(1);
        expect(initial.slot.bottom).toBeLessThanOrEqual(initial.composer!.top);
        expect(initial.composer!.bottom).toBeLessThanOrEqual(viewport.height - 32);
        if (viewport.height >= 900) {
          assertInside(initial);
        } else {
          await browser.locator('.an .t-figure-card').scrollIntoView();
          const price = await geometry();
          assertInside(
            price,
            price.items.filter((item) => item.text === '487.80'),
          );
          for (const label of [/^Approve/, /^Edit$/, /^Reject$/]) {
            await draft.getByRole('button', label).scrollIntoView();
            const action = await geometry();
            assertInside(
              action,
              action.items.filter((item) => label.test(item.text)),
            );
          }
          const actions = await geometry();
          console.info('design correction scrolled actions', JSON.stringify({ viewport, draft: actions }));
          await shot('draft-actions');
        }
        await rpc.call('approvals.resolve', {
          approvalId: approval!.approvalId,
          previewHash: approval!.previewHash,
          decision: 'reject',
        });
        approval = null;
        await expect(bracket).toHaveAttribute('aria-expanded', 'true');
        await expect(screen.getByRole('group', 'Draft')).toHaveCount(0);
        const after = await browser.evaluate(() => document.querySelector('.an')!.getBoundingClientRect().top);
        expect(Math.abs(after - before), 'the user’s split returns after review').toBeLessThanOrEqual(2);
      } catch (error) {
        await shot('before-cleanup-failure');
        throw error;
      } finally {
        if (approval)
          await rpc.call('approvals.resolve', {
            approvalId: approval.approvalId,
            previewHash: approval.previewHash,
            decision: 'reject',
          });
        rpc.close();
      }
    },
  );
}
