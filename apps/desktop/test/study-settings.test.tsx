import type { ChartLayer, Layout } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDockview, type DockviewApi } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import { setThemeSettings } from '../src/theme/store.ts';
import { IndicatorLegend } from '../src/chart/settings/IndicatorLegend.tsx';
import { closeIndicatorSettings } from '../src/chart/settings/store.ts';
import { defaultChartState, layoutsStore, putLayout, useChartState } from '../src/state/layouts.ts';
import { attachWorkspace, layoutSaved } from '../src/workspace/controller.ts';
import { buildDockFromLayout } from '../src/workspace/layouts.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import '../src/workspace/tiles/index.ts';

const LAYOUT = 'desk';
const TILE = 'chart-1';

type Saved = { charts: Record<string, { layers: ChartLayer[] }> };

const cleanups: (() => void)[] = [];
let saves: Saved[] = [];
let themeWrites: unknown[] = [];

const bigTrades: ChartLayer = {
  id: 'big_trades-1',
  kind: 'big_trades',
  params: {},
  visible: true,
  namespace: 'user',
  sessionId: null,
};

function mount(): void {
  let revision = 1;
  fakeRuntime({
    answers: {
      'layout.save': (input) => {
        saves.push(structuredClone(input) as unknown as Saved);
        return { layoutId: LAYOUT, revision: ++revision };
      },
      'settings.set': (input) => {
        themeWrites.push(input.value);
        return { key: input.key, value: input.value, previous: null };
      },
    },
  });
  const layout: Layout = {
    id: LAYOUT,
    name: LAYOUT,
    revision,
    updatedAt: 0,
    activeChartId: TILE,
    dock: null,
    trade: null,
    charts: { [TILE]: { ...defaultChartState(TILE, 'Chart 1', 'NQZ6.CME', '5m', null), layers: [bigTrades] } },
  };
  putLayout(layout);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const api: DockviewApi = createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
  buildDockFromLayout(api, layout);
  cleanups.push(
    attachWorkspace({
      api,
      layoutId: LAYOUT,
      tools: new Set(['layout.save', 'settings.set']),
      reload: () => undefined,
      canSaveDock: () => true,
      allowDockSaves: () => undefined,
    }),
  );
}

function Legend() {
  const layers = useChartState(LAYOUT, TILE)?.layers ?? [];
  return (
    <TooltipProvider>
      <IndicatorLegend chart={null} layoutId={LAYOUT} tileId={TILE} layers={layers} precision={2} />
    </TooltipProvider>
  );
}

const agentChangesLayer = (params: ChartLayer['params']) =>
  act(() => {
    const s = read(layoutsStore);
    const layout = s.layouts[LAYOUT]!;
    const chart = layout.charts[TILE]!;
    patch(layoutsStore, {
      layouts: {
        ...s.layouts,
        [LAYOUT]: {
          ...layout,
          charts: { ...layout.charts, [TILE]: { ...chart, layers: chart.layers.map((l) => ({ ...l, params })) } },
        },
      },
    });
  });

beforeEach(() => {
  saves = [];
  themeWrites = [];
  setThemeSettings({ active: {} });
  mount();
});

afterEach(() => {
  cleanup();
  for (const c of cleanups.splice(0)) c();
  act(() => closeIndicatorSettings());
  patch(layoutsStore, { layouts: {}, views: {} });
  setThemeSettings({ active: {} });
  document.body.innerHTML = '';
});

describe('a study’s settings', () => {
  it('open in one modal with Inputs and Style, and show what the agent changed as Modified until Reset', async () => {
    render(<Legend />);
    fireEvent.click(screen.getByRole('button', { name: /^Big trades.*: settings$/ }));
    const modal = await screen.findByRole('dialog', { name: 'Big trades settings' });
    const preset = () => within(modal).getByRole('status', { name: 'Preset' }).textContent;
    expect(within(modal).getByRole('group', { name: 'Settings' })).toBeTruthy();
    expect(preset()).toBe('');
    expect(modal.textContent).toContain('You can also ask your agent to change this.');

    act(() => setThemeSettings({ active: { bigTrades: { buy: '#00ffff' } } }));
    fireEvent.click(within(modal).getByRole('button', { name: 'Style' }));
    const colours = within(modal).getByRole('group', { name: 'Colours' });
    expect(within(colours).getByRole('button', { name: /^Big buys: #00ffff/ })).toBeTruthy();
    expect(preset()).toBe('Modified');

    fireEvent.click(within(modal).getByRole('button', { name: 'Inputs' }));
    agentChangesLayer({ inputs: { size: 'fixed', minSize: 40 } });
    expect(within(modal).getByRole<HTMLInputElement>('textbox', { name: 'At least' }).value).toBe('40');
    expect(preset()).toBe('Modified');

    fireEvent.pointerDown(within(modal).getByRole('button', { name: 'Defaults' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset settings' }));
    await waitFor(() =>
      expect(read(layoutsStore).layouts[LAYOUT]!.charts[TILE]!.layers[0]!.params).not.toMatchObject({
        inputs: { size: 'fixed', minSize: 40 },
      }),
    );
    expect(themeWrites).toContainEqual({ bigTrades: { buy: null } });
    act(() => setThemeSettings({ active: {} }));
    await waitFor(() => expect(preset()).toBe(''));
    expect(within(modal).getAllByText('Defaults')).toHaveLength(1);
    expect(within(modal).queryByRole('textbox', { name: 'At least' })).toBeNull();
    expect(within(modal).getByRole('button', { name: 'Auto', pressed: true })).toBeTruthy();
  });

  it('saves what the user types to the layout the agent’s read tools answer from', async () => {
    render(<Legend />);
    fireEvent.click(screen.getByRole('button', { name: /^Big trades.*: settings$/ }));
    const modal = await screen.findByRole('dialog', { name: 'Big trades settings' });
    fireEvent.click(within(modal).getByRole('button', { name: 'Fixed' }));
    fireEvent.change(within(modal).getByRole('textbox', { name: 'At least' }), { target: { value: '25' } });
    await act(async () => {
      await layoutSaved();
    });
    const layer = saves.at(-1)!.charts[TILE]!.layers.find((l) => l.id === bigTrades.id)!;
    expect((layer.params as { inputs?: { size?: string; minSize?: number } }).inputs).toMatchObject({
      size: 'fixed',
      minSize: 25,
    });
    expect(within(modal).getByRole('status', { name: 'Preset' }).textContent).toBe('Modified');
  });
});
