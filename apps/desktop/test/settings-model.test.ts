import { afterEach, describe, expect, it } from 'vitest';
import { bracketWords, keyedCommands, sizeWords } from '../src/areas/settings/words.ts';
import { asSentence, endSentence } from '../src/areas/settings/sentence.ts';
import {
  CATEGORIES,
  SECTIONS,
  SETTINGS_CATEGORIES,
  categoryOf,
  landingOf,
  modelEntries,
  rowWords,
  searchSettings,
  sectionWords,
} from '../src/areas/settings/model.ts';
import {
  goToSetting,
  openSettings,
  showCategory,
  toggleSettings,
  settingsNavStore,
} from '../src/areas/settings/store.ts';
import { accountsUiStore } from '../src/accounts/accountsUi.ts';
import { areaStore } from '../src/areas/store.ts';
import { DEFAULT_OCO } from '../src/shell/oco.ts';
import { BRACKET_ON } from './support/oco.ts';
import { modelSetting, readModelSetting } from '../src/state/settingsSync.ts';
import { uiStore } from '../src/state/ui.ts';
import { read, patch } from '../src/app/store.ts';

describe('Settings’ model', () => {
  it('has the pages a trader looks in, and every id in the registry once, with its row or section, its page and a search entry', () => {
    expect(CATEGORIES.map((c) => c.label)).toEqual([
      'Connections',
      'Trading and risk',
      'Chart',
      'Levels',
      'Alerts and sounds',
      'Analyst',
      'Data',
      'Appearance',
      'App',
    ]);
    const ids: string[] = [];
    const found = new Set(modelEntries().map((e) => e.id));
    for (const c of SETTINGS_CATEGORIES) {
      expect(SECTIONS[c].length, c).toBeGreaterThan(0);
      for (const s of SECTIONS[c]) {
        ids.push(s.id);
        expect(s.id.startsWith(`${c}.`), s.id).toBe(true);
        expect(categoryOf(s.id), s.id).toBe(c);
        expect(sectionWords(s.id), s.id).toBe(s);
        expect(found.has(s.id), `search finds ${s.id}`).toBe(true);
        for (const r of s.rows ?? []) {
          ids.push(r.id);
          expect(r.id.startsWith(`${c}.`), r.id).toBe(true);
          expect(categoryOf(r.id), r.id).toBe(c);
          expect(rowWords(r.id), r.id).toBe(r);
          expect(found.has(r.id), `search finds ${r.id}`).toBe(true);
        }
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => rowWords('app.nope')).toThrow(/no row/);
    expect(() => sectionWords('app.nope')).toThrow(/no section/);
  });

  it('finds the trader’s limits by the words a trader uses (decision 0014)', () => {
    const entries = modelEntries();
    expect(searchSettings(entries, 'dll')[0]?.id).toBe('trading.dailyLoss');
    expect(searchSettings(entries, 'max risk per trade')[0]?.id).toBe('trading.perTrade');
    expect(searchSettings(entries, 'prop firm drawdown')[0]?.id).toBe('trading.useFirm');
    expect(landingOf('trading.useFirm')).toBe('trading');
    expect(landingOf('risk')).toBe('trading');
  });

  it('finds a broker login under Connections by the words a trader uses', () => {
    const entries = modelEntries();
    for (const q of ['rithmic', 'password', 'api key'])
      expect(searchSettings(entries, q)[0]?.category, q).toBe('connections');
  });

  it('every row and section is something the search finds, by its own words first', () => {
    const entries = modelEntries();
    expect(entries.length).toBeGreaterThan(50);
    expect(searchSettings(entries, '')).toEqual([]);
    expect(searchSettings(entries, 'row density')[0]?.id).toBe('app.density');
    expect(searchSettings(entries, 'snap')[0]?.id).toBe('chart.magnet');
    expect(searchSettings(entries, 'system prompt')[0]?.id).toBe('analyst.customInstructions');
    const commission = searchSettings(entries, 'commission')[0]!;
    expect(commission).toMatchObject({
      id: 'trading.commission',
      category: 'trading',
      path: 'Trading and risk · Paper trading',
    });
    expect(searchSettings(entries, 'density zzzz')).toEqual([]);
  });

  it('lands a deep link on its page: a page, a row, a connection, and the words people use for a page', () => {
    expect(landingOf('levels')).toBe('levels');
    expect(landingOf('chart')).toBe('chart');
    expect(landingOf('settings')).toBe('connections');
    expect(landingOf('connections')).toBe('connections');
    expect(landingOf('connections.rithmic-apex')).toBe('connections');
    expect(landingOf('connections.add.zeta')).toBe('connections');
    expect(landingOf('credentials')).toBe('connections');
    expect(landingOf('passwords')).toBe('connections');
    expect(landingOf('analyst')).toBe('analyst');
    expect(landingOf('agents')).toBe('analyst');
    expect(landingOf('keyboard')).toBe('app');
    expect(landingOf('about')).toBe('app');
    expect(landingOf('trading.commission')).toBe('trading');
    expect(landingOf('nowhere')).toBeNull();
    expect(landingOf(7)).toBeNull();
  });
});

describe('opening Settings', () => {
  afterEach(() => {
    patch(areaStore, { area: 'desk', previous: null });
    patch(settingsNavStore, { query: '', target: null });
  });

  it('opens a connection on its row, and an add link on its form', () => {
    openSettings('connections.rithmic-apex');
    expect(read(uiStore).settingsSection).toBe('connections');
    expect(read(settingsNavStore).target?.id).toBe('connections.rithmic-apex');
    openSettings('connections.add.zeta');
    expect(read(settingsNavStore).target?.id).toBe('connections.add');
    expect(read(accountsUiStore).focus).toEqual({ kind: 'add', provider: 'zeta' });
    patch(accountsUiStore, { focus: null });
  });

  it('goes where a link points, marks the row, and ⌘, goes back to the area before', () => {
    patch(areaStore, { area: 'research', previous: null });
    patch(settingsNavStore, { query: 'old', target: null });
    openSettings('levels');
    expect(read(areaStore).area).toBe('settings');
    expect(read(uiStore).settingsSection).toBe('levels');
    expect(read(settingsNavStore)).toEqual({ query: '', target: null });
    openSettings('analyst.customInstructions');
    expect(read(uiStore).settingsSection).toBe('analyst');
    expect(read(settingsNavStore).target?.id).toBe('analyst.customInstructions');
    const n = read(settingsNavStore).target!.n;
    goToSetting('analyst.customInstructions');
    expect(read(settingsNavStore).target!.n).toBeGreaterThan(n);
    goToSetting('app.key.agent.stop', 'app');
    expect(read(uiStore).settingsSection).toBe('app');
    openSettings('risk');
    expect(read(uiStore).settingsSection).toBe('trading');
    expect(read(settingsNavStore).target).toBeNull();
    showCategory('data');
    expect(read(settingsNavStore).target).toBeNull();
    toggleSettings();
    expect(read(areaStore).area).toBe('research');
    toggleSettings();
    expect(read(areaStore).area).toBe('settings');
    expect(read(uiStore).settingsSection).toBe('data');
  });
});

describe('the words Settings shows', () => {
  it('says a bracket as the ticket sets it', () => {
    expect(bracketWords(DEFAULT_OCO)).toBe('No bracket');
    expect(bracketWords(BRACKET_ON)).toBe('Stop 40 ticks · Target 80 ticks');
    expect(
      bracketWords({
        ...BRACKET_ON,
        stop: { on: true, unit: 'usd', value: 200 },
        target: { on: false, unit: 'points', value: 10 },
        breakeven: { on: true, trigger: 20, offset: 1 },
        trail: { on: true, ticks: 12, trigger: 0, step: 1 },
      }),
    ).toBe('Stop $200.00 · Target off · Breakeven at 20 · Trail 12');
    expect(bracketWords({ ...BRACKET_ON, on: false })).toBe('No bracket');
  });

  it('says a size in the unit it reads best in', () => {
    expect(sizeWords(512)).toBe('512 B');
    expect(sizeWords(840 * 1024)).toBe('840 KB');
    expect(sizeWords(12.4 * 1024 * 1024)).toBe('12.4 MB');
    expect(sizeWords(1.25 * 1024 ** 3)).toBe('1.3 GB');
  });

  it('lists each key once, in the registry’s order', () => {
    const run = () => undefined;
    const keyed = keyedCommands([
      { id: 'a', title: 'Open Settings', group: 'Settings', shortcut: 'mod+,', run },
      { id: 'b', title: 'Change symbol…', group: 'Chart', run },
      { id: 'c', title: 'Open Settings', group: 'Settings', shortcut: 'mod+,', run },
      { id: 'd', title: 'Stop the analyst', group: 'Analyst', shortcut: 'mod+.', run },
    ]);
    expect(keyed.map((c) => c.id)).toEqual(['a', 'd']);
  });

  it('keeps a new conversation’s model as the runtime stores it', () => {
    expect(modelSetting(null)).toEqual({});
    expect(modelSetting({ provider: 'codex', model: null, effort: null })).toEqual({ provider: 'codex' });
    const pick = { provider: 'claude-code', model: 'claude-opus', effort: 'high' };
    expect(readModelSetting(modelSetting(pick))).toEqual(pick);
    expect(readModelSetting({})).toBeNull();
    expect(readModelSetting({ provider: '' })).toBeNull();
    expect(readModelSetting('codex')).toBeNull();
  });
});

describe('the search reads words, not scattered letters', () => {
  it('finds "grid" in a colour’s name and never in "Big trades"', () => {
    const entries = [
      ...modelEntries(),
      {
        id: 'chart.colour.canvas.gridHorizontal',
        category: 'chart' as const,
        label: 'Horizontal grid',
        path: 'Chart · Canvas',
        keywords: ['colour'],
      },
      {
        id: 'app.key.bigTrades',
        category: 'app' as const,
        label: 'Big trades: show or hide',
        path: 'App · Keyboard shortcuts · Chart',
        keywords: ['shortcut'],
      },
    ];
    const ids = searchSettings(entries, 'grid').map((e) => e.id);
    expect(ids[0]).toBe('chart.colour.canvas.gridHorizontal');
    expect(ids).not.toContain('app.key.bigTrades');
  });
});

describe('the runtime’s words as a sentence', () => {
  it('ends them once, and opens them on a capital when asked', () => {
    expect(endSentence('  no route to the gateway ')).toBe('no route to the gateway.');
    expect(endSentence('Refused.')).toBe('Refused.');
    expect(endSentence('Refused!')).toBe('Refused!');
    expect(asSentence(' no route ')).toBe('No route.');
    expect(asSentence('Who?')).toBe('Who?');
  });
});
