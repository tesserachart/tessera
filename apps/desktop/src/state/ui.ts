import { savedIntervalTexts } from '../market/intervals.ts';
import { z } from 'zod';
import { defaultStorage, patch, makeStore, type Persist, type Store, useStore } from '../app/store.ts';
import { landingOf, SETTINGS_CATEGORIES, type SettingsCategory } from '../areas/settings/model.ts';
import { CHART_TYPES, type ChartType } from './layouts.ts';

export type UpDownPalette = 'tessera' | 'jade-coral';
export type Density = 'compact' | 'default' | 'comfortable';

export type SymbolSearchFor = 'change' | 'tab';
export type SymbolSearchAt = 'chart' | 'desk';

export interface UiState {
  workspace: string | null;
  settingsSection: SettingsCategory;
  paletteOpen: boolean;
  paletteQuery: string;
  symbolSearch: string | null;
  symbolSearchFor: SymbolSearchFor;
  symbolSearchAt: SymbolSearchAt;
  updown: UpDownPalette;
  density: Density;
  reducedMotion: boolean;
  composerDraft: string;
  recentSymbols: string[];
  recentCommands: string[];
  favouriteIntervals: string[];
  tradeAccount: string | null;
  defaultChartType: ChartType;
}

export const DEFAULT_UI: UiState = {
  workspace: null,
  settingsSection: 'connections',
  paletteOpen: false,
  paletteQuery: '',
  symbolSearch: null,
  symbolSearchFor: 'change',
  symbolSearchAt: 'chart',
  updown: 'tessera',
  density: 'default',
  reducedMotion: false,
  composerDraft: '',
  recentSymbols: [],
  recentCommands: [],
  favouriteIntervals: ['1m', '5m', '15m', '1h', '1D'],
  tradeAccount: null,
  defaultChartType: 'candles',
};

const RECENT_SYMBOLS = 8;
export const RECENT_COMMANDS = 5;

interface PersistedOld {
  agent?: 'rail' | 'docked' | 'wide' | 'popout';
  agentRestore?: 'docked' | 'wide';
  left?: unknown;
  navWidth?: unknown;
  area?: unknown;
  right?: 'open' | 'rail' | 'popout';
  rightTab?: 'analyst' | 'trade';
  rightWidth?: number | null;
  newChartLayers?: unknown;
  analyst?: 'open' | 'rail' | 'popout';
  analystWidth?: number | null;
  panel?: 'analyst' | 'markets' | 'trade';
  panelOpen?: boolean;
  panelWidth?: number | null;
  focus?: unknown;
  homeSection?: unknown;
  tradeOpen?: unknown;
  firstTicket?: unknown;
  watchlist?: unknown;
  marketList?: unknown;
  marketSort?: unknown;
}

const UP_DOWN_BEFORE_V13: Readonly<Record<string, UpDownPalette>> = {
  'blue-red': 'tessera',
  'green-red': 'jade-coral',
};

export function migrateUi(persisted: unknown, version: number): Partial<UiState> {
  const {
    firstTicket: _firstTicket,
    watchlist: _watchlist,
    marketList: _marketList,
    marketSort: _marketSort,
    ...v9
  } = migrateToV9(persisted, version) as Partial<UiState> & PersistedOld;
  const updown = UP_DOWN_BEFORE_V13[String(v9.updown)];
  return updown ? { ...v9, updown } : v9;
}

function migrateToV9(persisted: unknown, version: number): Partial<UiState> {
  const before = migrateToV8(persisted);
  if (version >= 9) return before;
  const { homeSection, ...rest } = before as Partial<UiState> & PersistedOld;
  return homeSection === undefined ? rest : { ...rest, settingsSection: landingOf(homeSection) ?? 'connections' };
}

