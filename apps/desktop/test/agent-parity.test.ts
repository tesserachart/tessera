import type { JsonValue } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { setJournal, journalUiStore } from '../src/areas/journal/store.ts';
import { researchViewStore } from '../src/areas/research/selection.ts';
import { viewportUpdate } from '../src/chart/viewportRequests.ts';
import { DEFAULT_OCO } from '../src/shell/oco.ts';
import { applyView, currentView, journalPatch } from '../src/state/areaView.ts';
import {
  nextPanelStep,
  panelChange,
  requestPanel,
  settlePanelRequest,
  withOcoChange,
  panelRequestsStore,
} from '../src/state/panelRequests.ts';
import { applySetting, currentPreferences, readPreferences } from '../src/state/settingsSync.ts';
import { DEFAULT_UI, uiStore } from '../src/state/ui.ts';
import { takeDeskRequests } from '../src/workspace/tileRequests.ts';
import { read, patch } from '../src/app/store.ts';

const dock = (view: Record<string, unknown>): JsonValue => ({ grid: {}, panels: {}, tessera: { v: 3, ...view } });

describe('the new requests of the desk', () => {
  it('reads maximize, the view, the drawing history and an allowed Trade panel change, in the order asked', () => {
    const seen: string[] = [];
    const handlers = {
      maximize: vi.fn((t: { tileId: string | null }, restore: boolean) =>
        seen.push(`maximize ${String(t.tileId)} ${String(restore)}`),
      ),
      viewport: vi.fn((id: string, v: object) => seen.push(`viewport ${id} ${JSON.stringify(v)}`)),
      drawings: vi.fn((id: string, a: string) => seen.push(`drawings ${id} ${a}`)),
      trade: vi.fn((id: string, p: object) => seen.push(`trade ${id} ${JSON.stringify(p)}`)),
      view: vi.fn((v: object) => seen.push(`view ${JSON.stringify(v)}`)),
    };
    const layout = {
      id: 'ws-parity',
      dock: dock({
        ops: [
          { id: 'op-3', op: 'viewport', tileId: 'chart-1', settings: { from: 1e18, to: 2e18, autoScale: true, x: 1 } },
          { id: 'op-2', op: 'maximize', tileId: 'chart-2', settings: { restore: false } },
          { id: 'op-4', op: 'drawings', tileId: 'chart-1', settings: { action: 'redo' } },
          { id: 'op-5', op: 'trade', tileId: 'chart-1', settings: { qty: 2 } },
          { id: 'op-6', op: 'view', settings: { focus: true, left: 'no' } },
          { id: 'op-7', op: 'viewport', settings: { lastBars: 5 } },
          { id: 'op-8', op: 'trade', tileId: 'chart-1' },
        ],
      }),
    };
    expect(takeDeskRequests(layout, handlers)).toBe(true);
    expect(seen).toEqual([
      'maximize chart-2 false',
      'viewport chart-1 {"from":1000000000000000000,"to":2000000000000000000,"autoScale":true,"op":"op-3"}',
      'drawings chart-1 redo',
      'trade chart-1 {"qty":2}',
      'view {"focus":true}',
    ]);
  });

  it('turns a view request into the chart engine’s: a span in ms, the last bars, a price range or the auto scale', () => {
    expect(viewportUpdate({ from: 2e15, to: 3e15, autoScale: true })).toEqual({
      range: { from: 2e9, to: 3e9 },
      price: 'auto',
    });
    expect(viewportUpdate({ lastBars: 150, priceMin: 1, priceMax: 2 })).toEqual({
      lastBars: 150,
      price: { min: 1, max: 2 },
    });
    expect(viewportUpdate({ fitAll: true, priceMin: 3, priceMax: 2 })).toEqual({ fitAll: true });
  });
});

