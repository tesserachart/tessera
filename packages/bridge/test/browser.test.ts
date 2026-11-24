import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertExternalUrl,
  base64ToBytes,
  bytesToBase64,
  HostError,
  makeBrowserBridge,
  parseTileWindowSearch,
  RELOAD_TICKET_KEY,
  RuntimeNotFound,
  RuntimeUnavailable,
  tileWindowSearch,
  UnsafeUrl,
  type BrowserBridgeOptions,
  type RuntimeConnection,
} from '../src/index.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeLocation(href: string) {
  const u = new URL(href);
  return { href: u.href, protocol: u.protocol, host: u.host, reload: vi.fn() };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    items,
    writes,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push(`${k}=${v}`);
      items.set(k, v);
    },
    removeItem: (k: string) => {
      items.delete(k);
    },
  };
}

/** What a page posts on a `BroadcastChannel` reaches every other page on it, a task later. */
function fakeOrigin() {
  const pages = new Set<EventTarget>();
  const posted: unknown[] = [];
  const channel = () => {
    const me = new EventTarget();
    pages.add(me);
    return {
      addEventListener: me.addEventListener.bind(me),
      postMessage: (data: unknown) => {
        posted.push(data);
        for (const other of pages) {
          if (other !== me) setTimeout(() => other.dispatchEvent(new MessageEvent('message', { data })), 0);
        }
      },
    } as unknown as BroadcastChannel;
  };
  return { channel, posted };
}

const html = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
const served = () => Promise.resolve(html());

function page(href: string, options: Partial<BrowserBridgeOptions> = {}) {
  const events = new EventTarget();
  const history = { state: null, replaceState: vi.fn() };
  const sessionStorage = fakeStorage();
  const localStorage = fakeStorage();
  const location = fakeLocation(href);
  const bridge = makeBrowserBridge({
    discovery: 'served',
    fetch: vi.fn(served),
    location,
    history,
    sessionStorage,
    localStorage,
    channel: null,
    window: Object.assign(events, { history }) as unknown as Window & typeof globalThis,
    ...options,
  });
  return { bridge, events, history, location, sessionStorage, localStorage };
}

async function rejection<E extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
  const error = await promise.then(
    () => expect.unreachable('expected a rejection'),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  return error as E;
}

