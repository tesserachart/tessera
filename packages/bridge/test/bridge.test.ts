import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostError,
  host,
  makeBridge,
  makeBrowserBridge,
  RuntimeNotFound,
  RuntimeUnavailable,
  UnsafeUrl,
} from '../src/index.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const location = (href: string) => {
  const u = new URL(href);
  return { href: u.href, protocol: u.protocol, host: u.host, reload: () => undefined };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Bridge', () => {
  it('types why the dev server has no runtime yet', async () => {
    const bridge = makeBrowserBridge({
      discovery: 'dev',
      fetch: () => Promise.resolve(json({ state: 'starting', message: 'building the runtime…' }, 503)),
      location: location('http://localhost:5173/'),
    });
    await expect(bridge.runtimeConnection()).rejects.toThrow(RuntimeUnavailable);
    await expect(bridge.runtimeConnection()).rejects.toMatchObject({
      _tag: 'RuntimeUnavailable',
      problem: 'runtime_starting',
      message: 'building the runtime…',
    });
  });

  it('words an unsafe URL', () => {
    expect(new UnsafeUrl({ url: 'file:///etc/passwd' }).message).toBe(
      'refusing to open file:///etc/passwd: only http, https and mailto URLs are allowed',
    );
  });

  it('types a dev page with no runtime.json and an unsafe external URL', async () => {
    const bridge = makeBrowserBridge({
      discovery: 'dev',
      fetch: () => Promise.resolve(new Response('', { status: 404 })),
      location: location('http://localhost:5173/'),
    });
    await expect(bridge.runtimeConnection()).rejects.toThrow(RuntimeNotFound);
    await expect(bridge.openExternal('javascript:alert(1)')).rejects.toThrow(UnsafeUrl);
  });

  it('wraps what the host throws as a HostError naming the operation, and passes its answer through', async () => {
    await expect(host('save_file', () => Promise.resolve(true))).resolves.toBe(true);
    const disk = new Error('disk full');
    await expect(host('save_file', () => Promise.reject(disk))).rejects.toThrow(HostError);
    await expect(host('save_file', () => Promise.reject(disk))).rejects.toMatchObject({
      _tag: 'HostError',
      operation: 'save_file',
      reason: disk,
      message: 'save_file: disk full',
    });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- what Tauri's invoke does
    const refused = host('notify', () => Promise.reject('refused'));
    await expect(refused).rejects.toMatchObject({ _tag: 'HostError', reason: 'refused', message: 'notify: refused' });
    await expect(
      host('notify', () => {
        throw new Error('no window');
      }),
    ).rejects.toMatchObject({ _tag: 'HostError', message: 'notify: no window' });
  });

  it('calls onWindowClosed’s listener when the popup closes; never for one it did not open, nor once stopped', async () => {
    vi.useFakeTimers();
    const popup = { closed: false, focus: () => undefined } as unknown as Window;
    const win = Object.assign(Object.create(window) as Window & typeof globalThis, { open: () => popup });
    const bridge = makeBrowserBridge({ fetch: () => Promise.reject(new Error('x')), window: win });
    expect(await bridge.openWindow({ kind: 'chart', id: 'c1', title: 'NQ' })).toBe(true);
    const closed = vi.fn();
    const unknown = vi.fn();
    const stopped = vi.fn();
    bridge.onWindowClosed('c1', closed);
    bridge.onWindowClosed('never-opened', unknown);
    bridge.onWindowClosed('c1', stopped)();
    (popup as { closed: boolean }).closed = true;
    vi.advanceTimersByTime(600);
    expect(closed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1200);
    expect(closed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(unknown).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
  });

  it('makeBridge is the browser bridge outside Tauri', async () => {
    const bridge = await makeBridge({ fetch: () => Promise.reject(new Error('x')) });
    expect(bridge.kind).toBe('browser');
    expect(bridge.window).toBeNull();
    expect(bridge.updates).toBeNull();
  });
});
