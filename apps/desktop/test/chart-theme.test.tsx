import type * as LevelSettingsModule from '../src/chart/levelSettings.ts';
import type * as ChartModule from '@tessera/chart';
import type { ChartOptions, ChartTheme } from '@tessera/chart';
import { THEME_TABLES, COLOR_SWATCHES, type SettingsEvent } from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { read } from '../src/app/store.ts';
import type { FakeClient } from './support/runtime.tsx';

const applied: Partial<ChartTheme>[] = [];
vi.mock('@tessera/chart', async (original) => {
  const real = await original<typeof ChartModule>();
  return {
    ...real,
    createChart: (_host: unknown, options: ChartOptions) => {
      if (options.theme) applied.push(options.theme);
      return {
        addLayer: () => undefined,
        removeLayer: () => undefined,
        getLayer: () => null,
        layers: () => [],
        on: () => () => undefined,
        setLayerVisible: () => undefined,
        setSuspended: () => undefined,
        setOptions: (o: Partial<ChartOptions>) => {
          if (o.theme) applied.push(o.theme);
        },
        getSeries: () => null,
        getViewport: () => ({ asked: null }),
        destroy: () => undefined,
      };
    },
  };
});
vi.mock('../src/chart/feed.ts', () => ({
  ChartFeed: class {
    load = (): void => undefined;
    dispose = (): void => undefined;
  },
}));
vi.mock('../src/market/flow/hub.ts', () => ({ flowHub: () => null }));
vi.mock('../src/chart/useLevelSources.ts', async () => {
  const { defsOf, sourceDefs } = await vi.importActual<typeof LevelSettingsModule>('../src/chart/levelSettings.ts');
  const sources = sourceDefs([]);
  return { useLevelSources: () => ({ sources, defs: defsOf(sources) }) };
});
vi.mock('../src/workspace/controller.ts', () => ({ updateChart: () => Promise.resolve() }));

const { ChartView } = await import('../src/chart/ChartView.tsx');
const { TestRuntime } = await import('./support/runtime.tsx');
const { useWindowSettings } = await import('../src/state/settingsSync.ts');
const { chartThemeOf, resolveChartTheme, chartThemeStore, swatchesFor, swatchesOf } =
  await import('../src/chart/chartTheme.ts');
const { setThemeSettings } = await import('../src/theme/store.ts');
const { TESSERA_THEME } = await import('@tessera/chart');

function fakeClient() {
  let push: ((ev: SettingsEvent) => void) | null = null;
  const client = {
    subscribe: (topic: string, _params: unknown, handler: (ev: SettingsEvent) => void) => {
      if (topic === 'settings') push = handler;
      return () => undefined;
    },
  } as unknown as FakeClient;
  return { client, emit: (ev: SettingsEvent) => push?.(ev), subscribed: () => push !== null };
}

function Charts() {
  useWindowSettings();
  return (
    <ChartView
      layoutId="l1"
      tileId="c1"
      instrument="QQQ"
      tf="5m"
      spec={null}
      layers={[]}
      levels={[]}
      annotations={[]}
      reportViewport={false}
      precision={2}
    />
  );
}

afterEach(() => {
  cleanup();
  applied.length = 0;
  setThemeSettings({ active: {}, saved: {} });
});

