import type { JsonValue, SettingsEvent } from '@tessera/protocol';
import { isFibKind } from '@tessera/chart';
import { savedIntervalTexts } from '../market/intervals.ts';
import { useEffect } from 'react';
import { agentsUiStore } from '../areas/agents/store.ts';
import type { ModelPick } from '../areas/agents/models.ts';
import { isAreaId, areaStore, showArea } from '../areas/store.ts';
import { type DrawingUiState, drawingStore } from '../chart/drawings/store.ts';
import { putDrawingTemplates } from '../chart/drawings/templateStore.ts';
import { isDrawingKind, readLabel, readLevels } from '../chart/drawings/templates.ts';
import { SCHEME_KEY } from '../theme/scheme.ts';
import { SAVED_THEMES_KEY, THEME_KEY, setThemeSettings } from '../theme/store.ts';
import { readLevelSettings } from '../chart/levelSettings.ts';
import { putPresets } from '../chart/presets/store.ts';
import { putTemplates } from '../chart/templates/store.ts';
import { useTopicEffect } from '../app/useTopic.ts';
import { stableStringify } from '../workspace/layouts.ts';
import { CHART_TYPES, type ChartType } from './layouts.ts';
import { putRuntimeSettings, receiveSettings, settingAgreed, writeSetting } from './runtimeSettings.ts';
import { tradeSettingsStore } from './tradeSettings.ts';
import { applyView, currentView, onViewChange } from './areaView.ts';
import { type Density, type UiState, uiStore } from './ui.ts';
import { putWatchlists, watchlistsStore } from '../markets/watchlists.ts';
import { read, patch, watch } from '../app/store.ts';
import { switchWorkspace } from '../workspace/document.ts';

const DENSITY_PX: Record<Density, number> = { compact: 20, default: 24, comfortable: 28 };

export type UiPreferences = Pick<UiState, 'favouriteIntervals' | 'defaultChartType' | 'recentSymbols'>;

export function currentPreferences(s: UiState = read(uiStore)): UiPreferences {
  return {
    favouriteIntervals: s.favouriteIntervals,
    defaultChartType: s.defaultChartType,
    recentSymbols: s.recentSymbols,
  };
}

export function readPreferences(v: unknown): Partial<UiPreferences> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: Partial<UiPreferences> = {};
  const strings = (x: unknown) => (Array.isArray(x) && x.every((i) => typeof i === 'string') ? x : null);
  const intervals = strings(o.favouriteIntervals);
  if (intervals) out.favouriteIntervals = savedIntervalTexts(intervals);
  if (CHART_TYPES.includes(o.defaultChartType as ChartType)) out.defaultChartType = o.defaultChartType as ChartType;
  const recent = strings(o.recentSymbols);
  if (recent) out.recentSymbols = recent.slice(0, 8);
  return out;
}

export interface DrawingTools {
  magnet: boolean;
  toolbarFolded: boolean;
  styles: DrawingUiState['styleByKind'];
}

export function currentDrawingTools(s: DrawingUiState = read(drawingStore)): DrawingTools {
  return { magnet: s.magnet, toolbarFolded: s.collapsed, styles: s.styleByKind };
}

const LINES = ['solid', 'dash', 'dot'];
const EXTENDS = ['none', 'left', 'right', 'both'];

export function readDrawingTools(v: unknown): Partial<Pick<DrawingUiState, 'magnet' | 'collapsed' | 'styleByKind'>> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: Partial<Pick<DrawingUiState, 'magnet' | 'collapsed' | 'styleByKind'>> = {};
  if (typeof o.magnet === 'boolean') out.magnet = o.magnet;
  if (typeof o.toolbarFolded === 'boolean') out.collapsed = o.toolbarFolded;
  if (o.styles && typeof o.styles === 'object' && !Array.isArray(o.styles)) {
    const styles: Record<string, Record<string, unknown>> = {};
    for (const [kind, raw] of Object.entries(o.styles as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const { color, width, line, extend, label, levels } = raw as Record<string, unknown>;
      const style: Record<string, unknown> = {};
      if (typeof color === 'string' && color) style.color = color;
      if (typeof width === 'number' && width >= 0.5 && width <= 4) style.width = width;
      if (typeof line === 'string' && LINES.includes(line)) style.line = line;
      if (typeof extend === 'string' && EXTENDS.includes(extend)) style.extend = extend;
      const look = isDrawingKind(kind) ? readLabel(kind, label) : null;
      if (look) style.label = look;
      const lv = isDrawingKind(kind) && isFibKind(kind) ? readLevels(levels) : null;
      if (lv) style.levels = lv;
      styles[kind] = style;
    }
    out.styleByKind = styles;
  }
  return out;
}

