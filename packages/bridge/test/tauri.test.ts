import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTrafficLights, makeTauriBridge } from '../src/tauri.ts';
import { HostError, makeBridge, parseTileWindowSearch, runningInTauri } from '../src/index.ts';

const calls: { cmd: string; args: unknown }[] = [];
const windows: string[] = [];
const failing = new Map<string, string>();

beforeEach(() => {
  calls.length = 0;
  windows.splice(0, windows.length, 'main');
  failing.clear();
  mockWindows('main');
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const failure = failing.get(cmd);
      if (failure !== undefined) throw new Error(failure);
      switch (cmd) {
        case 'runtime_connection':
          return { port: 7417, token: 'sidecar-token' };
        case 'notify':
        case 'save_file':
          return true;
        case 'pick_files':
          return [{ name: 'a.csv', path: '/tmp/a.csv', dataBase64: btoa('x,y') }];
        case 'open_external':
          return null;
        case 'update_check':
          return { version: '0.9.0', notes: 'Faster charts' };
        case 'plugin:window|get_all_windows':
          return windows;
        case 'plugin:webview|create_webview_window':
          windows.push((args as { options: { label: string } }).options.label);
          return null;
        case 'plugin:window|is_maximized':
          return true;
        case 'plugin:window|outer_position':
          return { x: 80, y: 120 };
        case 'plugin:window|outer_size':
          return { width: 1800, height: 1400 };
        case 'plugin:window|scale_factor':
          return 2;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
});

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  delete (globalThis as { isTauri?: unknown }).isTauri;
});

const UPDATE_EVENT = 'tessera://update';

