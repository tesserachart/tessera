import type { ChartLayer, ChartState, ChartTemplate, Layout } from '@tessera/protocol';
import { Menu, MenuContent, TooltipProvider } from '@tessera/ui';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import { DEFAULT_VIEW, defaultChartState, layoutsStore, putLayout, setStageView } from '../src/state/layouts.ts';
import { answeringClient, seedTools, setTestServices } from './support/runtime.tsx';

vi.mock('../src/workspace/controller.ts', () => ({
  layoutSaved: () => Promise.resolve(),
  updateChart: () => Promise.resolve(),
}));

const { TemplateChip, TemplateMenuRow } = await import('../src/chart/templates/TemplateMenu.tsx');
const { templatesStore } = await import('../src/chart/templates/store.ts');
const { settingsNavStore } = await import('../src/areas/settings/store.ts');
const { TestRuntime } = await import('./support/runtime.tsx');

const LAYOUT = 'chips';
const layer = (id: string, kind: string, params: Record<string, unknown> = {}): ChartLayer => ({
  id,
  kind,
  params: params as ChartLayer['params'],
  visible: true,
  namespace: 'user',
  sessionId: null,
});
const scalp: ChartTemplate = {
  id: 'scalp',
  name: 'Scalp',
  layers: [{ kind: 'ema', params: { inputs: { length: 9 } }, visible: true }],
};
const swing: ChartTemplate = { id: 'swing', name: 'Swing', layers: [{ kind: 'rsi', params: {}, visible: true }] };
const scalpLayers = [layer('ema-1', 'ema', { inputs: { length: 9 } })];

function chartWith(tileId: string, layers: ChartLayer[]): ChartState {
  return { ...defaultChartState(tileId, 'NQ', 'NQZ6.CME', '5m', null), layers };
}

let revision = 0;

function putCharts(charts: Record<string, ChartLayer[]>) {
  revision += 10;
  const layout: Layout = {
    id: LAYOUT,
    name: 'Desk',
    revision,
    updatedAt: 0,
    activeChartId: 'chart-1',
    dock: null,
    trade: null,
    charts: Object.fromEntries(Object.entries(charts).map(([id, layers]) => [id, chartWith(id, layers)])),
  };
  putLayout(layout);
  setStageView(LAYOUT, { ...DEFAULT_VIEW, v: 3 });
}

function mount(answers: Parameters<typeof answeringClient>[0] = {}, extra: ReactNode = null) {
  const { client, calls } = answeringClient(answers);
  setTestServices(client);
  seedTools(['chart.list_templates']);
  render(
    <TestRuntime client={client}>
      <TooltipProvider>
        <div role="toolbar" aria-label="chart-1">
          <TemplateChip chart={{ layoutId: LAYOUT, tileId: 'chart-1' }} />
        </div>
        <div role="toolbar" aria-label="chart-2">
          <TemplateChip chart={{ layoutId: LAYOUT, tileId: 'chart-2' }} />
        </div>
        {extra}
      </TooltipProvider>
    </TestRuntime>,
  );
  return calls;
}

const chip = (tile: string) =>
  within(screen.getByRole('toolbar', { name: tile, hidden: true })).getByRole('button', { hidden: true });
const openChip = (tile: string) => fireEvent.keyDown(chip(tile), { key: 'Enter' });
const item = (name: RegExp) => screen.getByRole('menuitem', { name });
const settle = () => act(async () => {});
const layersOf = (tile: string) => read(layoutsStore).layouts[LAYOUT]!.charts[tile]!.layers.map((l) => l.kind);

beforeEach(() => {
  patch(templatesStore, { templates: [scalp, swing], defaultId: 'scalp', loaded: true, followed: {}, menuFor: null });
});
afterEach(cleanup);

