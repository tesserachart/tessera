import { INDICATOR_SPECS, type ChartLayer } from '@tessera/protocol';
import { Menu, MenuContent, MenuTrigger, TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { read } from '../src/app/store.ts';
import type { FakeClient } from './support/runtime.tsx';

const saved: { layers: ChartLayer[] }[] = [];
let current: ChartLayer[] = [];
vi.mock('../src/workspace/controller.ts', () => ({
  layoutSaved: () => Promise.resolve(),
  updateChart: (_layout: string, _tile: string, fn: (c: { layers: ChartLayer[] }) => { layers: ChartLayer[] }) => {
    const next = fn({ layers: current });
    current = next.layers;
    saved.push(next);
    return Promise.resolve();
  },
}));

const { AddIndicatorDialog } = await import('../src/chart/settings/AddIndicatorDialog.tsx');
const { TestRuntime } = await import('./support/runtime.tsx');
const { IndicatorSettingsForm } = await import('../src/chart/settings/IndicatorSettings.tsx');
const { IndicatorMenuItems } = await import('../src/chart/settings/IndicatorMenu.tsx');
const { closeAdd, closeIndicatorSettings, indicatorUiStore, openAdd } = await import('../src/chart/settings/store.ts');
const { indicatorSpec, resolveIndicator } = await import('../src/chart/indicators.ts');
const { bigTradeFilter } = await import('../src/chart/layers/orderflow/bigTrades.ts');

const chart = { layoutId: 'l1', tileId: 'c1' };
const layer = (id: string, kind: string): ChartLayer => ({
  id,
  kind,
  params: {},
  visible: true,
  namespace: 'user',
  sessionId: null,
});

beforeEach(() => {
  saved.length = 0;
  current = [layer('vwap-1', 'vwap')];
});
afterEach(() => {
  cleanup();
  act(() => {
    closeAdd();
    closeIndicatorSettings();
  });
});

describe('the Add-indicator dialog', () => {
  it('opens for its chart only, lists the families and adds the picked indicator by the keyboard', () => {
    render(
      <TestRuntime client={{}}>
        <TooltipProvider>
          <AddIndicatorDialog chart={chart} layers={current} />
        </TooltipProvider>
      </TestRuntime>,
    );
    expect(screen.queryByRole('combobox', { name: 'Search indicators' })).toBeNull();
    act(() => openAdd({ layoutId: 'l1', tileId: 'other' }));
    expect(screen.queryByRole('combobox', { name: 'Search indicators' })).toBeNull();
    act(() => openAdd(chart));
    const search = screen.getByRole('combobox', { name: 'Search indicators' });
    expect(screen.getAllByRole('option')).toHaveLength(INDICATOR_SPECS.length);
    expect(screen.getByText('Momentum')).toBeTruthy();
    expect(screen.getByText('Order flow')).toBeTruthy();
    expect(screen.getByRole('option', { name: /^VWAP/ }).textContent).toContain('on chart');

    fireEvent.change(search, { target: { value: 'rsi' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true });
    expect(current.map((l) => l.id)).toEqual(['vwap-1', 'rsi-1']);
    expect(read(indicatorUiStore).adding).toEqual(chart);
    fireEvent.change(search, { target: { value: 'moving' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(current.map((l) => l.kind)).toEqual(['vwap', 'rsi', 'ema']);
    expect(read(indicatorUiStore).adding).toBeNull();
  });
});

describe('the Layers menu', () => {
  it('removes an indicator by its × without toggling it or closing the menu', () => {
    render(
      <TestRuntime client={{}}>
        <TooltipProvider>
          <Menu open>
            <MenuTrigger>Layers</MenuTrigger>
            <MenuContent>
              <IndicatorMenuItems chart={chart} layers={current} add={false} />
            </MenuContent>
          </Menu>
        </TooltipProvider>
      </TestRuntime>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Remove / }));
    expect(saved).toEqual([{ layers: [] }]);
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});

describe('the Add-indicator dialog on a connection without aggressor prints', () => {
  it('lists the footprint disabled with what it needs and the way to the connections, and never adds it', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 'ok',
        callId: 'c',
        durationMs: 1,
        error: null,
        output: {
          kinds: [
            {
              kind: 'footprint',
              title: 'Footprint',
              description: '',
              drawn: true,
              available: false,
              requires: 'footprint',
              reason: 'footprint needs footprint data',
              paramsSchema: {},
              indicator: null,
            },
          ],
        },
      }),
    );
    const client = { request } as unknown as FakeClient;
    render(
      <TestRuntime client={client}>
        <TooltipProvider>
          <AddIndicatorDialog chart={chart} layers={current} />
        </TooltipProvider>
      </TestRuntime>,
    );
    act(() => openAdd(chart));
    await act(async () => {
      await Promise.resolve();
    });
    const row = screen.getByRole('option', { name: /Footprint/ });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('Needs trades with aggressor');
    expect(row.textContent).toContain('Connections');
    const search = screen.getByRole('combobox', { name: 'Search indicators' });
    fireEvent.change(search, { target: { value: 'footprint' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(current.map((l) => l.kind)).toEqual(['vwap']);
    expect(request).toHaveBeenCalledWith(
      'tools.invoke',
      expect.objectContaining({ name: 'chart.list_layer_kinds', input: { layoutId: 'l1', tileId: 'c1' } }),
      expect.anything(),
    );
  });
});

describe('the indicator settings form', () => {
  it('applies each change at once and resets to the defaults', () => {
    const spec = indicatorSpec('rsi')!;
    let settings = resolveIndicator(spec, {});
    const onChange = (fn: (s: typeof settings) => typeof settings) => {
      settings = fn(settings);
      view.rerender(
        <TooltipProvider>
          <IndicatorSettingsForm spec={spec} settings={settings} agent={false} onChange={onChange} />
        </TooltipProvider>,
      );
    };
    const view = render(
      <TooltipProvider>
        <IndicatorSettingsForm spec={spec} settings={settings} agent={false} onChange={onChange} />
      </TooltipProvider>,
    );
    const reset = screen.getByRole('button', { name: 'Reset to defaults' });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    const length = screen.getByRole('textbox', { name: 'Length' });
    fireEvent.change(length, { target: { value: '2' } });
    expect(settings.inputs.length).toBe(2);
    fireEvent.change(length, { target: { value: '1' } });
    expect(settings.inputs.length).toBe(2);
    expect(length.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(length, { key: 'ArrowUp', shiftKey: true });
    expect(settings.inputs.length).toBe(11);

    fireEvent.click(screen.getByRole('button', { name: 'Style' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Background' }));
    expect(settings.fills.zone!.visible).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(settings).toEqual(resolveIndicator(spec, {}));
  });

  it('sets Big trades’ Min size to Auto with a tier and its live cuts, or to Fixed with a band typed in', () => {
    const spec = indicatorSpec('big_trades')!;
    let settings = resolveIndicator(spec, {});
    const form = () => (
      <TooltipProvider>
        <IndicatorSettingsForm
          spec={spec}
          settings={settings}
          agent={false}
          notes={{ 'tier.low': '≥ 60', 'tier.medium': '≥ 120', 'tier.high': '≥ 180' }}
          onChange={onChange}
        />
      </TooltipProvider>
    );
    const onChange = (fn: (s: typeof settings) => typeof settings) => {
      settings = fn(settings);
      view.rerender(form());
    };
    const view = render(form());
    const pressed = (name: string) =>
      within(screen.getByRole('group', { name }))
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent);
    const options = (name: string) =>
      within(screen.getByRole('group', { name }))
        .getAllByRole('button')
        .map((b) => b.textContent);

    expect(options('Min size')).toEqual(['Auto', 'Fixed']);
    expect(pressed('Min size')).toEqual(['Auto']);
    expect(options('Auto shows')).toEqual(['Low', 'Medium', 'High']);
    expect(pressed('Auto shows')).toEqual(['Low']);
    expect(screen.queryByRole('textbox', { name: 'At least' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'At most' })).toBeNull();
    expect(screen.getByText('Low ≥ 60 · Medium ≥ 120 · High ≥ 180')).toBeTruthy();
    expect(screen.getByText(/five sessions before the trade date/)).toBeTruthy();
    expect(bigTradeFilter(settings)).toEqual({ kind: 'auto', tier: 'low' });

    fireEvent.click(within(screen.getByRole('group', { name: 'Auto shows' })).getByRole('button', { name: 'High' }));
    expect(pressed('Auto shows')).toEqual(['High']);
    expect(bigTradeFilter(settings)).toEqual({ kind: 'auto', tier: 'high' });

    fireEvent.click(within(screen.getByRole('group', { name: 'Min size' })).getByRole('button', { name: 'Fixed' }));
    expect(pressed('Min size')).toEqual(['Fixed']);
    expect(screen.queryByRole('group', { name: 'Auto shows' })).toBeNull();
    expect(screen.queryByText(/five sessions before the trade date/)).toBeNull();
    const least = screen.getByRole<HTMLInputElement>('textbox', { name: 'At least' });
    const most = screen.getByRole<HTMLInputElement>('textbox', { name: 'At most' });
    expect(least.value).toBe('60');
    expect(most.value).toBe('');
    expect(most.placeholder).toBe('None');
    expect(bigTradeFilter(settings)).toEqual({ kind: 'size', min: 60, max: null });

    fireEvent.change(least, { target: { value: '25' } });
    fireEvent.change(most, { target: { value: '80' } });
    expect(bigTradeFilter(settings)).toEqual({ kind: 'size', min: 25, max: 80 });
    fireEvent.change(least, { target: { value: '0' } });
    expect(settings.inputs.minSize, 'a fixed minimum is at least 1').toBe(25);

    fireEvent.click(within(screen.getByRole('group', { name: 'Min size' })).getByRole('button', { name: 'Auto' }));
    expect(pressed('Auto shows')).toEqual(['High']);
    expect(bigTradeFilter(settings)).toEqual({ kind: 'auto', tier: 'high' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Min size' })).getByRole('button', { name: 'Fixed' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'At least' }).value).toBe('25');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'At most' }).value).toBe('80');

    fireEvent.change(screen.getByRole('textbox', { name: 'At most' }), { target: { value: '' } });
    expect(settings.inputs.maxSize).toBe(0);
    expect(bigTradeFilter(settings)).toEqual({ kind: 'size', min: 25, max: null });
  });

  it('explains Zones under its row, and shows its settings only while Zones is On', () => {
    const spec = indicatorSpec('big_trades')!;
    const open = (inputs: Record<string, unknown>) =>
      render(
        <TooltipProvider>
          <IndicatorSettingsForm
            spec={spec}
            settings={resolveIndicator(spec, { inputs })}
            agent={false}
            onChange={() => undefined}
          />
        </TooltipProvider>,
      );
    const hint = () => screen.queryByText(/A zone is a band one tick either side of a big trade/);
    const off = open({});
    expect(hint()).toBeTruthy();
    expect(hint()!.textContent).toMatch(/a buy in an up bar or a sell in a down bar/);
    expect(screen.queryByText('Trades in the body')).toBeNull();
    off.unmount();
    open({ zones: 'on' });
    expect(hint()).toBeTruthy();
    expect(screen.getByText('Trades in the body')).toBeTruthy();
    expect(screen.getByText('Trades in the wick')).toBeTruthy();
    expect(screen.getByText('Bars forward')).toBeTruthy();
  });

  it('holds only the tab it shows, with the tab strip on the edge against the row', () => {
    const spec = indicatorSpec('vwap')!;
    const settings = resolveIndicator(spec, {});
    const view = render(
      <TooltipProvider>
        <IndicatorSettingsForm spec={spec} settings={settings} agent={false} side="top" onChange={() => undefined} />
      </TooltipProvider>,
    );
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Inputs',
      'Period',
      'Settings',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Style' }));
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Style',
      'Labels',
      'Settings',
    ]);
    expect(view.container.querySelectorAll('.ind-rows')).toHaveLength(1);
  });

  it("lists a band's style only while the band is on", () => {
    const spec = indicatorSpec('vwap')!;
    const settings = resolveIndicator(spec, { inputs: { band1: true } });
    render(
      <TooltipProvider>
        <IndicatorSettingsForm spec={spec} settings={settings} agent={false} onChange={() => undefined} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Style' }));
    const rows = screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label') ?? c.textContent);
    expect(rows).toEqual(['VWAP', 'Upper 1', 'Lower 1', 'Band 1 fill', 'Labels on price scale', 'Name at line end']);
  });

  it('switches the labels its lines carry: the price-scale tag, a name at their end and its value', () => {
    const spec = indicatorSpec('ema')!;
    let settings = resolveIndicator(spec, {});
    const onChange = (fn: (s: typeof settings) => typeof settings) => {
      settings = fn(settings);
      view.rerender(
        <TooltipProvider>
          <IndicatorSettingsForm spec={spec} settings={settings} agent={false} onChange={onChange} />
        </TooltipProvider>,
      );
    };
    const view = render(
      <TooltipProvider>
        <IndicatorSettingsForm spec={spec} settings={settings} agent={false} onChange={onChange} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Style' }));
    expect(screen.queryByRole('checkbox', { name: 'With value' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Labels on price scale' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Name at line end' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'With value' }));
    expect(settings.labels).toEqual({ priceScale: true, name: true, value: true });
  });

  it('takes a session’s hours once they read as hours, and its time zone from the list of zones', () => {
    const input = (key: string, label: string, type: 'session' | 'timezone', value: string) => ({
      key,
      label,
      type,
      default: value,
      min: null,
      max: null,
      step: null,
      options: null,
      inLabel: false,
    });
    const spec = {
      ...indicatorSpec('rsi')!,
      inputs: [
        input('hours', 'London hours', 'session', '07:00-10:00'),
        input('zone', 'London time zone', 'timezone', 'Europe/London'),
      ],
    };
    expect(resolveIndicator(spec, { inputs: { hours: '25:00-26:00', zone: 'Nowhere/City' } }).inputs).toEqual({
      hours: '07:00-10:00',
      zone: 'Europe/London',
    });
    let settings = resolveIndicator(spec, { inputs: { hours: '20:00-00:00', zone: 'America/New_York' } });
    expect(settings.inputs).toEqual({ hours: '20:00-00:00', zone: 'America/New_York' });
    const onChange = (fn: (s: typeof settings) => typeof settings) => {
      settings = fn(settings);
      view.rerender(
        <TooltipProvider>
          <IndicatorSettingsForm spec={spec} settings={settings} agent={false} onChange={onChange} />
        </TooltipProvider>,
      );
    };
    const view = render(
      <TooltipProvider>
        <IndicatorSettingsForm spec={spec} settings={settings} agent={false} onChange={onChange} />
      </TooltipProvider>,
    );
    const hours = screen.getByRole<HTMLInputElement>('textbox', { name: 'London hours' });
    fireEvent.change(hours, { target: { value: '7am' } });
    expect(hours.getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(hours);
    expect(settings.inputs.hours).toBe('20:00-00:00');
    expect(hours.value).toBe('20:00-00:00');
    fireEvent.change(hours, { target: { value: ' 07:00-10:00 ' } });
    expect(settings.inputs.hours).toBe('20:00-00:00');
    fireEvent.keyDown(hours, { key: 'Enter' });
    expect(settings.inputs.hours).toBe('07:00-10:00');

    fireEvent.click(screen.getByRole('button', { name: 'London time zone: America/New York' }));
    const search = screen.getByRole('combobox', { name: 'London time zone' });
    fireEvent.change(search, { target: { value: 'london' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(settings.inputs.zone).toBe('Europe/London');
    expect(screen.getByRole('button', { name: 'London time zone: Europe/London' })).toBeTruthy();
  });
});

describe('the Defaults menu', () => {
  it('resets to the saved default, saves the default and a preset through the tools, and applies a preset', async () => {
    const { putPresets } = await import('../src/chart/presets/store.ts');
    const spec = indicatorSpec('ema')!;
    putPresets({
      presets: [{ id: 'slow', name: 'Slow', indicator: 'ema', params: { inputs: { length: 50 } } }],
      defaults: { ema: { inputs: { length: 21 } } },
    });
    const request = vi.fn((_method: string, params: { name: string; input: object }) =>
      Promise.resolve({
        ok: true,
        status: 'ok',
        callId: 'c',
        durationMs: 1,
        error: null,
        output:
          params.name === 'chart.save_indicator_preset'
            ? { preset: { id: 'mine', name: 'Mine', indicator: 'ema', params: {} }, replaced: false }
            : { presets: [], defaults: { ema: { inputs: { length: 9 } } } },
      }),
    );
    const client = { request } as unknown as FakeClient;
    let settings = resolveIndicator(spec, { inputs: { length: 30 } });
    const target = { chart, layerId: 'ema-1', indicator: 'ema' };
    const form = () => (
      <TestRuntime client={client}>
        <TooltipProvider>
          <IndicatorSettingsForm spec={spec} settings={settings} agent={false} defaults={target} onChange={onChange} />
        </TooltipProvider>
      </TestRuntime>
    );
    const onChange = (fn: (s: typeof settings) => typeof settings) => {
      settings = fn(settings);
      view.rerender(form());
    };
    const view = render(form());
    const open = () => fireEvent.keyDown(screen.getByRole('button', { name: 'Defaults' }), { key: 'Enter' });

    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Slow' }));
    expect(settings.inputs.length).toBe(50);
    open();
    expect(screen.getByRole('menuitem', { name: 'Slow' }).classList.contains('is-on')).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset settings' }));
    expect(settings.inputs.length).toBe(21);

    open();
    expect(screen.getByRole('menuitem', { name: 'Save as default' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Slow' }));
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as default' }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'tools.invoke',
        expect.objectContaining({
          name: 'chart.set_indicator_default',
          input: { layoutId: 'l1', tileId: 'c1', layerId: 'ema-1' },
        }),
        expect.anything(),
      ),
    );
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset settings' }));
    expect(settings.inputs.length).toBe(9);

    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save preset as…' }));
    const name = await screen.findByRole('textbox', { name: 'Preset name' });
    await vi.waitFor(() => expect(document.activeElement).toBe(name));
    fireEvent.change(name, { target: { value: 'Mine' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'tools.invoke',
        expect.objectContaining({
          name: 'chart.save_indicator_preset',
          input: { layoutId: 'l1', tileId: 'c1', layerId: 'ema-1', name: 'Mine' },
        }),
        expect.anything(),
      ),
    );
  });
});