export function modelSetting(pick: ModelPick | null): Record<string, string> {
  if (!pick) return {};
  return {
    provider: pick.provider,
    ...(pick.model ? { model: pick.model } : {}),
    ...(pick.effort ? { effort: pick.effort } : {}),
  };
}

export function readModelSetting(v: unknown): ModelPick | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.provider !== 'string' || !o.provider) return null;
  return {
    provider: o.provider,
    model: typeof o.model === 'string' && o.model ? o.model : null,
    effort: typeof o.effort === 'string' && o.effort ? o.effort : null,
  };
}

function localValue(key: string): unknown {
  const s = read(uiStore);
  if (key === 'appearance.upDownColors') return s.updown === 'jade-coral' ? 'jade_coral' : 'tessera';
  if (key === 'appearance.density') return DENSITY_PX[s.density];
  if (key === 'ui.preferences') return currentPreferences(s);
  if (key === 'chart.drawingTools') return currentDrawingTools();
  if (key === 'ui.area') return read(areaStore).area;
  if (key === 'ui.workspace') return s.workspace ?? '';
  if (key === 'appearance.reducedMotion') return s.reducedMotion;
  if (key === 'agent.defaultModel') return modelSetting(read(agentsUiStore).pick);
  if (key === 'ui.view') return currentView();
  if (key === 'markets.watchlists') return read(watchlistsStore).value;
  return undefined;
}

export function applySetting(key: string, value: unknown): void {
  if (key === 'appearance.upDownColors' && (value === 'jade_coral' || value === 'tessera'))
    patch(uiStore, { updown: value === 'jade_coral' ? 'jade-coral' : 'tessera' });
  else if (key === 'appearance.density') {
    const d = (Object.keys(DENSITY_PX) as Density[]).find((k) => DENSITY_PX[k] === value);
    if (d) patch(uiStore, { density: d });
  } else if (key === 'ui.preferences') patch(uiStore, readPreferences(value));
  else if (key === 'chart.levels') patch(tradeSettingsStore, { levels: readLevelSettings(value) });
  else if (key === 'chart.templates') putTemplates(value);
  else if (key === 'chart.drawingTemplates') putDrawingTemplates(value);
  else if (key === 'chart.indicatorPresets') putPresets(value);
  else if (key === THEME_KEY) setThemeSettings({ active: value });
  else if (key === SAVED_THEMES_KEY) setThemeSettings({ saved: value });
  else if (key === SCHEME_KEY) setThemeSettings({ scheme: value });
  else if (key === 'chart.drawingTools') patch(drawingStore, readDrawingTools(value));
  else if (key === 'ui.area' && isAreaId(value)) showArea(value);
  else if (key === 'ui.workspace' && typeof value === 'string')
    void switchWorkspace(value || null).catch((err: unknown) => console.warn('[workspace] not switched', err));
  else if (key === 'appearance.reducedMotion' && typeof value === 'boolean') patch(uiStore, { reducedMotion: value });
  else if (key === 'agent.defaultModel') {
    const pick = readModelSetting(value);
    if (pick) patch(agentsUiStore, { pick });
  } else if (key === 'ui.view') applyView(value);
  else if (key === 'markets.watchlists') putWatchlists(value);
}

const SYNCED = [
  'appearance.upDownColors',
  'appearance.density',
  'ui.preferences',
  'chart.drawingTools',
  'ui.area',
  'ui.workspace',
  'appearance.reducedMotion',
  'agent.defaultModel',
  'ui.view',
  'markets.watchlists',
] as const;