describe('the Template chip in the chart toolbar', () => {
  it('reads each chart’s own template, or None', () => {
    putCharts({ 'chart-1': scalpLayers, 'chart-2': [] });
    mount();
    expect(chip('chart-1').getAttribute('aria-label')).toBe('Template: Scalp');
    expect(chip('chart-2').getAttribute('aria-label')).toBe('Template: None');
  });

  it('lists every template with its one-line summary, the built-in Order flow, the star on the default, then Manage', () => {
    putCharts({ 'chart-1': scalpLayers, 'chart-2': [] });
    mount();
    openChip('chart-1');
    const menu = screen.getByRole('menu', { name: /^Template: / });
    const rows = within(menu)
      .getAllByRole('menuitem')
      .map((r) => r.textContent);
    expect(rows).toEqual([
      'Save as new template…',
      'Rename…',
      'Make a copy…',
      expect.stringMatching(/^ScalpEMA 9/),
      expect.stringMatching(/^SwingRSI/),
      expect.stringMatching(/^Order flowFootprint/),
      'Manage templates…',
    ]);
    expect(item(/^Scalp/).className).toContain('is-on');
    expect(
      within(item(/^Scalp/)).getByRole('button', { name: 'Stop starting new charts with it' }).className,
    ).toContain('on');
    expect(within(item(/^Swing/)).getByRole('button', { name: 'Default for new charts' })).toBeTruthy();
    expect(within(item(/^Order flow/)).queryByRole('button')).toBeNull();
  });

  it('applies a template to its own chart only', async () => {
    putCharts({ 'chart-1': scalpLayers, 'chart-2': [] });
    const calls = mount({
      'chart.apply_template': (input) => ({
        layoutId: LAYOUT,
        revision: revision + 1,
        chart: chartWith(input.tileId!, [layer('rsi-1', 'rsi')]),
      }),
    });
    openChip('chart-2');
    fireEvent.click(item(/^Swing/));
    await settle();
    expect(calls).toEqual([
      { name: 'chart.apply_template', input: { layoutId: LAYOUT, tileId: 'chart-2', template: 'swing' } },
    ]);
    expect(layersOf('chart-2')).toEqual(['rsi']);
    expect(layersOf('chart-1')).toEqual(['ema']);
    expect(chip('chart-2').getAttribute('aria-label')).toBe('Template: Swing');
    expect(chip('chart-1').getAttribute('aria-label')).toBe('Template: Scalp');
  });

  it('marks a chart that left its template as modified, and saves the changes back to it', async () => {
    putCharts({ 'chart-1': scalpLayers, 'chart-2': [] });
    const calls = mount({
      'chart.save_template': () => ({
        template: { ...scalp, layers: [...scalp.layers, { kind: 'rsi', params: {}, visible: true }] },
        replaced: true,
        defaultId: 'scalp',
      }),
    });
    await settle();
    act(() => putCharts({ 'chart-1': [...scalpLayers, layer('rsi-1', 'rsi')], 'chart-2': [] }));
    expect(chip('chart-1').getAttribute('aria-label')).toBe('Template: Scalp · modified');
    expect(chip('chart-1').textContent).toContain('· modified');

    openChip('chart-1');
    expect(screen.queryByRole('menuitem', { name: 'Make a copy…' })).toBeNull();
    fireEvent.click(item(/^Save changes to “Scalp”$/));
    await settle();
    expect(calls).toEqual([
      {
        name: 'chart.save_template',
        input: { layoutId: LAYOUT, tileId: 'chart-1', name: 'Scalp', chartType: 'candles' },
      },
    ]);
    expect(chip('chart-1').getAttribute('aria-label')).toBe('Template: Scalp');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('makes a copy under a free name, and the chart then follows the copy', async () => {
    putCharts({ 'chart-1': scalpLayers, 'chart-2': [] });
    const calls = mount({
      'chart.save_template': (input) => ({
        template: { ...scalp, id: 'scalp-copy', name: input.name },
        replaced: false,
        defaultId: 'scalp',
      }),
    });
    openChip('chart-1');
    fireEvent.click(item(/^Make a copy…$/));
    const name = screen.getByRole('textbox', { name: 'Template name' });
    expect((name as HTMLInputElement).value).toBe('Scalp copy');
    fireEvent.keyDown(name, { key: 'Enter' });
    await settle();
    expect(calls[0]).toEqual({
      name: 'chart.save_template',
      input: { layoutId: LAYOUT, tileId: 'chart-1', name: 'Scalp copy', chartType: 'candles' },
    });
    expect(chip('chart-1').getAttribute('aria-label')).toBe('Template: Scalp copy');
  });

  it('stars a template as the default for new charts', async () => {
    putCharts({ 'chart-1': scalpLayers, 'chart-2': [] });
    const calls = mount({
      'chart.edit_template': () => ({ templates: [scalp, swing], defaultId: 'swing' }),
    });
    openChip('chart-1');
    fireEvent.click(within(item(/^Swing/)).getByRole('button', { name: 'Default for new charts' }));
    await settle();
    expect(calls).toEqual([{ name: 'chart.edit_template', input: { template: 'swing', default: true } }]);
    expect(read(templatesStore).defaultId).toBe('swing');
    expect(screen.getByRole('menu', { name: /^Template: / })).toBeTruthy();
  });

  it('sends Manage templates… to Settings › Chart › Templates', () => {
    putCharts({ 'chart-1': scalpLayers, 'chart-2': [] });
    mount();
    openChip('chart-1');
    fireEvent.click(item(/^Manage templates…$/));
    expect(read(settingsNavStore).target?.id).toBe('chart.templates');
  });
});

describe('the chart menu’s Template row', () => {
  it('names the chart’s template and opens that chart’s chip', async () => {
    vi.useFakeTimers();
    try {
      putCharts({ 'chart-1': scalpLayers, 'chart-2': [] });
      mount(
        {},
        <Menu defaultOpen>
          <MenuContent aria-label="Chart menu">
            <TemplateMenuRow chart={{ layoutId: LAYOUT, tileId: 'chart-2' }} />
          </MenuContent>
        </Menu>,
      );
      const row = within(screen.getByRole('menu', { name: 'Chart menu' })).getByRole('menuitem');
      expect(row.textContent).toBe('Template…None');
      fireEvent.click(row);
      act(() => vi.runAllTimers());
      expect(chip('chart-2').getAttribute('aria-expanded')).toBe('true');
      expect(chip('chart-1').getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });
});
