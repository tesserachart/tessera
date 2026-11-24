import type { Layout } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { read, write } from '../src/app/store.ts';
import { defaultChartState, layoutsStore, patchChart, putLayout, savingLayout } from '../src/state/layouts.ts';
import { newWorkspaceLayout } from '../src/workspace/layouts.ts';

function twoCharts(id: string, revision: number): Layout {
  const base = newWorkspaceLayout(id, revision, { instrument: 'NQ' });
  return {
    ...base,
    revision,
    charts: { ...base.charts, 'chart-2': defaultChartState('chart-2', 'Chart 2', 'NQ', '1m') },
  };
}

const chart = (id: string, tile: string) => read(layoutsStore).layouts[id]?.charts[tile];

describe('layout echoes', () => {
  it('a save coming back never undoes an edit made while it was on its way', () => {
    write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
    const id = 'echo-a';
    putLayout(twoCharts(id, 1));
    patchChart(id, 'chart-1', (c) => ({ ...c, timeframe: '15m' }));
    const sent = read(layoutsStore).layouts[id]!;
    const done = savingLayout(id, { charts: sent.charts, view: null, activeChartId: undefined });
    patchChart(id, 'chart-1', (c) => ({ ...c, timeframe: '1h' }));
    putLayout({ ...sent, revision: 2 });
    expect(chart(id, 'chart-1')?.timeframe).toBe('1h');
    done();
    putLayout({ ...sent, revision: 2 });
    expect(chart(id, 'chart-1')?.timeframe).toBe('1h');
  });

  it("another window's or an agent's change to another chart still lands meanwhile", () => {
    write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
    const id = 'echo-b';
    const start = twoCharts(id, 1);
    putLayout(start);
    patchChart(id, 'chart-1', (c) => ({ ...c, timeframe: '15m' }));
    putLayout({
      ...start,
      revision: 2,
      charts: { ...start.charts, 'chart-2': { ...start.charts['chart-2']!, instrument: 'ES' } },
    });
    expect(chart(id, 'chart-1')?.timeframe).toBe('15m');
    expect(chart(id, 'chart-2')?.instrument).toBe('ES');
    expect(read(layoutsStore).layouts[id]?.revision).toBe(2);
  });

  it('a change from elsewhere to a chart this window holds as saved is applied', () => {
    write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
    const id = 'echo-c';
    const start = twoCharts(id, 1);
    putLayout(start);
    const done = savingLayout(id, { charts: start.charts, view: null, activeChartId: undefined });
    done();
    putLayout({
      ...start,
      revision: 3,
      charts: { ...start.charts, 'chart-1': { ...start.charts['chart-1']!, instrument: 'SPY' } },
    });
    expect(chart(id, 'chart-1')?.instrument).toBe('SPY');
  });

  it('a chart the window dropped does not come back with an older echo', () => {
    write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
    const id = 'echo-d';
    const start = twoCharts(id, 1);
    putLayout(start);
    const done = savingLayout(id, {
      charts: { 'chart-1': start.charts['chart-1']! },
      view: null,
      activeChartId: undefined,
    });
    expect(chart(id, 'chart-2')).toBeUndefined();
    putLayout({ ...start, revision: 2 });
    expect(chart(id, 'chart-2')).toBeUndefined();
    done();
  });
});