function migrateToV8(persisted: unknown): Partial<UiState> {
  const {
    agent: _agent,
    agentRestore: _agentRestore,
    left: _left,
    navWidth: _navWidth,
    area: _area,
    right: _right,
    rightTab: _rightTab,
    rightWidth: _rightWidth,
    newChartLayers: _newChartLayers,
    analyst: _analyst,
    analystWidth: _analystWidth,
    panel: _panel,
    panelOpen: _panelOpen,
    panelWidth: _panelWidth,
    focus: _focus,
    tradeOpen: _tradeOpen,
    ...rest
  } = (persisted ?? {}) as Partial<UiState> & PersistedOld;
  return rest;
}

const PERSISTED: Persist<UiState>['fields'] = {
  workspace: z.string().nullable(),
  settingsSection: z.enum(SETTINGS_CATEGORIES),
  updown: z.enum(['tessera', 'jade-coral']),
  density: z.enum(['compact', 'default', 'comfortable']),
  reducedMotion: z.boolean(),
  composerDraft: z.string(),
  recentSymbols: z.array(z.string()),
  recentCommands: z.array(z.string()),
  favouriteIntervals: z.array(z.string()),
  tradeAccount: z.string().nullable(),
  defaultChartType: z.enum(CHART_TYPES),
};

export function makeUiStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage()): Store<UiState> {
  return makeStore(DEFAULT_UI, {
    persist: { key: 'tessera.ui', version: 13, fields: PERSISTED, migrate: migrateUi, storage },
  });
}

export const uiStore = makeUiStore();

export function useUi<T>(select: (s: UiState) => T): T {
  return useStore(uiStore, select);
}

export const setWorkspace = (workspace: string | null) => patch(uiStore, { workspace });
export const setDefaultChartType = (defaultChartType: ChartType) => patch(uiStore, { defaultChartType });
export const setSettingsSection = (settingsSection: SettingsCategory) => patch(uiStore, { settingsSection });

export const openPalette = (query = '') =>
  patch(uiStore, { paletteOpen: true, paletteQuery: query, symbolSearch: null });
export const closePalette = () => patch(uiStore, { paletteOpen: false, paletteQuery: '' });
export const openSymbolSearch = (query = '', purpose: SymbolSearchFor = 'change', at: SymbolSearchAt = 'chart') =>
  patch(uiStore, { symbolSearch: query, symbolSearchFor: purpose, symbolSearchAt: at, paletteOpen: false });
export const closeSymbolSearch = () =>
  patch(uiStore, { symbolSearch: null, symbolSearchFor: 'change', symbolSearchAt: 'chart' });
export const setUpDown = (updown: UpDownPalette) => patch(uiStore, { updown });
export const setDensity = (density: Density) => patch(uiStore, { density });
export const setReducedMotion = (reducedMotion: boolean) => patch(uiStore, { reducedMotion });
export const setComposerDraft = (composerDraft: string) => patch(uiStore, { composerDraft });
export const addRecentSymbol = (instrument: string) =>
  patch(uiStore, (s) => ({
    recentSymbols: [instrument, ...s.recentSymbols.filter((x) => x !== instrument)].slice(0, RECENT_SYMBOLS),
  }));
export const addRecentCommand = (id: string) =>
  patch(uiStore, (s) => ({
    recentCommands: [id, ...s.recentCommands.filter((x) => x !== id)].slice(0, RECENT_COMMANDS),
  }));
export const toggleFavouriteInterval = (interval: string) =>
  patch(uiStore, (s) => {
    const [text] = savedIntervalTexts([interval]);
    if (!text) return {};
    const saved = savedIntervalTexts(s.favouriteIntervals);
    return {
      favouriteIntervals: saved.includes(text) ? saved.filter((f) => f !== text) : savedIntervalTexts([...saved, text]),
    };
  });
export const saveFavouriteInterval = (interval: string) =>
  patch(uiStore, (s) => ({ favouriteIntervals: savedIntervalTexts([...s.favouriteIntervals, interval]) }));
export const setTradeAccount = (tradeAccount: string | null) => patch(uiStore, { tradeAccount });
