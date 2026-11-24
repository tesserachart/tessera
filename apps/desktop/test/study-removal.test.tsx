import type { ChartLayer, Layout } from '@tessera/protocol';
import { Menu, MenuContent, MenuTrigger, TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDockview, type DockviewApi } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import { IndicatorLegend } from '../src/chart/settings/IndicatorLegend.tsx';
import { IndicatorMenuItems } from '../src/chart/settings/IndicatorMenu.tsx';
import { closeIndicatorSettings, indicatorUiStore } from '../src/chart/settings/store.ts';
import { defaultChartState, layoutsStore, putLayout, useChartState } from '../src/state/layouts.ts';
import { attachWorkspace, layoutSaved } from '../src/workspace/controller.ts';
import { buildDockFromLayout } from '../src/workspace/layouts.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { actPause } from './support/pause.ts';
import '../src/workspace/tiles/index.ts';

const LAYOUT = 'desk';
const TILE = 'chart-1';
const chart = { layoutId: LAYOUT, tileId: TILE };
const KINDS = ['volume', 'vwap', 'footprint', 'volume_profile', 'big_trades'] as const;

type Saved = { charts: Record<string, { layers: ChartLayer[] }> };

const cleanups: (() => void)[] = [];
let saves: Saved[] = [];

const layer = (kind: string): ChartLayer => ({
  id: `${kind}-1`,
  kind,
  params: {},
  visible: true,
  namespace: 'user',
  sessionId: null,
});

function layoutOf(revision: number, layers: readonly ChartLayer[]): Layout {
  return {
    id: LAYOUT,
    name: LAYOUT,
    revision,
    updatedAt: 0,
    activeChartId: TILE,
    dock: null,
    trade: null,
    charts: { [TILE]: { ...defaultChartState(TILE, 'Chart 1', 'NQZ6.CME', '5m', null), layers: [...layers] } },
  };
}

function mountWorkspace(layers: readonly ChartLayer[]): void {
  let revision = 1;
  fakeRuntime({
    answers: {
      'layout.save': (input) => {
        saves.push(structuredClone(input) as unknown as Saved);
        return { layoutId: LAYOUT, revision: ++revision };
      },
    },
  });
  const layout = layoutOf(revision, layers);
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
      tools: new Set(['layout.save']),
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

function LayersMenu() {
  const layers = useChartState(LAYOUT, TILE)?.layers ?? [];
  return (
    <TooltipProvider>
      <Menu open>
        <MenuTrigger>Layers</MenuTrigger>
        <MenuContent>
          <IndicatorMenuItems chart={chart} layers={layers} add={false} />
        </MenuContent>
      </Menu>
    </TooltipProvider>
  );
}

const lastSave = () => saves[saves.length - 1]!.charts[TILE]!.layers;
const savedLayer = (kind: string) => lastSave().find((l) => l.kind === kind);
const row = (name: RegExp | string) => screen.getByRole('button', { name: new RegExp(`^${String(name)}.*: menu$`) });
const rowOf = (el: HTMLElement) => el.closest('[data-layer]')!;
const rows = () => [...document.querySelectorAll('[data-layer]')].map((r) => r.getAttribute('data-layer'));

function openMenu(label: HTMLElement) {
  fireEvent.pointerDown(label, { button: 0, ctrlKey: false });
}

async function settled() {
  await act(async () => {
    await layoutSaved();
  });
}

beforeEach(() => {
  saves = [];
  mountWorkspace(KINDS.map(layer));
});

afterEach(() => {
  cleanup();
  for (const c of cleanups.splice(0)) c();
  act(() => closeIndicatorSettings());
  patch(layoutsStore, { layouts: {}, views: {} });
  document.body.innerHTML = '';
});

describe('removing and hiding a study from its legend row', () => {
  it('offers Settings, Hide and Remove from the label, and saves Hide then Show', async () => {
    render(<Legend />);
    openMenu(row('VP'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Settings…', 'Hide', 'Remove']);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Hide' }));
    await settled();
    expect(savedLayer('volume_profile')?.visible).toBe(false);
    expect(rowOf(row('VP')).classList.contains('is-off')).toBe(true);

    openMenu(row('VP'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show' }));
    await settled();
    expect(savedLayer('volume_profile')?.visible).toBe(true);
    expect(rowOf(row('VP')).classList.contains('is-off')).toBe(false);
  });

  it('removes Footprint from a right-click on its row, and stays removed on the next start', async () => {
    render(<Legend />);
    expect(rows()).toContain('footprint-1');
    fireEvent.contextMenu(rowOf(row('Footprint')).querySelector('.vals')!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await settled();

    expect(lastSave().map((l) => l.kind)).toEqual(['volume', 'vwap', 'volume_profile', 'big_trades']);
    expect(rows()).not.toContain('footprint-1');

    const next = structuredClone(lastSave());
    cleanup();
    patch(layoutsStore, { layouts: {}, views: {} });
    putLayout(layoutOf(9, next));
    render(<Legend />);
    expect(rows()).toEqual(['volume-1', 'vwap-1', 'volume_profile-1', 'big_trades-1']);
    expect(screen.queryByRole('button', { name: /^Footprint/ })).toBeNull();
  });

  it('keeps the chart’s own menu closed on a right-click of a row', () => {
    let reached = false;
    render(
      <div onContextMenu={() => (reached = true)}>
        <Legend />
      </div>,
    );
    fireEvent.contextMenu(rowOf(row('Footprint')));
    expect(reached).toBe(false);
  });

  it('opens the menu from the keyboard and removes with Delete', async () => {
    render(<Legend />);
    const label = row('VP');
    label.focus();
    fireEvent.keyDown(label, { key: 'Enter' });
    expect(await screen.findByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.keyDown(label, { key: 'Delete' });
    await settled();
    expect(lastSave().map((l) => l.kind)).not.toContain('volume_profile');
  });

  it('opens the study’s settings from the menu and keeps them open', async () => {
    render(<Legend />);
    openMenu(row('VP'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Settings…' }));
    expect(await screen.findByRole('dialog', { name: 'Volume profile settings' })).toBeTruthy();
    expect(read(indicatorUiStore).editing?.layerId).toBe('volume_profile-1');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await actPause();
    expect(screen.getByRole('dialog', { name: 'Volume profile settings' })).toBeTruthy();
    expect(read(indicatorUiStore).editing?.layerId).toBe('volume_profile-1');
  });
});

describe('the Layers menu with order-flow studies', () => {
  it('lists every study with its toggle, hides Big trades and removes it, saving each', async () => {
    render(<LayersMenu />);
    const boxes = screen.getAllByRole('menuitemcheckbox');
    expect(boxes.map((b) => b.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('VP'),
        expect.stringContaining('Footprint'),
        expect.stringContaining('Big trades'),
        expect.stringContaining('VWAP'),
      ]),
    );
    expect(boxes).toHaveLength(KINDS.length);
    for (const b of boxes) expect(b.getAttribute('aria-checked')).toBe('true');

    const big = screen.getByRole('menuitemcheckbox', { name: /Big trades/ });
    fireEvent.click(big);
    await settled();
    expect(savedLayer('big_trades')?.visible).toBe(false);
    expect(screen.getByRole('menuitemcheckbox', { name: /Big trades/ }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: /^Remove Big trades/ }));
    await settled();
    expect(lastSave().map((l) => l.kind)).not.toContain('big_trades');
    expect(screen.queryByRole('menuitemcheckbox', { name: /Big trades/ })).toBeNull();
  });
});