const WINDOW_DEFAULTS: Readonly<Record<string, unknown>> = { 'ui.area': 'desk', 'ui.workspace': '' };

const EMPTY_UNTIL_WRITTEN: ReadonlySet<string> = new Set([
  'ui.preferences',
  'chart.drawingTools',
  'agent.defaultModel',
]);

function windowWinsAtStart(key: string, stored: unknown, mine: unknown): boolean {
  const neverWritten = EMPTY_UNTIL_WRITTEN.has(key) && stableStringify(stored) === '{}';
  const anotherWindowsView = key === 'ui.view' && stableStringify(mine) !== stableStringify(stored);
  const aWindowDefault = key in WINDOW_DEFAULTS && stored === WINDOW_DEFAULTS[key] && mine !== stored;
  return neverWritten || anotherWindowsView || aWindowDefault;
}

function ownValue(key: string): unknown {
  const v = localValue(key);
  if (!MERGED_KEYS.has(key) || !v || typeof v !== 'object' || Array.isArray(v)) return v;
  const agreed = settingAgreed(key);
  const stored: unknown = agreed === undefined ? null : JSON.parse(agreed);
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored, ...v } : v;
}

function save(key: string, value: unknown): void {
  writeSetting(key, value as JsonValue).catch((err: unknown) => {
    console.warn(`[settings] ${key} not saved`, err);
  });
}

export function useSettingsSync(): void {
  useTopicEffect('settings', {}, (ev: SettingsEvent) => {
    const snapshot = ev.type === 'snapshot';
    const values = snapshot ? ev.values : { [ev.key]: ev.value };
    const own: Record<string, unknown> = {};
    if (snapshot) {
      for (const [key, value] of Object.entries(values)) {
        const mine = localValue(key);
        if (windowWinsAtStart(key, value, mine)) own[key] = mine;
      }
    }
    const news = receiveSettings(values, snapshot, ownValue);
    for (const [key, value] of Object.entries(news)) if (!(key in own)) applySetting(key, value);
    for (const [key, value] of Object.entries(own)) save(key, value);
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => {
      timer = null;
      for (const key of SYNCED) {
        const agreed = settingAgreed(key);
        if (agreed === undefined) continue;
        const value = ownValue(key);
        if (unchangedSetting(key, value, agreed)) continue;
        save(key, value);
      }
    };
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, 400);
    };
    const off = watch(uiStore, later);
    const offArea = watch(areaStore, later);
    const offDrawing = watch(drawingStore, later);
    const offPick = watch(agentsUiStore, later);
    const offView = onViewChange(later);
    const offLists = watch(watchlistsStore, later);
    return () => {
      offLists();
      off();
      offArea();
      offDrawing();
      offPick();
      offView();
      if (timer) clearTimeout(timer);
    };
  }, []);
}

export const MERGED_KEYS: ReadonlySet<string> = new Set(['ui.preferences', 'chart.drawingTools']);

export function unchangedSetting(key: string, value: unknown, stored: string | undefined): boolean {
  if (stored === undefined) return false;
  if (stableStringify(value) === stored) return true;
  if (!MERGED_KEYS.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const held: unknown = JSON.parse(stored);
  if (!held || typeof held !== 'object' || Array.isArray(held)) return false;
  const own = Object.fromEntries(Object.keys(value).map((k) => [k, (held as Record<string, unknown>)[k]]));
  return stableStringify(own) === stableStringify(value);
}

const CHART_WINDOW_KEYS: ReadonlySet<string> = new Set([
  'appearance.upDownColors',
  'appearance.density',
  THEME_KEY,
  SAVED_THEMES_KEY,
  SCHEME_KEY,
  'chart.levels',
  'chart.templates',
  'chart.drawingTemplates',
  'chart.indicatorPresets',
  'chart.drawingTools',
]);

export function useWindowSettings(): void {
  useTopicEffect('settings', {}, (ev: SettingsEvent) => {
    const values = ev.type === 'snapshot' ? ev.values : { [ev.key]: ev.value };
    putRuntimeSettings(values, ev.type === 'snapshot');
    for (const [key, value] of Object.entries(values)) if (CHART_WINDOW_KEYS.has(key)) applySetting(key, value);
  });
}