function sessionOf(c: RuntimeConnection) {
  if (!c.session) throw new Error('no session');
  return c.session;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('browser bridge discovery', () => {
  it('uses /runtime.json in dev, which says where the runtime is and nothing else', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse({ port: 7417 })));
    const bridge = makeBrowserBridge({ fetch, channel: null, location: fakeLocation('http://localhost:5173/') });
    expect(await bridge.runtimeConnection()).toMatchObject({
      wsUrl: 'ws://127.0.0.1:7417/ws',
      credential: null,
      source: 'dev',
    });
    expect(fetch).toHaveBeenCalledWith('/runtime.json', expect.objectContaining({ cache: 'no-store' }));
  });

  it('honours an explicit url in runtime.json', async () => {
    const fetch = () => Promise.resolve(jsonResponse({ port: 1, url: 'ws://localhost:9999/ws' }));
    const bridge = makeBrowserBridge({ fetch, channel: null, location: fakeLocation('http://localhost:5173/') });
    expect((await bridge.runtimeConnection()).wsUrl).toBe('ws://localhost:9999/ws');
  });

  it('re-reads runtime.json on every call so a restarted runtime is found', async () => {
    let port = 1000;
    const fetch = () => Promise.resolve(jsonResponse({ port: port++ }));
    const bridge = makeBrowserBridge({ fetch, channel: null, location: fakeLocation('http://localhost:5173/') });
    expect((await bridge.runtimeConnection()).wsUrl).toContain(':1000/');
    expect((await bridge.runtimeConnection()).wsUrl).toContain(':1001/');
  });

  it('falls back to the served page’s own runtime when there is no /runtime.json', async () => {
    const at = (fetch: typeof globalThis.fetch, href: string) =>
      makeBrowserBridge({ fetch, channel: null, location: fakeLocation(href) }).runtimeConnection();
    expect(await at(served, 'https://box.example:8443/')).toMatchObject({
      wsUrl: 'wss://box.example:8443/ws',
      source: 'served',
    });
    const notFound = () => Promise.resolve(new Response('nope', { status: 404 }));
    expect((await at(notFound, 'http://127.0.0.1:7417/')).source).toBe('served');
    const failing = () => Promise.reject(new TypeError('network'));
    expect((await at(failing, 'http://127.0.0.1:7417/')).wsUrl).toBe('ws://127.0.0.1:7417/ws');
  });

  it('dev discovery fails loudly when runtime.json is missing', async () => {
    const notFound = () => Promise.resolve(new Response('', { status: 404 }));
    const bridge = makeBrowserBridge({
      discovery: 'dev',
      fetch: notFound,
      location: fakeLocation('http://localhost:5173/'),
    });
    const error = await rejection(bridge.runtimeConnection(), RuntimeNotFound);
    expect(error._tag).toBe('RuntimeNotFound');
    expect(error.message).toMatch(/runtime\.json/);
  });

  it('dev discovery says why the dev server has no runtime yet', async () => {
    const message =
      'The runtime cannot start: data directory /d/tessera-x is in use by another tessera-runtime (pid 42); …';
    const fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: 'runtime unavailable', state: 'data_dir_locked', message }, 503)),
    );
    const bridge = makeBrowserBridge({
      discovery: 'dev',
      fetch,
      location: fakeLocation('http://localhost:5173/'),
    });
    const error = await rejection(bridge.runtimeConnection(), RuntimeUnavailable);
    expect(error).toMatchObject({ _tag: 'RuntimeUnavailable', problem: 'data_dir_locked' });
    expect(error.message).toBe(message);
    for (const [state, problem] of [
      ['starting', 'runtime_starting'],
      ['failed', 'runtime_failed'],
    ] as const) {
      fetch.mockImplementation(() => Promise.resolve(jsonResponse({ state, message: `m-${state}` }, 503)));
      await expect(bridge.runtimeConnection()).rejects.toMatchObject({
        _tag: 'RuntimeUnavailable',
        problem,
        message: `m-${state}`,
      });
    }
    fetch.mockImplementation(() => Promise.resolve(jsonResponse({}, 503)));
    const generic = await rejection(bridge.runtimeConnection(), RuntimeNotFound);
    expect(generic._tag).toBe('RuntimeNotFound');
    expect(generic.message).toMatch(/runtime\.json is unavailable/);
  });
});