const shellSource = (file: string) =>
  readFileSync(join(import.meta.dirname, '../../../apps/desktop/src-tauri', file), 'utf8');

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe('Tauri bridge', () => {
  it('wears macOS traffic lights on the main window of a Mac, and none on Linux', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(hasTrafficLights('main', mac)).toBe(true);
    expect(hasTrafficLights('main', linux)).toBe(false);
  });

  it('reads the sidecar connection from the runtime_connection command', async () => {
    const bridge = makeTauriBridge();
    expect(await bridge.runtimeConnection()).toEqual({
      wsUrl: 'ws://127.0.0.1:7417/ws',
      credential: { token: 'sidecar-token' },
      source: 'tauri',
    });
    failing.set('runtime_connection', 'sidecar exited');
    await expect(bridge.runtimeConnection()).rejects.toMatchObject({
      _tag: 'HostError',
      operation: 'runtime_connection',
      message: 'runtime_connection: sidecar exited',
    });
  });

  it('marshals files as base64 and validates external URLs before invoking', async () => {
    const bridge = makeTauriBridge();
    expect(await bridge.saveFile({ suggestedName: 'x.txt', data: 'hi' })).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      cmd: 'save_file',
      args: { suggestedName: 'x.txt', dataBase64: btoa('hi') },
    });
    const picked = await bridge.pickFile({ filters: [{ name: 'CSV', extensions: ['csv'] }] });
    expect(calls.at(-1)).toMatchObject({
      cmd: 'pick_files',
      args: { multiple: false, filters: [{ name: 'CSV', extensions: ['csv'] }] },
    });
    expect(new TextDecoder().decode(picked[0]!.data)).toBe('x,y');
    expect(picked[0]!.path).toBe('/tmp/a.csv');
    await bridge.openExternal('https://tesserachart.com/');
    expect(calls.at(-1)).toMatchObject({ cmd: 'open_external', args: { url: 'https://tesserachart.com/' } });
    await expect(bridge.openExternal('file:///etc/passwd')).rejects.toMatchObject({ _tag: 'UnsafeUrl' });
    expect(calls.at(-1)).toMatchObject({ cmd: 'open_external', args: { url: 'https://tesserachart.com/' } });
    expect(await bridge.notify({ title: 'Fill', body: 'BUY 25 QQQ' })).toBe(true);
    expect(calls.at(-1)).toMatchObject({ cmd: 'notify', args: { title: 'Fill', body: 'BUY 25 QQQ' } });
    failing.set('save_file', 'disk full');
    await expect(bridge.saveFile({ suggestedName: 'x.txt', data: 'hi' })).rejects.toMatchObject({
      _tag: 'HostError',
      operation: 'save_file',
    });
  });

  it('opens one window per tile, focuses it when asked again, and reports its bounds in logical pixels', async () => {
    const bridge = makeTauriBridge();
    expect(await bridge.openWindow({ kind: 'chart', id: 'pop chart.2', title: 'NQ Z6' })).toBe(true);
    expect(await bridge.openWindow({ kind: 'chart', id: 'pop chart.2', title: 'NQ Z6' })).toBe(true);
    const created = calls.filter((c) => c.cmd === 'plugin:webview|create_webview_window');
    expect(created).toHaveLength(1);
    const { url } = (created[0]?.args as { options: { url: string } }).options;
    expect(parseTileWindowSearch(url.slice('index.html'.length))).toMatchObject({ kind: 'chart', id: 'pop chart.2' });
    expect(calls.at(-1)?.cmd).toBe('plugin:window|set_focus');
    expect(await bridge.windowBounds('pop chart.2')).toEqual({ x: 40, y: 60, width: 900, height: 700 });
    expect(await bridge.windowBounds('never-opened')).toBeNull();
    expect(await bridge.thisWindowBounds()).toEqual({ x: 40, y: 60, width: 900, height: 700 });
    failing.set('plugin:webview|create_webview_window', 'no display');
    await expect(bridge.openWindow({ kind: 'chart', id: 'pop-chart-3', title: 'ES Z6' })).rejects.toMatchObject({
      _tag: 'HostError',
      operation: 'openWindow',
    });
  });

  it('builds a tile window hidden and shows it only once its page is in it, like the main window', async () => {
    const bridge = makeTauriBridge();
    await bridge.openWindow({ kind: 'chart', id: 'c1', title: 'NQ', width: 1600, height: 1000 });
    const created = calls.find((c) => c.cmd === 'plugin:webview|create_webview_window');
    expect((created?.args as { options: { visible: boolean } }).options.visible).toBe(false);
    const order = calls.map((c) => c.cmd).filter((cmd) => /create_webview_window|\|show$|set_focus/.test(cmd));
    expect(order).toEqual(['plugin:webview|create_webview_window', 'plugin:window|show', 'plugin:window|set_focus']);
  });

  it('tells when a tile window it opened is destroyed; never for one that is not open, nor once stopped', async () => {
    const bridge = makeTauriBridge();
    await bridge.openWindow({ kind: 'chart', id: 'c1', title: 'NQ' });
    const closed = vi.fn();
    const unknown = vi.fn();
    const stopped = vi.fn();
    bridge.onWindowClosed('c1', closed);
    bridge.onWindowClosed('never-opened', unknown);
    const stop = bridge.onWindowClosed('c1', stopped);
    await settle();
    stop();
    await emit('tauri://destroyed');
    expect(closed).toHaveBeenCalledOnce();
    expect(unknown).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    const early = vi.fn();
    bridge.onWindowClosed('c1', early)();
    await settle();
    await emit('tauri://destroyed');
    expect(early).not.toHaveBeenCalled();
  });

  it('drives the window’s own controls and reports its resizes until stopped', async () => {
    const bridge = makeTauriBridge();
    const controls = bridge.window!;
    await controls.minimize();
    await controls.toggleMaximize();
    await controls.startDragging();
    await controls.close();
    expect(await controls.isMaximized()).toBe(true);
    await controls.focus();
    expect(calls.map((c) => c.cmd)).toEqual([
      'plugin:window|minimize',
      'plugin:window|toggle_maximize',
      'plugin:window|start_dragging',
      'plugin:window|close',
      'plugin:window|is_maximized',
      'plugin:window|unminimize',
      'plugin:window|set_focus',
    ]);
    expect(calls.every((c) => (c.args as { label?: string }).label === 'main')).toBe(true);
    await bridge.setWindowTitle('Tessera — PAPER — Day');
    expect(calls.at(-1)).toMatchObject({
      cmd: 'plugin:window|set_title',
      args: { label: 'main', value: 'Tessera — PAPER — Day' },
    });
    failing.set('plugin:window|minimize', 'not allowed');
    await expect(controls.minimize()).rejects.toThrow(HostError);
    await expect(controls.minimize()).rejects.toMatchObject({ operation: 'minimize' });
    failing.set('plugin:window|set_focus', 'not allowed');
    await expect(controls.focus()).rejects.toMatchObject({ operation: 'focus' });
    const resized = vi.fn();
    const stop = controls.onResized(resized);
    await settle();
    await emit('tauri://resize', { width: 1600, height: 1000 });
    expect(resized).toHaveBeenCalledOnce();
    stop();
    await settle();
    await emit('tauri://resize', { width: 1200, height: 800 });
    expect(resized).toHaveBeenCalledOnce();
  });

  it('checks, downloads and installs an update as three separate shell commands', async () => {
    const updates = makeTauriBridge().updates!;
    expect(await updates.check()).toEqual({ version: '0.9.0', notes: 'Faster charts' });
    expect(calls.map((c) => c.cmd)).toEqual(['update_check']);
    await updates.download();
    await updates.installAndRestart();
    expect(calls.map((c) => c.cmd)).toEqual(['update_check', 'update_download', 'update_install']);
    failing.set('update_download', 'signature mismatch');
    await expect(updates.download()).rejects.toMatchObject({
      _tag: 'HostError',
      operation: 'update_download',
      message: 'update_download: signature mismatch',
    });
  });

  it('listens for updates on the event the shell emits them on', () => {
    expect(shellSource('src/updates.rs')).toContain(`pub const EVENT: &str = "${UPDATE_EVENT}";`);
  });

  it('hears the menu ask for a check and the download progress, until it stops listening', async () => {
    const updates = makeTauriBridge().updates!;
    const heard = vi.fn();
    const stop = updates.onEvent(heard);
    await settle();
    await emit(UPDATE_EVENT, { kind: 'check' });
    await emit(UPDATE_EVENT, { kind: 'downloading', version: '0.9.0', downloaded: 512, total: 2048 });
    expect(heard.mock.calls).toEqual([
      [{ kind: 'check' }],
      [{ kind: 'downloading', version: '0.9.0', downloaded: 512, total: 2048 }],
    ]);
    stop();
    await settle();
    await emit(UPDATE_EVENT, { kind: 'check' });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('makeBridge picks Tauri only inside the Tauri webview', async () => {
    expect(runningInTauri()).toBe(false);
    expect((await makeBridge({ fetch: () => Promise.reject(new Error('x')) })).kind).toBe('browser');
    (globalThis as { isTauri?: unknown }).isTauri = true;
    expect((await makeBridge()).kind).toBe('tauri');
  });
});
