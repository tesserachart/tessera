import { describe, expect, it } from 'vitest';
import { LEVELS } from '../src/chart/levelSettings.ts';
import { readSetting, receiveSettings } from '../src/state/runtimeSettings.ts';
import { setLevels } from '../src/state/tradeSettings.ts';
import { answeringClient, setTestServices } from './support/runtime.tsx';

describe('a level setting changed before the settings have loaded', () => {
  it('is kept over the stored one when they land, and saved', async () => {
    const { client, calls } = answeringClient({
      'settings.set': () => new Promise(() => undefined) as never,
    });
    setTestServices(client);
    const mine = { sources: { 'levels-vendor.gamma': false }, levels: {} };
    setLevels(mine);
    receiveSettings({ 'chart.levels': { sources: { 'levels-vendor.gamma': true }, levels: {} } }, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(readSetting(LEVELS)).toEqual(mine);
    expect(calls.filter((c) => c.name === 'settings.set').map((c) => c.input)).toEqual([
      { key: 'chart.levels', value: mine },
    ]);
  });
});
