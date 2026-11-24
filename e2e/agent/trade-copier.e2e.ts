import { expect, test } from './support/fixtures.ts';
import { openApp } from './support/launch.ts';
import type { RuntimeRpc } from './support/runtime.ts';

const LEADER = 'paper-main';
const FOLLOWERS = ['paper-2', 'paper-3'] as const;
const ACCOUNTS = [LEADER, ...FOLLOWERS];

interface Held {
  accountId: string;
  instrument: string;
  qty: number;
}
interface Leg {
  accountId: string;
  role: string;
  status: string;
  request: { stopPrice?: number | null; limitPrice?: number | null };
}

async function held(runtime: RuntimeRpc): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const accountId of ACCOUNTS) {
    const { positions } = await runtime.tool<{ positions: Held[] }>('portfolio.get_positions', { accountId });
    out[accountId] = positions
      .filter((p) => p.qty !== 0)
      .map((p) => `${String(p.qty)} ${p.instrument.split('.')[0]!}`)
      .join(', ');
  }
  return out;
}

async function workingLegs(runtime: RuntimeRpc, accountId: string): Promise<string[]> {
  const { orders } = await runtime.tool<{ orders: Leg[] }>('portfolio.get_orders', { accountId });
  return orders
    .filter((o) => o.status === 'working' && (o.role === 'stop_loss' || o.role === 'take_profit'))
    .map((o) => `${o.role} ${String(o.role === 'stop_loss' ? o.request.stopPrice : o.request.limitPrice)}`)
    .sort();
}

async function cleanUp(runtime: RuntimeRpc): Promise<void> {
  const { groups } = await runtime.tool<{ groups: { id: string }[] }>('copy.list', {});
  for (const g of groups) await runtime.tool('copy.delete', { groupId: g.id });
  for (const accountId of ACCOUNTS) await runtime.tool('orders.flatten', { accountId });
}

test(
  'a leader’s trade reaches two paper followers at their size, a paused one drifts, and Resync and Flatten all bring them back',
  { requires: ['browser'], tags: ['copy'] },
  async ({ app, browser, screen, runtime }) => {
    try {
      await openApp(app, browser);
      const nav = screen.getByRole('navigation', 'Areas');
      await nav.getByRole('button', 'Trade copier').tap();

      await screen.getByRole('button', 'New group').tap();
      const form = screen.getByRole('region', 'New group');
      await form.getByText('Paper 2').tap();
      await form.getByText('Paper 3').tap();
      await expect(form.getByRole('checkbox', 'Paper 2')).toBeChecked();
      await expect(form.getByRole('checkbox', 'Paper 3')).toBeChecked();
      await form.getByLabel('Group name').fill('Evals');
      await form.getByRole('button', 'Create').tap();

      const group = screen.getByRole('region', 'Evals');
      await expect(group.getByRole('table', 'Evals followers')).toBeVisible();
      await group.getByText('Micro').last().tap();
      await expect(group.getByRole('radio').last()).toHaveAttribute('aria-checked', 'true');
      await group.getByRole('switch', 'Copy to Paper 2').tap();
      await group.getByRole('switch', 'Copy Evals').tap();
      await expect(group.getByRole('switch', 'Copy Evals')).toHaveAttribute('aria-checked', 'true');
      await expect(group.getByRole('switch', 'Copy to Paper 2')).toHaveAttribute('aria-checked', 'false');

      await nav.getByRole('button', 'Desk').tap();
      await screen.getByRole('group', 'NQ Z6 orders').getByRole('button', 'Buy market').tap();

      await expect
        .poll(() => held(runtime), { timeout: 15_000 })
        .toEqual({ [LEADER]: '1 NQZ6', 'paper-2': '', 'paper-3': '1 MNQZ6' });
      const leaderLegs = await workingLegs(runtime, LEADER);
      expect(leaderLegs).toHaveLength(2);
      await expect.poll(() => workingLegs(runtime, 'paper-3')).toEqual(leaderLegs);

      await nav.getByRole('button', 'Trade copier').tap();
      const paper2 = group.getByRole('row', /^Paper 2/);
      const paper3 = group.getByRole('row', /^Paper 3/);
      await expect(paper3).toContainText('In sync');
      await expect(paper2).toContainText(/Paused: .*should hold Long 1/, { timeout: 10_000 });

      await group.getByRole('switch', 'Copy to Paper 2').tap();
      await expect(paper2).toHaveAttribute('data-wrong', 'true');
      await group.getByRole('button', 'Resync').first().tap();

      await expect
        .poll(() => held(runtime), { timeout: 15_000 })
        .toEqual({ [LEADER]: '1 NQZ6', 'paper-2': '1 NQZ6', 'paper-3': '1 MNQZ6' });
      await expect.poll(() => workingLegs(runtime, 'paper-2')).toEqual(leaderLegs);
      await expect(paper2).toContainText('In sync', { timeout: 10_000 });
      await expect(group.getByRole('region', 'Recent copies')).toContainText('Buy 1 NQZ6');

      await group.getByRole('button', 'Flatten all').tap();
      await expect
        .poll(() => held(runtime), { timeout: 15_000 })
        .toEqual({ [LEADER]: '', 'paper-2': '', 'paper-3': '' });
      for (const accountId of ACCOUNTS) await expect.poll(() => workingLegs(runtime, accountId)).toEqual([]);
      await expect(paper2).toContainText('In sync');
      await expect(paper3).toContainText('In sync');
    } finally {
      await cleanUp(runtime);
    }
  },
);
