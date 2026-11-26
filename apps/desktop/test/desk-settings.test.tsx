import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  putRuntimeSettings,
  readSetting,
  useSetting,
  useSettingSave,
  watchSetting,
} from '../src/state/runtimeSettings.ts';
import { defineSetting } from '../src/state/setting.ts';
import { answeringClient, setTestServices, type FakeClient } from './support/runtime.tsx';

let made = 0;
const limitSetting = () =>
  defineSetting(`test.limit${String(++made)}`, (v) => ({ max: typeof v === 'number' ? v : 3 }));

afterEach(() => {
  putRuntimeSettings({}, true);
});

describe('a desk setting', () => {
  it('reads its stored value through its own decoder, and the same object while the value stays', () => {
    const LIMIT = limitSetting();
    putRuntimeSettings({ [LIMIT.key]: 5 }, true);
    const first = readSetting(LIMIT);
    putRuntimeSettings({ 'other.key': 1 }, false);
    expect(first).toEqual({ max: 5 });
    expect(readSetting(LIMIT)).toBe(first);
  });

  it('falls back to its decoder’s default when nothing is stored', () => {
    const LIMIT = limitSetting();
    expect(readSetting(LIMIT)).toEqual({ max: 3 });
  });

  it('re-renders a component with the new value', () => {
    const LIMIT = limitSetting();
    const { result } = renderHook(() => useSetting(LIMIT));
    expect(result.current).toEqual({ max: 3 });
    act(() => putRuntimeSettings({ [LIMIT.key]: 8 }, false));
    expect(result.current).toEqual({ max: 8 });
  });

  it('tells a watcher only when its own value changes', () => {
    const LIMIT = limitSetting();
    const heard: number[] = [];
    const off = watchSetting(LIMIT, (v) => heard.push(v.max));
    putRuntimeSettings({ 'other.key': 2 }, false);
    putRuntimeSettings({ [LIMIT.key]: 9 }, false);
    putRuntimeSettings({ 'other.key': 3 }, false);
    off();
    expect(heard).toEqual([9]);
  });
});

describe('saving a desk setting from a row', () => {
  function refusing(message: (key: string) => string): FakeClient {
    return {
      request: (method: string, params: { name?: string; input?: { key: string } }) =>
        method === 'tools.invoke' && params.name === 'settings.set'
          ? Promise.resolve({ ok: false, error: { message: message(params.input!.key) } })
          : new Promise(() => undefined),
    };
  }

  it('shows the runtime’s refusal on the row in plain words, and keeps the stored value', async () => {
    const LIMIT = limitSetting();
    setTestServices(refusing((key) => `${key}: must be under 10`));
    putRuntimeSettings({ [LIMIT.key]: 5 }, true);
    const { result } = renderHook(() => useSettingSave(LIMIT));
    await act(async () => {
      await result.current.save(12);
    });
    expect(result.current.error).toBe('Must be under 10');
    expect(readSetting(LIMIT)).toEqual({ max: 5 });
  });

  it('clears the row’s refusal when the next save goes through', async () => {
    const LIMIT = limitSetting();
    setTestServices(refusing((key) => `${key}: must be under 10`));
    const { result } = renderHook(() => useSettingSave(LIMIT));
    await act(async () => {
      await result.current.save(12);
    });
    const { client } = answeringClient({
      'settings.set': (input) => ({ key: input.key, value: input.value, previous: null }),
    });
    setTestServices(client);
    await act(async () => {
      await result.current.save(7);
    });
    expect(result.current.error).toBeNull();
    expect(readSetting(LIMIT)).toEqual({ max: 7 });
  });
});

const SRC = join(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

function filesSaying(pattern: RegExp): string[] {
  return sources(SRC)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path).split('\\').join('/'))
    .sort();
}

describe('one place for desk settings', () => {
  it('keeps the settings the desk holds behind the setting interface', () => {
    expect(filesSaying(/\bruntimeSettingsStore\b/)).toEqual(['state/runtimeSettings.ts']);
  });

  it('asks the runtime for settings and saves them in that one module', () => {
    expect(filesSaying(/\(\s*'settings\.(get|set)'/)).toEqual(['state/runtimeSettings.ts']);
  });
});