describe('appearance.theme on the chart', () => {
  it('reaches the theme every chart draws with the moment the settings topic brings it', async () => {
    const { client, emit, subscribed } = fakeClient();
    const clock = { now: () => Date.UTC(2026, 9, 8, 15) } as never;
    render(
      <TestRuntime client={client} clock={clock}>
        <Charts />
      </TestRuntime>,
    );
    const deliver = async (ev: SettingsEvent) => {
      await act(async () => {
        emit(ev);
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    await vi.waitFor(() => expect(subscribed()).toBe(true));
    expect(applied[0]?.background).toBe(TOKENS.ink);
    await deliver({
      type: 'changed',
      key: 'appearance.theme',
      value: {
        palette: { background: '#101418' },
        candles: { upWick: '#ffffff' },
        canvas: { gridVertical: '#ffffff10' },
      },
    });
    const last = applied.at(-1)!;
    expect(last.background).toBe('#101418');
    expect(last.upWick).toBe('#ffffff');
    expect(last.upFill).toBe(TOKENS.up);
    expect(last.gridVertical).toBe('rgba(255,255,255,0.063)');
    await deliver({ type: 'changed', key: 'appearance.theme', value: { chartPreset: 'classic' } });
    expect(applied.at(-1)!.background).toBe('#131722');
    expect(applied.at(-1)!.upFill).toBe('#26a69a');
    await deliver({ type: 'changed', key: 'appearance.theme', value: { preset: 'solarized-light' } });
    expect(applied.at(-1)!.background).toBe('#fdf6e3');
    expect(applied.at(-1)!.upFill).toBe('#1f877f');
    await deliver({
      type: 'changed',
      key: 'appearance.themes',
      value: { themes: [{ id: 'th-1', name: 'Night Desk', theme: { preset: 'night-owl' } }] },
    });
    await deliver({ type: 'changed', key: 'appearance.theme', value: { saved: 'th-1' } });
    expect(applied.at(-1)!.background).toBe('#011627');
    await deliver({ type: 'snapshot', values: { 'appearance.theme': {}, 'appearance.themes': { themes: [] } } });
    expect(applied.at(-1)!.background).toBe(TOKENS.ink);
  });
});

describe('the chart theme resolved', () => {
  it('is the system theme when nothing is set', () => {
    const t = chartThemeOf(resolveChartTheme({}));
    const same = (a: string, b: string) => {
      const ch = (s: string) =>
        s.startsWith('#')
          ? [1, 3, 5]
              .map((i) => parseInt(s.slice(i, i + 2), 16))
              .concat(s.length === 9 ? parseInt(s.slice(7), 16) / 255 : 1)
          : s
              .replace(/[^\d.,]/g, '')
              .split(',')
              .map(Number)
              .concat([1])
              .slice(0, 4);
      const [x, y] = [ch(a), ch(b)];
      return x.every((v, i) => Math.abs(v - y[i]!) <= (i === 3 ? 0.01 : 2));
    };
    for (const k of [
      'background',
      'grid',
      'border',
      'text',
      'mutedText',
      'dayText',
      'upFill',
      'downFill',
      'crosshair',
      'tagBackground',
      'sessionSeparator',
      'lineSeries',
      'gridVertical',
      'upVolume',
      'downVolume',
    ] as const) {
      expect(same(t[k], TESSERA_THEME[k]), `${k}: ${t[k]} vs ${TESSERA_THEME[k]}`).toBe(true);
    }
    for (const k of ['profileBar', 'profileValueArea', 'profileBuy', 'profileSell', 'bubbleBuy', 'bubbleSell'] as const)
      expect(same(t.flow[k], TESSERA_THEME.flow[k]), k).toBe(true);
    expect(t.handles).toBeNull();
    expect(t.fontSize).toBe(TESSERA_THEME.fontSize);
  });

  it('is teal and red by default, the brand’s pair, and Jade · coral turns every up and down colour', () => {
    const rgb = (css: string) =>
      css.startsWith('#')
        ? [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16)).join(',')
        : (css.match(/\d+/g) ?? []).slice(0, 3).join(',');
    expect([TOKENS.up, TOKENS.down]).toEqual(['#2fd3b4', '#e0523f']);
    expect(THEME_TABLES.upDownPairs).toEqual({
      tessera: { up: TOKENS.up, down: TOKENS.down },
      jade_coral: { up: '#5fc79c', down: '#ec7b78' },
    });
    const sides = (t: ChartTheme) => ({
      up: [t.upFill, t.upWick, t.upBar, t.upVolume, t.flow.bubbleBuy, t.flow.deltaUp, t.flow.profileBuy].map(rgb),
      down: [
        t.downFill,
        t.downWick,
        t.downBar,
        t.downVolume,
        t.flow.bubbleSell,
        t.flow.deltaDown,
        t.flow.profileSell,
      ].map(rgb),
      ask: t.flow.ask,
      bid: t.flow.bid,
    });
    for (const [palette, pair] of [
      ['tessera', THEME_TABLES.upDownPairs.tessera],
      ['jade-coral', THEME_TABLES.upDownPairs.jade_coral],
    ] as const) {
      const s = sides(chartThemeOf(resolveChartTheme({}, palette)));
      expect(new Set(s.up), palette).toEqual(new Set([rgb(pair.up)]));
      expect(new Set(s.down), palette).toEqual(new Set([rgb(pair.down)]));
      expect([s.ask, s.bid], palette).toEqual([rgb(pair.up), rgb(pair.down)]);
    }
  });

  it("follows the app's up and down pair under Tessera only", () => {
    const pair = THEME_TABLES.upDownPairs.jade_coral;
    expect(chartThemeOf(resolveChartTheme({}, 'jade-coral')).upFill).toBe(pair.up);
    expect(chartThemeOf(resolveChartTheme({}, 'jade-coral')).downFill).toBe(pair.down);
    expect(chartThemeOf(resolveChartTheme({ chartPreset: 'terminal' }, 'jade-coral')).upFill).toBe('#22c55e');
    expect(chartThemeOf(resolveChartTheme({ preset: 'nord' }, 'jade-coral')).upFill).toBe('#a3be8c');
  });

  it('gives volume and delta their own up and down, and indicators the palette', () => {
    const r = resolveChartTheme({ volume: { up: '#0000ff' }, palette: { up: '#00ff00' } });
    expect(swatchesFor(r, 'volume').up).toBe('#0000ff');
    expect(swatchesFor(r, 'delta').up).toBe('#00ff00');
    expect(swatchesFor(r, 'rsi').up).toBe('#00ff00');
    expect(r.overridden.has('volume.up') && r.explicit.has('palette.up')).toBe(true);
    expect(resolveChartTheme({ palette: { up: 'green' }, fonts: { size: 99 } }).fonts.size).toBe(11.5);
    expect(read(chartThemeStore).resolved.preset).toBe('tessera');
  });
  it('has a colour for every swatch name an indicator may ask for', () => {
    const swatches = swatchesOf(resolveChartTheme({}));
    expect(COLOR_SWATCHES.filter((name) => !(name in swatches))).toEqual([]);
  });
});

describe('Settings › Chart › colours', () => {
  it('shows every colour the runtime has, and says a refusal in its own words', async () => {
    const { COLOUR_KEYS, refusalWords } = await import('../src/areas/settings/chartColours.ts');
    expect([...COLOUR_KEYS].sort()).toEqual(
      THEME_TABLES.colors.map((c: { group: string; key: string }) => `${c.group}.${c.key}`).sort(),
    );
    const said = refusalWords(
      'appearance.chartTheme: unreadable order colours on the background #ffffff: orders.target #5fc79c (2.1:1), orders.stop #ec7b78 (2.8:1). Orders must keep at least 3:1',
    );
    expect(said).toBe('Target, Stop would not read on this background. Change them first, or pick another background.');
    expect(
      refusalWords(
        'appearance.chartTheme: unreadable order colours on the background #05070c: orders.stop #0a0c12 (1.1:1). Orders must',
        'orders.stop',
      ),
    ).toBe('Too close to the background to read (1.1:1; an order colour needs 3:1).');
    expect(refusalWords('appearance.chartTheme: preset: no preset "x"')).toBe('preset: no preset "x"');
  });
});