describe('a Trade panel change the user allowed', () => {
  it('reads as the account, the ticket’s fields and the bracket’s change, merging what is still to apply', () => {
    expect(
      panelChange({
        accountId: 'paper-main',
        qty: 2.6,
        sizing: 'risk',
        risk: -4,
        stopLimitTicks: 140,
        execute: 'micro',
        bracket: 'closed',
        rules: 'sideways',
        oco: { stop: { value: 10 } },
      }),
    ).toEqual({
      accountId: 'paper-main',
      ticket: { qty: 2, sizing: 'risk', stopLimitTicks: 99, execute: 'micro', bracket: 'closed' },
      oco: { stop: { value: 10 } },
    });
    requestPanel('ws', 'chart-1', { qty: 2, oco: { stop: { value: 10, unit: 'ticks' } } });
    requestPanel('ws', 'chart-1', { qty: 3, oco: { stop: { value: 12 }, trail: { on: true } } });
    expect(read(panelRequestsStore).pending['ws/chart-1']).toEqual({
      qty: 3,
      oco: { stop: { value: 12, unit: 'ticks' }, trail: { on: true } },
    });
    settlePanelRequest('ws', 'chart-1', { oco: { trail: { on: true } } });
    expect(read(panelRequestsStore).pending['ws/chart-1']).toEqual({ oco: { trail: { on: true } } });
    settlePanelRequest('ws', 'chart-1', null);
    expect(read(panelRequestsStore).pending['ws/chart-1']).toBeUndefined();
  });

  it('picks its account first, waits for what the panel cannot apply yet, then applies the rest at once', () => {
    const at = { accountId: 'paper-main', root: 'NQ', oco: DEFAULT_OCO, accounts: ['paper-main', 'eval-50k'] };
    const asked = { accountId: 'eval-50k', qty: 2, oco: { stop: { value: 12 } } };
    expect(nextPanelStep(asked, at)).toEqual({ pick: 'eval-50k' });
    expect(nextPanelStep({ accountId: 'eval-9', qty: 2 }, at)).toBeNull();
    const done = nextPanelStep(asked, { ...at, accountId: 'eval-50k' });
    expect(done).toEqual({
      ticket: { qty: 2 },
      oco: { ...DEFAULT_OCO, stop: { ...DEFAULT_OCO.stop, value: 12 } },
      rest: null,
    });
    expect(nextPanelStep({ qty: 3, oco: { on: false } }, { ...at, root: null })).toEqual({
      ticket: { qty: 3 },
      oco: null,
      rest: { oco: { on: false } },
    });
  });

  it('changes only the bracket’s fields it names', () => {
    const next = withOcoChange(DEFAULT_OCO, {
      stop: { unit: 'usd', value: 200 },
      target: { on: false, value: -1 },
      breakeven: { on: true, trigger: 8 },
    });
    expect(next.stop).toEqual({ on: true, unit: 'usd', value: 200 });
    expect(next.target).toEqual({ ...DEFAULT_OCO.target, on: false });
    expect(next.breakeven).toEqual({ on: true, trigger: 8, offset: DEFAULT_OCO.breakeven.offset });
    expect(next.trail).toEqual(DEFAULT_OCO.trail);
  });
});

describe('where each area is, and the recent symbols, are runtime settings', () => {
  it('moves the journal and Settings where the analyst says, and reads them back', () => {
    setJournal({ section: 'overview', trade: null, groupBy: 'symbol' });
    applySetting('ui.view', {
      settings: 'trading',
      journal: { section: 'reports', reportTab: 'breakdowns', groupBy: 'setup', range: '30d', tradeId: null },
    });
    expect(read(uiStore).settingsSection).toBe('trading');
    const j = read(journalUiStore);
    expect([j.section, j.reportTab, j.groupBy, j.scope.range]).toEqual(['reports', 'breakdowns', 'setup', '30d']);
    applySetting('ui.view', { journal: { tradeId: 'T-7', section: 'trades', filter: { outcome: 'loss' } } });
    expect(read(journalUiStore).trade).toBe('T-7');
    expect(read(journalUiStore).filter).toEqual({ outcome: 'loss' });
    const view = currentView();
    expect(view.settings).toBe('trading');
    expect(view.journal?.tradeId).toBe('T-7');
    expect(view.journal?.section).toBe('trades');
    expect(journalPatch({ section: 'nowhere', range: 'decade', sort: '' }, read(journalUiStore))).toEqual({});
    patch(researchViewStore, { selected: null, fresh: false });
    applyView({ research: 'st-4' });
    expect(currentView().research).toBe('st-4');
    setJournal({ section: 'overview', trade: null, filter: {}, groupBy: 'symbol' });
    patch(uiStore, { settingsSection: 'connections' });
    patch(researchViewStore, { selected: null, fresh: false });
  });

  it('keeps the recent symbols in the preferences', () => {
    expect(readPreferences({ recentSymbols: ['ES', 'NQ', 7] })).toEqual({});
    expect(readPreferences({ recentSymbols: ['ES', 'NQ'] })).toEqual({ recentSymbols: ['ES', 'NQ'] });
    const prefs = currentPreferences({ ...read(uiStore), ...DEFAULT_UI, recentSymbols: ['QQQ'] });
    expect(prefs.recentSymbols).toEqual(['QQQ']);
  });
});