describe('a browser page’s session', () => {
  const TOKEN = `tss_${'a'.repeat(64)}`;

  it('takes the launch link’s ticket out of the address bar, and keeps the token it brings in memory only', async () => {
    const origin = fakeOrigin();
    const p = page('http://127.0.0.1:7420/?area=trade#ticket=tst_L&panel=x', { channel: origin.channel() });
    expect(p.history.replaceState).toHaveBeenCalledWith(null, '', '/?area=trade#panel=x');
    const c = await p.bridge.runtimeConnection();
    expect(c.credential).toEqual({ ticket: 'tst_L' });
    expect(c.wsUrl).toBe('ws://127.0.0.1:7420/ws');
    expect(origin.posted).toEqual([]);
    sessionOf(c).kept({ reloadTicket: 'tst_1', token: TOKEN });
    expect(origin.posted).toEqual([{ kind: 'token', token: TOKEN }]);
    expect((await p.bridge.runtimeConnection()).credential).toEqual({ token: TOKEN });
    p.events.dispatchEvent(new Event('pagehide'));
    expect(p.sessionStorage.writes).toEqual([`${RELOAD_TICKET_KEY}=tst_1`]);
    expect([...p.sessionStorage.writes, ...p.localStorage.writes].join()).not.toContain(TOKEN);
  });

  it('announces nothing when the runtime refuses the launch ticket (an old link)', async () => {
    const origin = fakeOrigin();
    const p = page('http://127.0.0.1:7420/#ticket=tst_used', { channel: origin.channel() });
    sessionOf(await p.bridge.runtimeConnection()).refused('session_missing');
    vi.useFakeTimers();
    const next = p.bridge.runtimeConnection();
    await vi.advanceTimersByTimeAsync(300);
    expect((await next).credential).toBeNull();
    expect(origin.posted).toEqual([{ kind: 'ask', from: expect.any(String) }]);
  });

  it('reloads when a launch link is opened in a tab already on the page', () => {
    const p = page('http://127.0.0.1:7420/');
    p.events.dispatchEvent(new Event('hashchange'));
    expect(p.location.reload).not.toHaveBeenCalled();
    p.location.href = 'http://127.0.0.1:7420/#ticket=tst_L';
    p.events.dispatchEvent(new Event('hashchange'));
    expect(p.location.reload).toHaveBeenCalledOnce();
  });

  it('removes the token earlier versions kept in localStorage', () => {
    const localStorage = fakeStorage({ 'tessera.runtime-token': TOKEN });
    page('http://127.0.0.1:7420/', { localStorage });
    expect(localStorage.items.size).toBe(0);
  });

  it('comes back from a reload with its one-time ticket, written only as the page unloads', async () => {
    const first = page('http://127.0.0.1:7420/#ticket=tst_L');
    sessionOf(await first.bridge.runtimeConnection()).kept({ reloadTicket: 'tst_1', token: TOKEN });
    expect(first.sessionStorage.writes).toEqual([]);
    first.events.dispatchEvent(new Event('pagehide'));
    expect(first.sessionStorage.writes).toEqual([`${RELOAD_TICKET_KEY}=tst_1`]);

    const reloaded = page('http://127.0.0.1:7420/', { sessionStorage: first.sessionStorage });
    expect(first.sessionStorage.items.size).toBe(0);
    const again = await reloaded.bridge.runtimeConnection();
    expect(again.credential).toEqual({ ticket: 'tst_1' });
    sessionOf(again).kept({ reloadTicket: 'tst_2', token: TOKEN });
    expect((await reloaded.bridge.runtimeConnection()).credential).toEqual({ token: TOKEN });
    expect(first.sessionStorage.items.size).toBe(0);
  });

  it('keeps a ticket until the runtime answered it', async () => {
    vi.useFakeTimers();
    const p = page('http://127.0.0.1:7420/#ticket=tst_L', { channel: fakeOrigin().channel() });
    expect((await p.bridge.runtimeConnection()).credential).toEqual({ ticket: 'tst_L' });
    const second = await p.bridge.runtimeConnection();
    expect(second.credential).toEqual({ ticket: 'tst_L' });
    sessionOf(second).refused('session_missing');
    const third = p.bridge.runtimeConnection();
    await vi.advanceTimersByTimeAsync(300);
    expect((await third).credential).toBeNull();
  });

  it('opened again in a live tab, an old link is refused and the tab comes back with its own ticket', async () => {
    const first = page('http://127.0.0.1:7420/#ticket=tst_L');
    sessionOf(await first.bridge.runtimeConnection()).kept({ reloadTicket: 'tst_1', token: TOKEN });
    first.events.dispatchEvent(new Event('pagehide'));
    const again = page('http://127.0.0.1:7420/#ticket=tst_L', { sessionStorage: first.sessionStorage });
    const old = await again.bridge.runtimeConnection();
    expect(old.credential).toEqual({ ticket: 'tst_L' });
    sessionOf(old).refused('session_missing');
    const own = await again.bridge.runtimeConnection();
    expect(own.credential).toEqual({ ticket: 'tst_1' });
    sessionOf(own).kept({ reloadTicket: 'tst_2', token: TOKEN });
    expect((await again.bridge.runtimeConnection()).credential).toEqual({ token: TOKEN });
  });

  it('takes back the ticket it wrote when the page returns from the back/forward cache', async () => {
    const p = page('http://127.0.0.1:7420/#ticket=tst_L');
    sessionOf(await p.bridge.runtimeConnection()).kept({ reloadTicket: 'tst_1', token: TOKEN });
    p.events.dispatchEvent(new Event('pagehide'));
    p.events.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(p.sessionStorage.items.size).toBe(0);
  });

  it('writes no ticket once the runtime refused the page, and none when it never gave one', async () => {
    const p = page('http://127.0.0.1:7420/#ticket=tst_L');
    const s = sessionOf(await p.bridge.runtimeConnection());
    s.kept({ reloadTicket: 'tst_1', token: TOKEN });
    s.refused('session_expired');
    p.events.dispatchEvent(new Event('pagehide'));
    expect(p.sessionStorage.writes).toEqual([]);
    const proxied = page('http://127.0.0.1:7420/');
    await proxied.bridge.runtimeConnection();
    proxied.events.dispatchEvent(new Event('pagehide'));
    expect(proxied.sessionStorage.writes).toEqual([]);
  });

  it('hands the token to a pop-out or a new tab of its origin, from memory', async () => {
    const origin = fakeOrigin();
    const opener = page('http://127.0.0.1:7420/#ticket=tst_L', { channel: origin.channel() });
    sessionOf(await opener.bridge.runtimeConnection()).kept({ reloadTicket: 'tst_1', token: TOKEN });
    const popout = page('http://127.0.0.1:7420/?window=chart-2', { channel: origin.channel() });
    expect((await popout.bridge.runtimeConnection()).credential).toEqual({ token: TOKEN });
    expect(popout.sessionStorage.writes).toEqual([]);
    expect(popout.localStorage.writes).toEqual([]);
  });

  it('never hands over a token the runtime refused; a new launch link reaches every page', async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const stale = page('http://127.0.0.1:7420/#ticket=tst_L', { channel: origin.channel() });
    sessionOf(await stale.bridge.runtimeConnection()).kept({ reloadTicket: 'tst_1', token: TOKEN });
    const restarted = await stale.bridge.runtimeConnection();
    expect(restarted.credential).toEqual({ token: TOKEN });
    sessionOf(restarted).refused('session_expired');
    await vi.advanceTimersByTimeAsync(1);
    const fresh = page('http://127.0.0.1:7420/', { channel: origin.channel() });
    const asked = fresh.bridge.runtimeConnection();
    await vi.advanceTimersByTimeAsync(300);
    expect((await asked).credential).toBeNull();
    const retried = stale.bridge.runtimeConnection();
    await vi.advanceTimersByTimeAsync(300);
    expect((await retried).credential).toEqual({ token: TOKEN });
    const next = `tss_${'b'.repeat(64)}`;
    const opened = page('http://127.0.0.1:7420/#ticket=tst_M', { channel: origin.channel() });
    sessionOf(await opened.bridge.runtimeConnection()).kept({ reloadTicket: 'tst_2', token: next });
    await vi.advanceTimersByTimeAsync(1);
    expect((await stale.bridge.runtimeConnection()).credential).toEqual({ token: next });
  });

  it('takes nothing from a message that is not one of its own kind', async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const p = page('http://127.0.0.1:7420/', { channel: origin.channel() });
    const other = origin.channel();
    for (const junk of [null, 'tss_x', { kind: 'token' }, { kind: 'token', token: 5 }, { kind: 'token', token: '' }]) {
      other.postMessage(junk);
    }
    const c = p.bridge.runtimeConnection();
    await vi.advanceTimersByTimeAsync(300);
    expect((await c).credential).toBeNull();
  });

  it('a page without a link, a ticket or another page has nothing (the runtime says so)', async () => {
    const origin = fakeOrigin();
    const p = page('http://127.0.0.1:7420/', { channel: origin.channel() });
    expect((await p.bridge.runtimeConnection()).credential).toBeNull();
    expect(origin.posted).toEqual([{ kind: 'ask', from: expect.any(String) }]);
  });
});

