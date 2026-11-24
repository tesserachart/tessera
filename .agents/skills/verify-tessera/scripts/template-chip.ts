#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Locator } from 'playwright';
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, out = '.e2e/artifacts/verify/template-chip'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port)) {
  console.error('usage: template-chip.ts <port> [evidence dir]');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });

interface Templates {
  templates: { id: string; name: string; layers: { kind: string }[] }[];
  defaultId?: string;
}
interface LayoutOut {
  id: string;
  charts: Record<string, { instrument: string; layers: { id: string; kind: string }[] }>;
}

const info = await readRuntimeInfo(`http://127.0.0.1:${port}`);
const rpc = await RuntimeRpc.open(info);
const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await rpc.tool<{ accounts: { account: { environment: string } }[] }>('portfolio.get_accounts', {});
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  console.error('refused: not the sim runtime');
  process.exit(1);
}

const { activeId: activeLayoutId } = await rpc.tool<{ activeId: string }>('layout.list', {});
const layout = () => rpc.tool<LayoutOut>('layout.get', { layoutId: activeLayoutId });
const kinds = async (tile: string) => ((await layout()).charts[tile]?.layers ?? []).map((l) => l.kind);
const templates = () => rpc.tool<Templates>('chart.list_templates', {});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const failures: string[] = [];
const report = (line: string) => console.info(line);
const expectThat = (ok: boolean, what: string) => {
  report(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const shot = (name: string, clip?: Locator) =>
  (clip ? clip.screenshot({ path: join(dir, name) }) : page.screenshot({ path: join(dir, name) })).catch(() =>
    report(`(no screenshot ${name})`),
  );
const until = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  for (const end = Date.now() + timeoutMs; !(await check().catch(() => false)); await page.waitForTimeout(250))
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
};

try {
  await page.goto(`${info.origin}/#ticket=${encodeURIComponent(info.ticket ?? '')}`, { timeout: 180_000 });
  const chips = page.getByRole('button', { name: /^Template: / });
  await until(async () => (await chips.count()) >= 2, 180_000, 'a Template chip on each chart');
  const charts = Object.keys((await layout()).charts).sort();
  const [first, second] = charts as [string, string];
  report(`charts: ${charts.join(', ')}`);
  const chipOf = (i: number) => page.locator('.ctl-tpl').nth(i);
  const toolbarOf = (i: number) => page.locator('.chart-tools').nth(i);
  const labelOf = (i: number) => chipOf(i).getAttribute('aria-label');

  expectThat((await labelOf(0)) === 'Template: None', `chart 1 chip reads None (${await labelOf(0)})`);
  expectThat((await labelOf(1)) === 'Template: None', `chart 2 chip reads None (${await labelOf(1)})`);
  await shot('1-toolbar.png', toolbarOf(0));

  await chipOf(0).click();
  const menu = page.getByRole('menu', { name: /^Template: / });
  await menu.waitFor();
  const rows = await menu.getByRole('menuitem').allTextContents();
  report(`menu rows: ${rows.join(' | ')}`);
  expectThat(rows.includes('Save as new template…'), 'the menu offers Save as new template…');
  expectThat(rows.at(-1) === 'Manage templates…', 'the menu ends with Manage templates…');
  await shot('2-menu.png');

  const standard = menu.getByRole('menuitem', { name: /^Standard/ });
  await standard.click();
  await until(async () => (await labelOf(0)) === 'Template: Standard', 15_000, 'chart 1 reads Standard');
  const firstKinds = await kinds(first);
  const secondKinds = await kinds(second);
  expectThat(firstKinds.join(',') === 'volume,vwap', `chart 1 holds Standard's studies (${firstKinds.join(',')})`);
  expectThat(secondKinds.length === 0, `chart 2 is untouched (${secondKinds.join(',') || 'no layers'})`);
  expectThat((await labelOf(1)) === 'Template: None', 'chart 2 chip still reads None');

  const vwap = (await layout()).charts[first]!.layers.find((l) => l.kind === 'vwap')!;
  await rpc.tool('chart.remove_layer', { layoutId: activeLayoutId, tileId: first, layerId: vwap.id });
  await until(async () => (await labelOf(0)) === 'Template: Standard · modified', 15_000, 'chart 1 reads modified');
  report('ok   chart 1 reads Standard · modified after its VWAP went');
  await shot('3-modified.png', toolbarOf(0));

  await chipOf(0).click();
  await menu.waitFor();
  expectThat(
    (await menu.getByRole('menuitem', { name: 'Save changes to “Standard”' }).count()) === 1,
    'a modified chart offers Save changes to “Standard”',
  );
  await shot('4-modified-menu.png');
  await menu.getByRole('menuitem', { name: 'Save as new template…' }).click();
  await page.getByRole('textbox', { name: 'Template name' }).fill('Lean');
  await page.getByRole('textbox', { name: 'Template name' }).press('Enter');
  await until(async () => (await labelOf(0)) === 'Template: Lean', 15_000, 'chart 1 reads Lean');
  const lean = (await templates()).templates.find((t) => t.name === 'Lean');
  expectThat(lean?.layers.map((l) => l.kind).join(',') === 'volume', 'the runtime stores Lean with Volume alone');

  await menu.waitFor({ state: 'hidden' });
  await chipOf(0).click();
  await menu.waitFor();
  const leanRow = menu.getByRole('menuitem', { name: /^Lean/ });
  await leanRow.hover();
  await shot('5-star-hover.png');
  await leanRow.getByRole('button', { name: 'Default for new charts' }).click();
  await until(async () => (await templates()).defaultId === lean?.id, 15_000, 'Lean is the default');
  report('ok   the star makes Lean the default for new charts');
  await shot('6-starred.png');
  await page.keyboard.press('Escape');

  const canvas = page.getByRole('region', { name: /^ES Z6 1m$/ });
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const chartMenu = page.getByRole('menu', { name: 'Chart menu' });
  await chartMenu.waitFor();
  await chartMenu.getByRole('menuitem', { name: /^Layers/ }).hover();
  const layers = page.getByRole('menu').last();
  await layers.getByRole('menuitem', { name: /^Template…/ }).waitFor();
  expectThat(
    (await page.getByRole('menuitem', { name: /^Templates/ }).count()) === 0,
    'Layers has no Templates submenu any more',
  );
  await shot('7-layers-row.png');
  await layers.getByRole('menuitem', { name: /^Template…/ }).click();
  await until(async () => (await chipOf(1).getAttribute('aria-expanded')) === 'true', 5_000, 'chart 2 chip opens');
  report('ok   Layers › Template… opens chart 2’s chip menu');
  expectThat((await chipOf(0).getAttribute('aria-expanded')) === 'false', 'chart 1 chip stays closed');
  await shot('8-from-layers.png');
  await page.keyboard.press('Escape');

  await toolbarOf(0).getByRole('button', { name: 'Indicators' }).click();
  const target = page.getByRole('button', { name: /^On / });
  await target.click();
  await page.getByRole('menu').last().waitFor();
  expectThat(
    (await page.getByRole('menuitem', { name: /^Templates/ }).count()) === 0,
    'the Indicators panel’s chart menu has no Templates submenu',
  );
  await page.keyboard.press('Escape');

  await chipOf(0).click();
  await menu.getByRole('menuitem', { name: 'Manage templates…' }).click();
  const section = page.locator('[data-setting="chart.template.lean"]');
  await until(() => section.isVisible(), 15_000, 'Settings › Chart › Templates shows Lean');
  report('ok   Manage templates… opens Settings › Chart › Templates');
  await shot('9-manage.png');

  writeFileSync(join(dir, 'chart.list_templates.json'), JSON.stringify(await templates(), null, 2));
  writeFileSync(join(dir, 'layout.get.json'), JSON.stringify(await layout(), null, 2));
} catch (err) {
  failures.push(String(err));
  report(`FAIL ${String(err)}`);
  await shot('failure.png');
} finally {
  await browser.close();
  rpc.close();
}
report(failures.length === 0 ? 'template chip: all checks passed' : `template chip: ${String(failures.length)} failed`);
process.exit(failures.length === 0 ? 0 : 1);
