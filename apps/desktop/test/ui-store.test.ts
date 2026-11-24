import { describe, expect, it } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import { closePalette, makeUiStore, migrateUi, openPalette, uiStore, type UiState } from '../src/state/ui.ts';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function window(storage: Storage) {
  const store = makeUiStore(storage);
  return {
    get: () => read(store),
    set: (change: Partial<UiState>) => patch(store, change),
  };
}

describe('UI store', () => {
  it('keeps no panel of its own: the analyst, Markets and Trade are the dock’s', () => {
    const s = window(memory());
    expect(s.get()).toMatchObject({ settingsSection: 'connections' });
    for (const gone of [
      'firstTicket',
      'takeFirstTicket',
      'analyst',
      'panel',
      'tradeWidth',
      'toggleTrade',
      'setTradeWidth',
      'setTradeOpen',
      'home',
      'homeSection',
      'openHome',
      'closeHome',
      'toggleHome',
    ])
      expect(gone in s.get()).toBe(false);
  });

  it('Settings remembers the category it shows', () => {
    const storage = memory();
    window(storage).set({ settingsSection: 'trading' });
    expect(window(storage).get().settingsSection).toBe('trading');
  });

  it('keeps calmer motion with the chrome', () => {
    const storage = memory();
    window(storage).set({ reducedMotion: true });
    expect(window(storage).get().reducedMotion).toBe(true);
  });

  it('forgets the Markets tile’s watchlist, list and sorts (v11: the watchlists are the runtime’s)', () => {
    const storage = memory();
    storage.setItem(
      'tessera.ui',
      JSON.stringify({
        state: { watchlist: ['NQ'], marketList: 'futures', marketSort: { futures: null }, updown: 'green-red' },
        version: 10,
      }),
    );
    const s = window(storage).get() as unknown as Record<string, unknown>;
    expect(s.updown).toBe('jade-coral');
    expect(s).not.toHaveProperty('watchlist');
    expect(s).not.toHaveProperty('marketList');
    expect(s).not.toHaveProperty('marketSort');
  });

  it('keeps a question typed in the composer', () => {
    const storage = memory();
    storage.setItem('tessera.ui', JSON.stringify({ state: { composerDraft: 'brief me on NQ' }, version: 11 }));
    expect(window(storage).get().composerDraft).toBe('brief me on NQ');
  });

  it('persists preferences', () => {
    const storage = memory();
    window(storage).set({
      workspace: 'ws-2',
      updown: 'jade-coral',
      paletteOpen: true,
      paletteQuery: 'nq',
      settingsSection: 'levels',
    });
    expect(window(storage).get()).toMatchObject({
      workspace: 'ws-2',
      updown: 'jade-coral',
      paletteOpen: false,
      settingsSection: 'levels',
    });
  });

  it('a category a later build retired reads as Connections', () => {
    const storage = memory();
    storage.setItem('tessera.ui', JSON.stringify({ state: { settingsSection: 'retired' }, version: 9 }));
    expect(window(storage).get().settingsSection).toBe('connections');
  });

  it('moves Home’s section onto the Settings area’s category (v9)', () => {
    for (const [home, category] of [
      ['chart', 'chart'],
      ['levels', 'levels'],
      ['settings', 'connections'],
      ['connectors', 'connections'],
      ['retired', 'connections'],
    ] as const) {
      const storage = memory();
      storage.setItem('tessera.ui', JSON.stringify({ state: { homeSection: home, reducedMotion: true }, version: 8 }));
      const s = window(storage).get();
      expect(s.settingsSection, home).toBe(category);
      expect(s.reducedMotion).toBe(true);
      expect('homeSection' in s).toBe(false);
    }
    expect(migrateUi({ homeSection: 'levels', watchlist: ['NQ'] }, 8)).toEqual({ settingsSection: 'levels' });
  });

  it('moves older snapshots on, dropping the old chrome', () => {
    expect(migrateUi({ area: 'journal', agent: 'wide', agentRestore: 'wide' }, 1)).toEqual({});
    expect(migrateUi({ analyst: 'rail', panel: 'markets', panelOpen: true, panelWidth: 300 }, 6)).toEqual({});
    expect(migrateUi({ focus: true, workspace: 'w' }, 6)).toMatchObject({ workspace: 'w' });
    expect(migrateUi({ tradeOpen: true, workspace: 'w' }, 7)).toEqual({ workspace: 'w' });
    expect(migrateUi({ firstTicket: true, workspace: 'w' }, 8)).toEqual({ workspace: 'w' });
    expect(migrateUi({ firstTicket: null, settingsSection: 'data' }, 9)).toEqual({ settingsSection: 'data' });
    const storage = memory();
    storage.setItem('tessera.ui', JSON.stringify({ state: { firstTicket: true, reducedMotion: true }, version: 9 }));
    const s = window(storage).get();
    expect(s.reducedMotion).toBe(true);
    expect('firstTicket' in s).toBe(false);
  });

  it('a stored field that does not read keeps its default, and the rest still load', () => {
    const storage = memory();
    storage.setItem('tessera.ui', JSON.stringify({ state: { density: 'huge', updown: 'jade-coral' }, version: 13 }));
    expect(window(storage).get()).toMatchObject({ density: 'default', updown: 'jade-coral' });
  });

  it('opens a pair saved before blue and orange on its new name: the default on Tessera, green and red on Jade · coral', () => {
    for (const [saved, now] of [
      ['blue-red', 'tessera'],
      ['green-red', 'jade-coral'],
    ] as const) {
      const storage = memory();
      storage.setItem('tessera.ui', JSON.stringify({ state: { updown: saved }, version: 12 }));
      expect(window(storage).get().updown, saved).toBe(now);
    }
    expect(window(memory()).get().updown).toBe('tessera');
  });

  it('palette open/close carries a query', () => {
    openPalette('qqq');
    expect(read(uiStore)).toMatchObject({ paletteOpen: true, paletteQuery: 'qqq' });
    closePalette();
    expect(read(uiStore)).toMatchObject({ paletteOpen: false, paletteQuery: '' });
  });
});
