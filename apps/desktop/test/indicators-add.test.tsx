import type { ChartLayer } from '@tessera/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import { IndicatorsPanel } from '../src/areas/indicators/IndicatorsPanel.tsx';
import { pageStore } from '../src/areas/indicators/model.ts';
import { customStore } from '../src/indicators/custom.ts';
import { defaultChartState, layoutsStore, putLayout } from '../src/state/layouts.ts';
import { setActiveChartRef } from '../src/state/workspace.ts';
import { heldReads, mountSurface, settle, SIM, unmountSurface } from './support/loading.tsx';

vi.mock('../src/areas/indicators/PreviewChart.tsx', () => ({ PreviewChart: () => null }));

const chart = { layoutId: 'desk', tileId: 'chart-1' };

beforeEach(() => {
  patch(customStore, { byId: {}, list: [], loaded: false, problems: {} });
  patch(pageStore, {
    selection: { kind: 'builtin', key: 'footprint' },
    drafts: {},
    runs: {},
    inputs: {},
    busy: {},
    saveProblems: {},
    saved: {},
  });
  seed([]);
  setActiveChartRef({ ...chart, source: null });
});

function seed(layers: ChartLayer[]) {
  putLayout({
    id: chart.layoutId,
    name: 'Desk',
    revision: 1,
    updatedAt: 0,
    activeChartId: chart.tileId,
    dock: null,
    trade: null,
    charts: { [chart.tileId]: { ...defaultChartState(chart.tileId, 'Chart 1', 'NQZ6.CME', '1m', null), layers } },
  });
}

afterEach(() => {
  unmountSurface();
  setActiveChartRef(null);
  patch(layoutsStore, { layouts: {}, views: {} });
});

async function mount() {
  const held = heldReads(SIM);
  mountSurface(held.client, <IndicatorsPanel />, { tools: Object.keys(SIM.tools), shell: null });
  for (let i = 0; i < 20 && held.waiting > 0; i++) {
    held.answerNext();
    await settle();
  }
}

const footprints = () =>
  read(layoutsStore).layouts[chart.layoutId]!.charts[chart.tileId]!.layers.filter((l) => l.kind === 'footprint');
const catalogRow = () =>
  within(screen.getByRole('complementary', { name: 'Indicators' })).getByRole('button', { name: /^Footprint/ });

describe('Add to chart in the study library', () => {
  it('says the study went on the active chart, offers another, and marks its row in the list', async () => {
    await mount();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    expect(catalogRow().textContent).not.toMatch(/on chart/);

    fireEvent.click(screen.getByRole('button', { name: 'Add to chart' }));
    await act(async () => undefined);
    expect(footprints()).toHaveLength(1);
    expect(status.textContent).toBe('Added to NQZ6.CME · 1m');
    expect(screen.queryByRole('button', { name: 'Add to chart' })).toBeNull();
    expect(catalogRow().textContent).toMatch(/on chart$/);

    fireEvent.click(screen.getByRole('button', { name: 'Add another' }));
    await act(async () => undefined);
    expect(footprints()).toHaveLength(2);
    expect(catalogRow().textContent).toMatch(/2 on chart$/);
  });

  it('opens on a study already on the chart as on it, with Add another', async () => {
    seed([{ id: 'fp-1', kind: 'footprint', params: {}, visible: true, namespace: 'user', sessionId: null }]);
    await mount();
    expect(screen.getByRole('status').textContent).toBe('On NQZ6.CME · 1m');
    expect(screen.getByRole('button', { name: 'Add another' })).toBeTruthy();
    expect(catalogRow().textContent).toMatch(/on chart$/);
  });
});
