import { describe, expect, it } from 'vitest';
import {
  groupOptions,
  moveActive,
  normalizeQuery,
  rankOptions,
  scoreOption,
  type SearchOption,
} from '../src/search.ts';

const INDICATORS: SearchOption[] = [
  { value: 'vwap', label: 'VWAP', group: 'Trend', keywords: ['volume weighted average price'] },
  { value: 'ema', label: 'EMA', group: 'Trend', keywords: ['exponential moving average'] },
  { value: 'rsi', label: 'RSI', group: 'Momentum', keywords: ['relative strength index'] },
  { value: 'svp', label: 'Session volume profile', group: 'Order flow' },
  { value: 'vol', label: 'Volume', group: 'Order flow' },
  { value: 'cvd', label: 'Cumulative delta', group: 'Order flow', keywords: ['cvd'] },
];
const values = (os: readonly SearchOption[]) => os.map((o) => o.value);

describe('the searchable list: matching and ranking', () => {
  it('normalizes a query: case, accents and runs of space', () => {
    expect(normalizeQuery('  Relative   STRENGTH ')).toBe('relative strength');
    expect(normalizeQuery('Zürich')).toBe('zurich');
  });

  it('keeps every option in its order for an empty query', () => {
    expect(values(rankOptions(INDICATORS, ''))).toEqual(values(INDICATORS));
    expect(values(rankOptions(INDICATORS, '   '))).toEqual(values(INDICATORS));
  });

  it('ranks the whole label, then its start, then a later word, then a keyword, then the letters in order', () => {
    expect(values(rankOptions(INDICATORS, 'vol'))).toEqual(['vol', 'svp', 'vwap']);
    expect(scoreOption({ label: 'Volume' }, 'volume')).toBeGreaterThan(
      scoreOption({ label: 'Volume profile' }, 'volume'),
    );
    expect(scoreOption({ label: 'Session volume' }, 'vol')).toBeGreaterThan(scoreOption({ label: 'Involved' }, 'vol'));
    expect(scoreOption({ label: 'Involved' }, 'vol')).toBeGreaterThan(
      scoreOption({ label: 'X', keywords: ['vol'] }, 'vol'),
    );
    expect(scoreOption({ label: 'VWAP' }, 'vwp')).toBeGreaterThan(0);
    expect(scoreOption({ label: 'VWAP' }, 'x')).toBe(0);
  });

  it('finds a word that starts at a later hit ("ma" starts "max" after "gamma")', () => {
    expect(scoreOption({ label: 'gamma max' }, 'max')).toBe(60);
    expect(scoreOption({ label: 'gamma max' }, 'ma')).toBe(60);
  });

  it('needs every word of the query; the label starting with the whole query ranks first', () => {
    expect(values(rankOptions(INDICATORS, 'relative strength'))).toEqual(['rsi']);
    expect(values(rankOptions(INDICATORS, 'session vol'))).toEqual(['svp']);
    expect(values(rankOptions(INDICATORS, 'session rsi'))).toEqual([]);
    const two = [
      { value: 'a', label: 'Profile session' },
      { value: 'b', label: 'Session profile' },
    ];
    expect(values(rankOptions(two, 'session profile'))).toEqual(['b', 'a']);
  });

  it('keeps the given order between equal matches, and disabled options with the rest', () => {
    const tie = [
      { value: 'b', label: 'Bid delta', disabled: true },
      { value: 'a', label: 'Ask delta' },
    ];
    expect(values(rankOptions(tie, 'delta'))).toEqual(['b', 'a']);
  });
});

describe('the searchable list: groups', () => {
  it('groups rows where the group first falls, unheaded rows as their own group', () => {
    const groups = groupOptions(rankOptions(INDICATORS, 'vol'));
    expect(groups.map((g) => g.group)).toEqual(['Order flow', 'Trend']);
    expect(groups.map((g) => values(g.options))).toEqual([['vol', 'svp'], ['vwap']]);
    const loose = groupOptions([
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y', group: 'G' },
      { value: 'z', label: 'Z' },
    ]);
    expect(loose.map((g) => [g.group, values(g.options)])).toEqual([
      [undefined, ['x', 'z']],
      ['G', ['y']],
    ]);
  });
});

describe('the searchable list: the keyboard', () => {
  const rows = [
    { value: 'a', disabled: true },
    { value: 'b' },
    { value: 'c', disabled: true },
    { value: 'd' },
    { value: 'e' },
  ];

  it('steps over disabled rows and stops at the ends unless it loops', () => {
    expect(moveActive(rows, 'b', 1)).toBe('d');
    expect(moveActive(rows, 'd', -1)).toBe('b');
    expect(moveActive(rows, 'b', -1)).toBe('b');
    expect(moveActive(rows, 'e', 1)).toBe('e');
    expect(moveActive(rows, 'e', 1, true)).toBe('b');
    expect(moveActive(rows, 'b', -1, true)).toBe('e');
  });

  it('pages land on the last enabled row that way; Home and End go to the ends', () => {
    expect(moveActive(rows, 'b', 8)).toBe('e');
    expect(moveActive(rows, 'e', -8, true)).toBe('b');
    expect(moveActive(rows, 'd', 'first')).toBe('b');
    expect(moveActive(rows, 'b', 'last')).toBe('e');
  });

  it('starts from an end when nothing is active, and has nowhere to go in an empty or all-disabled list', () => {
    expect(moveActive(rows, null, 1)).toBe('b');
    expect(moveActive(rows, null, -1)).toBe('e');
    expect(moveActive(rows, 'gone', 1)).toBe('b');
    expect(moveActive([], null, 1)).toBeNull();
    expect(moveActive([{ value: 'x', disabled: true }], null, 'first')).toBeNull();
  });
});
