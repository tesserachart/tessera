import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { read } from '../src/app/store.ts';
import { setLevels, tradeSettingsStore, useTradeSettingsSync } from '../src/state/tradeSettings.ts';
import { answeringClient, seedTools, TestRuntime } from './support/runtime.tsx';

describe('a level setting changed before the settings have loaded', () => {
  it('is kept over the stored one when they land, and saved', async () => {
    let stored: (out: unknown) => void = () => undefined;
    const { client, calls } = answeringClient({
      'settings.get': () =>
        new Promise((resolve) => {
          stored = resolve;
        }) as never,
      'settings.set': (input) => ({ key: input.key, value: input.value, previous: null }),
    });
    seedTools(['settings.get', 'settings.set']);
    const wrapper = ({ children }: { children: ReactNode }) => <TestRuntime client={client}>{children}</TestRuntime>;
    renderHook(() => useTradeSettingsSync(), { wrapper });
    const mine = { sources: { 'levels-vendor.gamma': false }, levels: {} };
    setLevels(mine);
    await act(async () => {
      stored({
        settings: {
          'chart.levels': {
            key: 'chart.levels',
            value: { sources: { 'levels-vendor.gamma': true }, levels: {} },
            default: null,
            description: 'Levels',
            schema: null,
            userOnly: false,
          },
        },
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(read(tradeSettingsStore).levels).toEqual(mine);
    expect(calls.filter((c) => c.name === 'settings.set').map((c) => c.input)).toEqual([
      { key: 'chart.levels', value: mine },
    ]);
  });
});
