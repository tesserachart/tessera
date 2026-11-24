import { expect, test } from './support/fixtures.ts';
import { openApp } from './support/launch.ts';
import type { RuntimeRpc } from './support/runtime.ts';

interface Listed {
  id: string;
  kind: string;
  displayName: string;
  health: { status: string };
}

async function connections(runtime: RuntimeRpc): Promise<Listed[]> {
  return (await runtime.tool<{ connections: Listed[] }>('connections.list', {})).connections;
}

async function stateOf(runtime: RuntimeRpc, name: RegExp): Promise<string> {
  const found = (await connections(runtime)).find((c) => name.test(c.displayName));
  return found ? found.health.status : 'gone';
}

async function removeAdded(runtime: RuntimeRpc): Promise<void> {
  for (const c of await connections(runtime))
    if (c.id !== 'paper' && !c.id.startsWith('mock')) await runtime.tool('connections.remove', { id: c.id });
}

const RITHMIC_NAME = /Tessera Test/;
const RITHMIC_MARKS = /^Trading Platform by Rithmic Powered by OMNE$/;

test(
  'a Rithmic login is added, tested, changed, disconnected and removed from Settings › Connections, and the status bar and its Rithmic marks follow',
  { requires: ['browser'], tags: ['connections'] },
  async ({ app, browser, screen, runtime }) => {
    try {
      await openApp(app, browser);
      await expect(screen.getByRole('navigation', 'Areas')).toBeVisible();
      const status = screen.getByRole('navigation', 'Connection status');
      await expect(status.getByRole('button', /^Mock market: /)).toBeVisible();
      await expect(status.getByRole('button', RITHMIC_NAME)).toHaveCount(0);
      const marks = screen.getByRole('contentinfo', 'Status and notices').getByRole('button', RITHMIC_MARKS);
      await expect(marks).toHaveCount(0);

      await screen.getByRole('navigation', 'Areas').getByRole('button', 'Settings').tap();
      const nav = screen.getByRole('navigation', 'Settings');
      await nav.getByRole('button', 'Connections').tap();
      await expect(nav.getByRole('button', 'Connections')).toHaveAttribute('aria-current', 'page');
      const list = screen.getByRole('region', 'Your connections');
      await expect(list).toContainText('Paper trading');

      await list.getByRole('button', 'Add connection').tap();
      await screen.getByRole('menuitem', /^Rithmic…/).tap();
      const add = screen.getByRole('region', 'Add a Rithmic login');
      const form = add.getByRole('form', 'Rithmic login');
      await form.getByRole('button', 'Firm').tap();
      await screen.getByRole('option', 'Tessera Test').tap();
      await expect(form.getByRole('combobox', 'Gateway')).toContainText('Chicago Area');
      await form.getByRole('textbox', 'User').fill('demo-trader');
      await form.getByRole('textbox', 'Password').fill('not-it');
      await form.getByRole('button', 'Test').tap();
      await expect(form.getByRole('status')).toContainText('Nothing saved');
      await form.getByRole('textbox', 'Password').fill('demo');
      await form.getByRole('button', 'Test and save').tap();

      const row = list.getByRole('group', RITHMIC_NAME).first();
      await expect(add).toHaveCount(0);
      await expect.poll(() => stateOf(runtime, RITHMIC_NAME), { timeout: 15_000 }).toBe('ok');
      await expect(status.getByRole('button', RITHMIC_NAME)).toContainText(/\d+ ms/);
      await expect(marks).toBeVisible();
      await marks.tap();
      await expect(nav.getByRole('button', 'App')).toHaveAttribute('aria-current', 'page');
      await expect(screen.getByRole('region', 'Notices')).toContainText('The R | Protocol API™ software is Copyright');
      await nav.getByRole('button', 'Connections').tap();

      await list.getByRole('button', 'Test').first().tap();
      await expect(list).not.toContainText('Checking the login');

      await list.getByRole('button', 'Edit').first().tap();
      const edit = screen.getByRole('group', /^Edit Tessera Test/);
      await edit.getByRole('textbox', 'Password').fill('demo');
      await edit.getByRole('button', 'Replace').tap();
      await expect(edit).toHaveCount(0);
      await expect.poll(() => stateOf(runtime, RITHMIC_NAME), { timeout: 15_000 }).toBe('ok');

      await list.getByRole('button', 'Disconnect').tap();
      await expect.poll(() => stateOf(runtime, RITHMIC_NAME), { timeout: 15_000 }).toBe('disconnected');
      await expect(list.getByRole('button', 'Connect')).toBeVisible();
      await expect(status.getByRole('button', RITHMIC_NAME)).toHaveAttribute('data-status', 'disconnected');
      await expect(marks).toHaveCount(0);

      await list.getByRole('button', 'Connect').tap();
      await expect.poll(() => stateOf(runtime, RITHMIC_NAME), { timeout: 15_000 }).toBe('ok');
      await expect(status.getByRole('button', RITHMIC_NAME)).toHaveAttribute('data-status', 'ok');
      await expect(marks).toBeVisible();

      await status.getByRole('button', RITHMIC_NAME).tap();
      await list.getByRole('button', 'Edit').first().tap();
      await screen
        .getByRole('group', /^Edit Tessera Test/)
        .getByRole('button', 'Remove')
        .tap();
      await screen
        .getByRole('group', 'Confirm')
        .getByRole('button', /Remove/)
        .tap();
      await expect.poll(() => stateOf(runtime, RITHMIC_NAME), { timeout: 15_000 }).toBe('gone');
      await expect(status.getByRole('button', RITHMIC_NAME)).toHaveCount(0);
      await expect(marks).toHaveCount(0);
      await expect(row).toHaveCount(0);
    } finally {
      await removeAdded(runtime);
    }
  },
);