describe('browser bridge platform APIs', () => {
  it('refuses non-http(s) external URLs', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const bridge = makeBrowserBridge({ fetch: vi.fn() });
    await expect(bridge.openExternal('javascript:alert(1)')).rejects.toMatchObject({
      _tag: 'UnsafeUrl',
      url: 'javascript:alert(1)',
    });
    expect(open).not.toHaveBeenCalled();
    expect(() => assertExternalUrl('file:///etc/passwd')).toThrow(UnsafeUrl);
    expect(() => assertExternalUrl('not a url')).toThrow(UnsafeUrl);
    expect(assertExternalUrl('https://tesserachart.com/docs').hostname).toBe('tesserachart.com');
    await bridge.openExternal('mailto:desk@tesserachart.com');
    expect(open).toHaveBeenCalledWith('mailto:desk@tesserachart.com', '_blank', 'noopener,noreferrer');
  });

  it('opens tiles in named popups and sets the title', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const bridge = makeBrowserBridge({ fetch: vi.fn() });
    await bridge.openWindow({ kind: 'agent', id: 'agent', title: 'Agent', width: 400 });
    expect(open).toHaveBeenCalledOnce();
    const [url, name, features] = open.mock.calls[0]!;
    expect(name).toBe('tessera-agent');
    expect(features).toContain('width=400');
    expect(parseTileWindowSearch(new URL(String(url)).search)).toMatchObject({ kind: 'agent', id: 'agent' });
    await bridge.setWindowTitle('Tessera — PAPER — Day');
    expect(document.title).toBe('Tessera — PAPER — Day');
  });

  it('opens a popped-out tile where it was, reports its bounds and tells when it closes', async () => {
    vi.useFakeTimers();
    const popup = { closed: false, focus: vi.fn(), screenX: 40, screenY: 60, outerWidth: 900, outerHeight: 700 };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const bridge = makeBrowserBridge({ fetch: vi.fn() });
    expect(
      await bridge.openWindow({
        kind: 'chart',
        id: 'pop-chart-2',
        title: 'NQ Z6',
        width: 900,
        height: 700,
        x: 40,
        y: 60,
      }),
    ).toBe(true);
    expect(open.mock.calls[0]![2]).toContain('left=40,top=60');
    expect(await bridge.windowBounds('pop-chart-2')).toEqual({ x: 40, y: 60, width: 900, height: 700 });
    expect(await bridge.openWindow({ kind: 'chart', id: 'pop-chart-2', title: 'NQ Z6' })).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(popup.focus).toHaveBeenCalledTimes(2);
    const closed = vi.fn();
    bridge.onWindowClosed('pop-chart-2', closed);
    vi.advanceTimersByTime(600);
    expect(closed).not.toHaveBeenCalled();
    popup.closed = true;
    vi.advanceTimersByTime(600);
    expect(closed).toHaveBeenCalledOnce();
    expect(await bridge.windowBounds('pop-chart-2')).toBeNull();
    open.mockReturnValue(null);
    expect(await bridge.openWindow({ kind: 'chart', id: 'pop-chart-3', title: 'ES Z6' })).toBe(false);
  });

  it('notifies once the user allows it, asking first when they have not said', async () => {
    const notifications = (permission: NotificationPermission, prompt?: () => Promise<NotificationPermission>) => {
      const shown: { title: string; options: NotificationOptions | undefined }[] = [];
      const requestPermission = vi.fn(prompt ?? (() => Promise.resolve(permission)));
      const Notification = Object.assign(
        function Notification(title: string, options?: NotificationOptions) {
          shown.push({ title, options });
        },
        { permission, requestPermission },
      );
      const bridge = makeBrowserBridge({
        fetch: vi.fn(),
        location: fakeLocation('http://localhost:5173/'),
        window: Object.assign(new EventTarget(), { Notification }) as unknown as Window & typeof globalThis,
      });
      return { bridge, shown, requestPermission };
    };
    const granted = notifications('granted');
    expect(await granted.bridge.notify({ title: 'Fill', body: 'BUY 25 QQQ' })).toBe(true);
    expect(granted.shown).toEqual([{ title: 'Fill', options: { body: 'BUY 25 QQQ' } }]);
    expect(granted.requestPermission).not.toHaveBeenCalled();
    const allowed = notifications('default', () => Promise.resolve('granted'));
    expect(await allowed.bridge.notify({ title: 'Stop hit' })).toBe(true);
    expect(allowed.requestPermission).toHaveBeenCalledOnce();
    expect(allowed.shown).toEqual([{ title: 'Stop hit', options: {} }]);
    const refused = notifications('default', () => Promise.resolve('denied'));
    expect(await refused.bridge.notify({ title: 'Stop hit' })).toBe(false);
    expect(refused.shown).toEqual([]);
    const denied = notifications('denied');
    expect(await denied.bridge.notify({ title: 'Stop hit' })).toBe(false);
    expect(denied.requestPermission).not.toHaveBeenCalled();
    expect(denied.shown).toEqual([]);
    const broken = notifications('default', () => Promise.reject(new Error('no prompt here')));
    const error = await rejection(broken.bridge.notify({ title: 'Stop hit' }), HostError);
    expect(error).toMatchObject({ _tag: 'HostError', operation: 'notify', message: 'notify: no prompt here' });
    const none = makeBrowserBridge({
      fetch: vi.fn(),
      location: fakeLocation('http://localhost:5173/'),
      window: new EventTarget() as Window & typeof globalThis,
    });
    expect(await none.notify({ title: 'Fill' })).toBe(false);
  });

  it('saves files through a download link', async () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('trades.csv');
      expect(this.href).toMatch(/^blob:/);
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const bridge = makeBrowserBridge({ fetch: vi.fn() });
    expect(await bridge.saveFile({ suggestedName: 'trades.csv', data: 'a,b\n1,2\n', mimeType: 'text/csv' })).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('picks files through a file input; none when cancelled', async () => {
    const picking = (files: { name: string; arrayBuffer: () => Promise<ArrayBuffer> }[] | null) => {
      const inputs: { accept: string; multiple: boolean }[] = [];
      vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
        inputs.push({ accept: this.accept, multiple: this.multiple });
        if (files === null) {
          this.dispatchEvent(new Event('cancel'));
          return;
        }
        Object.defineProperty(this, 'files', { value: files });
        this.dispatchEvent(new Event('change'));
      });
      return inputs;
    };
    const inputGone = () =>
      vi.waitFor(() => {
        expect(document.querySelector('input[type=file]')).toBeNull();
      });
    const bridge = makeBrowserBridge({ fetch: vi.fn() });
    const inputs = picking([new File(['x,y'], 'a.csv'), new File(['{}'], 'b.json')]);
    const picked = await bridge.pickFile({
      multiple: true,
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['.json'] },
      ],
    });
    expect(inputs).toEqual([{ accept: '.csv,.json', multiple: true }]);
    expect(picked.map((f) => f.name)).toEqual(['a.csv', 'b.json']);
    expect(new TextDecoder().decode(picked[0]!.data)).toBe('x,y');
    expect(picked[0]!.path).toBeUndefined();
    await inputGone();
    vi.restoreAllMocks();
    picking(null);
    expect(await bridge.pickFile()).toEqual([]);
    await inputGone();
    vi.restoreAllMocks();
    picking([{ name: 'gone.csv', arrayBuffer: () => Promise.reject(new Error('file moved')) }]);
    const error = await rejection(bridge.pickFile(), HostError);
    expect(error).toMatchObject({ _tag: 'HostError', operation: 'pickFile', message: 'pickFile: file moved' });
    await inputGone();
  });
});

describe('helpers', () => {
  it('round-trips tile specs through the window URL', () => {
    const spec = { kind: 'chart', id: 'chart-1', title: 'Chart 1', params: { instrument: 'QQQ', tf: '5m' } };
    expect(parseTileWindowSearch(tileWindowSearch(spec))).toEqual(spec);
    expect(parseTileWindowSearch('?area=trade')).toBeNull();
    expect(parseTileWindowSearch('?tile=%7Bbad')).toBeNull();
  });

  it('round-trips base64', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    const back = base64ToBytes(bytesToBase64(bytes));
    expect(back).toHaveLength(bytes.length);
    expect(Buffer.from(back).equals(bytes)).toBe(true);
  });
});
