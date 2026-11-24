import { HostError, type UpdateEvent, type UpdateFound } from '@tessera/bridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { read, write } from '../src/app/store.ts';
import {
  CHECK_EVERY,
  FIRST_CHECK,
  IDLE,
  SNOOZE,
  KEPT_DOWNLOAD,
  askToUpdate,
  checkAction,
  checkForUpdates,
  dialogView,
  dismissUpdateError,
  isNewerVersion,
  notNow,
  promptView,
  railView,
  restartAndUpdate,
  retryUpdate,
  standingWords,
  updateLater,
  UP_TO_DATE_FOR,
  updateStore,
  watchForUpdates,
} from '../src/app/updates.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';

const FOUND: UpdateFound = { version: '0.2.0-alpha.1', notes: 'Quieter updates' };
const NEWER: UpdateFound = { version: '0.2.0-alpha.2', notes: 'Rediscovered updates' };

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const hostFailure = (operation: string, reason: string) => new HostError({ operation, reason: new Error(reason) });

function fakeHost() {
  const check = vi.fn<() => Promise<UpdateFound | null>>(() => Promise.resolve(null));
  const download = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const installAndRestart = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const listeners = new Set<(event: UpdateEvent) => void>();
  fakeRuntime({
    bridge: {
      updates: {
        check,
        download,
        installAndRestart,
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  return {
    check,
    download,
    installAndRestart,
    say: (event: UpdateEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

const fakeTimers = () =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function findOne(host: ReturnType<typeof fakeHost>) {
  host.check.mockResolvedValue(FOUND);
  const stop = watchForUpdates();
  await pass(FIRST_CHECK);
  return stop;
}

afterEach(() => {
  vi.useRealTimers();
  write(updateStore, IDLE);
  localStorage.removeItem(KEPT_DOWNLOAD);
});

describe('finding an update, confirming, and installing it', () => {
  it('finds quietly, then downloads and installs only once the person confirms', async () => {
    fakeTimers();
    const host = fakeHost();
    host.check.mockResolvedValue(FOUND);
    const stop = watchForUpdates();
    await pass(FIRST_CHECK - 1_000);
    expect(host.check).not.toHaveBeenCalled();
    await pass(1_000);
    expect(host.check).toHaveBeenCalledOnce();
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
    expect(host.download).not.toHaveBeenCalled();
    expect(host.installAndRestart).not.toHaveBeenCalled();

    askToUpdate();
    expect(read(updateStore)).toEqual({ kind: 'confirm', update: FOUND });
    expect(host.download).not.toHaveBeenCalled();

    const download = deferred();
    const install = deferred();
    host.download.mockReturnValue(download.promise);
    host.installAndRestart.mockReturnValue(install.promise);
    const restarting = restartAndUpdate();
    expect(read(updateStore)).toEqual({ kind: 'downloading', update: FOUND, fraction: null, shown: true });

    host.say({ kind: 'downloading', version: FOUND.version, downloaded: 512, total: 2048 });
    expect(read(updateStore)).toMatchObject({ kind: 'downloading', fraction: 0.25 });
    host.say({ kind: 'downloading', version: FOUND.version, downloaded: 4096, total: 2048 });
    expect(read(updateStore)).toMatchObject({ fraction: 1 });
    host.say({ kind: 'downloading', version: FOUND.version, downloaded: 10, total: null });
    expect(read(updateStore)).toMatchObject({ fraction: null });
    host.say({ kind: 'downloading', version: '9.9.9', downloaded: 1, total: 2 });
    expect(read(updateStore)).toMatchObject({ fraction: null });
    expect(host.installAndRestart).not.toHaveBeenCalled();

    download.resolve();
    await pass(0);
    expect(read(updateStore)).toEqual({ kind: 'installing', update: FOUND });
    expect(host.installAndRestart).toHaveBeenCalledOnce();
    install.resolve();
    await restarting;
    expect(read(updateStore)).toEqual({ kind: 'installing', update: FOUND });
    expect(host.download).toHaveBeenCalledOnce();
    expect(host.installAndRestart).toHaveBeenCalledOnce();
    expect(host.download.mock.invocationCallOrder[0]).toBeLessThan(host.installAndRestart.mock.invocationCallOrder[0]!);
    stop();
  });

  it('ignores progress that arrives when nothing is downloading', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = await findOne(host);
    host.say({ kind: 'downloading', version: FOUND.version, downloaded: 5, total: 10 });
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
    stop();
  });
});

describe('checks that find nothing', () => {
  it('rests quietly with the time of the check, and checks again within thirty minutes', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = watchForUpdates();
    await pass(FIRST_CHECK);
    expect(host.check).toHaveBeenCalledOnce();
    const state = read(updateStore);
    expect(state).toEqual({ kind: 'idle', checkedAt: Date.now(), asked: false });
    expect(promptView(state)).toBeNull();
    expect(dialogView(state)).toBeNull();
    await pass(CHECK_EVERY);
    expect(host.check).toHaveBeenCalledTimes(2);
    await pass(CHECK_EVERY);
    expect(host.check).toHaveBeenCalledTimes(3);
    stop();
    await pass(CHECK_EVERY * 2);
    expect(host.check).toHaveBeenCalledTimes(3);
  });

  it('says where it stands in the display zone', () => {
    const checkedAt = Date.UTC(2026, 10, 1, 14, 2);
    expect(standingWords({ kind: 'idle', checkedAt, asked: true }, 'UTC')).toBe('Up to date · checked 14:02');
    expect(standingWords({ kind: 'idle', checkedAt, asked: false }, 'Asia/Tokyo')).toBe('Up to date · checked 23:02');
    expect(standingWords(IDLE, 'UTC')).toBeNull();
    expect(standingWords({ kind: 'available', update: FOUND }, 'UTC')).toBe('0.2.0-alpha.1 is available');
    expect(standingWords({ kind: 'later', update: FOUND, until: 1 }, 'UTC')).toBe('0.2.0-alpha.1 is available');
    expect(standingWords({ kind: 'checking', asked: true }, 'UTC')).toBeNull();
    expect(standingWords({ kind: 'downloading', update: FOUND, fraction: 0.517, shown: false }, 'UTC')).toBe(
      'Downloading 0.2.0-alpha.1 · 51%',
    );
    expect(standingWords({ kind: 'downloading', update: FOUND, fraction: null, shown: false }, 'UTC')).toBe(
      'Downloading 0.2.0-alpha.1…',
    );
    expect(standingWords({ kind: 'ready', update: FOUND, shown: false }, 'UTC')).toBe(
      '0.2.0-alpha.1 is ready · restart to update',
    );
  });
});

describe('the rail item', () => {
  it('reads Up to date for a while only after a person’s check found nothing', async () => {
    fakeTimers();
    fakeHost();
    await checkForUpdates();
    const checkedAt = Date.now();
    expect(read(updateStore)).toEqual({ kind: 'idle', checkedAt, asked: true });
    expect(railView(read(updateStore), checkedAt)).toEqual({
      kind: 'up_to_date',
      until: checkedAt + UP_TO_DATE_FOR,
    });
    expect(railView(read(updateStore), checkedAt + UP_TO_DATE_FOR)).toEqual({ kind: 'rest' });
    expect(railView({ kind: 'idle', checkedAt, asked: false }, checkedAt)).toEqual({ kind: 'rest' });
    expect(railView(IDLE, checkedAt)).toEqual({ kind: 'rest' });
  });

  it('shows the timer’s checks and failures to nobody, and a person’s to the person', () => {
    expect(railView({ kind: 'checking', asked: false }, 0)).toEqual({ kind: 'rest' });
    expect(railView({ kind: 'checking', asked: true }, 0)).toEqual({ kind: 'checking' });
    const failed = { kind: 'error', failed: 'check', reason: 'offline', update: null, shown: false } as const;
    expect(railView({ ...failed, asked: false }, 0)).toEqual({ kind: 'rest' });
    expect(railView({ ...failed, asked: true }, 0)).toEqual({ kind: 'failed' });
    for (const state of [
      { kind: 'available', update: FOUND },
      { kind: 'later', update: FOUND, until: 1 },
      { kind: 'confirm', update: FOUND },
    ] as const)
      expect(railView(state, 0)).toEqual({ kind: 'rest' });
  });

  it('carries a download, shown or hidden, then the ready build, then a failure, under the icon', () => {
    for (const shown of [true, false]) {
      expect(railView({ kind: 'downloading', update: FOUND, fraction: 0.51, shown }, 0)).toEqual({
        kind: 'downloading',
        version: FOUND.version,
        fraction: 0.51,
      });
      expect(railView({ kind: 'ready', update: FOUND, shown }, 0)).toEqual({ kind: 'ready', version: FOUND.version });
      expect(
        railView({ kind: 'error', failed: 'download', reason: 'gone', update: FOUND, asked: true, shown }, 0),
      ).toEqual({ kind: 'update_failed', version: FOUND.version });
    }
    expect(railView({ kind: 'installing', update: FOUND }, 0)).toEqual({ kind: 'ready', version: FOUND.version });
  });
});

describe('Later', () => {
  it('stays quiet through the snooze while rediscovery finds the same build, then offers again; a person asking offers at once', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = await findOne(host);
    expect(host.check).toHaveBeenCalledOnce();
    const laterAt = Date.now();
    updateLater();
    expect(read(updateStore)).toEqual({ kind: 'later', update: FOUND, until: laterAt + SNOOZE });
    expect(promptView(read(updateStore))).toBeNull();

    await pass(CHECK_EVERY * 5);
    expect(host.check).toHaveBeenCalledTimes(6);
    expect(read(updateStore)).toEqual({ kind: 'later', update: FOUND, until: laterAt + SNOOZE });

    await pass(SNOOZE);
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
    const checks = host.check.mock.calls.length;

    updateLater();
    await checkForUpdates();
    expect(host.check).toHaveBeenCalledTimes(checks + 1);
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
    stop();
  });

  it('is forgotten with the process, so a new launch offers again', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = await findOne(host);
    updateLater();
    stop();
    write(updateStore, IDLE);
    const again = watchForUpdates();
    await pass(FIRST_CHECK);
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
    again();
  });
});

describe('rediscovering newer builds', () => {
  it('replaces a standing offer with a newer build at the next timer check', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = await findOne(host);
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });

    host.check.mockResolvedValue(NEWER);
    await pass(CHECK_EVERY);
    expect(read(updateStore)).toEqual({ kind: 'available', update: NEWER });
    stop();
  });

  it('keeps a fresh snooze while the endpoint still reports the same build', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = await findOne(host);
    updateLater();
    const snoozed = read(updateStore);

    await pass(CHECK_EVERY * 3);
    expect(read(updateStore)).toEqual(snoozed);
    expect(host.check.mock.calls.length).toBeGreaterThan(1);
    stop();
  });

  it('clears an obsolete snooze when a newer build is found', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = await findOne(host);
    updateLater();
    expect(read(updateStore).kind).toBe('later');

    host.check.mockResolvedValue(NEWER);
    await pass(CHECK_EVERY);
    expect(read(updateStore)).toEqual({ kind: 'available', update: NEWER });
    stop();
  });

  it('checks as soon as the window regains focus after an up to date check', async () => {
    fakeTimers();
    const host = fakeHost();
    host.check.mockResolvedValueOnce(null);
    const stop = watchForUpdates();
    await pass(FIRST_CHECK);
    expect(read(updateStore)).toEqual({ kind: 'idle', checkedAt: Date.now(), asked: false });

    host.check.mockResolvedValue(NEWER);
    window.dispatchEvent(new Event('focus'));
    await pass(0);
    expect(read(updateStore)).toEqual({ kind: 'available', update: NEWER });
    stop();
  });

  it('does not let an older build replace the one already held', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = await findOne(host);
    updateLater();

    host.check.mockResolvedValue({ version: '0.2.0-alpha.0', notes: null });
    await pass(CHECK_EVERY);
    expect(read(updateStore).kind).toBe('later');
    expect(read(updateStore)).toMatchObject({ update: FOUND });
    stop();
  });

  it('orders releases the way semver does', () => {
    expect(isNewerVersion('0.2.0-alpha.10', '0.2.0-alpha.8')).toBe(true);
    expect(isNewerVersion('0.2.0-alpha.8', '0.2.0-alpha.10')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.2.0-alpha.8')).toBe(true);
    expect(isNewerVersion('0.2.0-alpha.8', '0.2.0-alpha.8')).toBe(false);
  });
});

describe('who may check', () => {
  it('shares one check between callers', async () => {
    const host = fakeHost();
    const answer = deferred<UpdateFound | null>();
    host.check.mockReturnValue(answer.promise);
    const first = checkForUpdates();
    const second = checkForUpdates();
    expect(host.check).toHaveBeenCalledOnce();
    expect(read(updateStore)).toEqual({ kind: 'checking', asked: true });
    answer.resolve(FOUND);
    await Promise.all([first, second]);
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
  });

  it('checks while an offer is standing', async () => {
    const host = fakeHost();
    host.check.mockResolvedValue(NEWER);
    write(updateStore, { kind: 'available', update: FOUND });
    await checkForUpdates();
    expect(read(updateStore)).toEqual({ kind: 'available', update: NEWER });
    expect(host.check).toHaveBeenCalledOnce();
  });

  it('does not check while an update is confirmed, downloading, ready or installing', async () => {
    const host = fakeHost();
    const states = [
      { kind: 'confirm', update: FOUND },
      { kind: 'downloading', update: FOUND, fraction: null, shown: true },
      { kind: 'ready', update: FOUND, shown: true },
      { kind: 'installing', update: FOUND },
    ] as const;
    for (const state of states) {
      write(updateStore, state);
      await checkForUpdates();
      expect(read(updateStore)).toEqual(state);
    }
    expect(host.check).not.toHaveBeenCalled();
  });

  it('reopens a hidden download, ready build or failure instead of checking, from every way in', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = watchForUpdates();
    const failed = { kind: 'error', failed: 'download', reason: 'gone', update: FOUND, asked: true } as const;
    const hidden = [
      { kind: 'downloading', update: FOUND, fraction: 0.4, shown: false },
      { kind: 'ready', update: FOUND, shown: false },
      { ...failed, shown: false },
    ] as const;
    for (const state of hidden) {
      write(updateStore, state);
      await pass(CHECK_EVERY);
      window.dispatchEvent(new Event('focus'));
      expect(read(updateStore)).toEqual(state);
      host.say({ kind: 'check' });
      expect(read(updateStore)).toEqual({ ...state, shown: true });
      write(updateStore, state);
      await checkForUpdates();
      expect(read(updateStore)).toEqual({ ...state, shown: true });
    }
    expect(host.check).not.toHaveBeenCalled();
    stop();
  });

  it('names what the menu and Settings button do in each state', () => {
    expect(checkAction(IDLE)).toEqual({ words: 'Check for updates', busy: false });
    expect(checkAction({ kind: 'checking', asked: true })).toEqual({ words: 'Checking for updates…', busy: true });
    expect(checkAction({ kind: 'downloading', update: FOUND, fraction: 0.3, shown: false })).toEqual({
      words: 'Show update',
      busy: false,
    });
    expect(checkAction({ kind: 'ready', update: FOUND, shown: false })).toEqual({
      words: 'Restart to update…',
      busy: false,
    });
    expect(checkAction({ kind: 'installing', update: FOUND })).toEqual({ words: 'Restart to update…', busy: true });
    expect(
      checkAction({ kind: 'error', failed: 'download', reason: 'gone', update: FOUND, asked: true, shown: false }),
    ).toEqual({ words: 'Show update', busy: false });
    expect(
      checkAction({ kind: 'error', failed: 'check', reason: 'offline', update: null, asked: true, shown: false }),
    ).toEqual({ words: 'Check for updates', busy: false });
  });

  it('does nothing in a browser, where no host updates the app', async () => {
    fakeTimers();
    fakeRuntime();
    const stop = watchForUpdates();
    await pass(CHECK_EVERY * 2);
    await checkForUpdates();
    askToUpdate();
    await restartAndUpdate();
    await retryUpdate();
    expect(read(updateStore)).toEqual(IDLE);
    stop();
  });

  it('is driven by the menu bar’s Check for Updates, and a check never downloads or installs', async () => {
    const host = fakeHost();
    const stop = watchForUpdates();
    host.check.mockResolvedValueOnce(null);
    host.say({ kind: 'check' });
    expect(read(updateStore)).toEqual({ kind: 'checking', asked: true });
    await vi.waitFor(() => expect(read(updateStore).kind).toBe('idle'));
    host.check.mockResolvedValueOnce(FOUND);
    host.say({ kind: 'check' });
    await vi.waitFor(() => expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND }));
    expect(host.check).toHaveBeenCalledTimes(2);
    expect(host.download).not.toHaveBeenCalled();
    expect(host.installAndRestart).not.toHaveBeenCalled();
    stop();
  });
});

describe('Not now and hiding', () => {
  it('leaves the offer standing from the confirmation', () => {
    fakeHost();
    write(updateStore, { kind: 'confirm', update: FOUND });
    notNow();
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
    notNow();
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
  });

  it('hides a running download, which keeps hearing progress, and reopens at the same fraction', async () => {
    const host = fakeHost();
    const stop = watchForUpdates();
    const download = deferred();
    host.download.mockReturnValueOnce(download.promise);
    write(updateStore, { kind: 'confirm', update: FOUND });
    const restarting = restartAndUpdate();
    host.say({ kind: 'downloading', version: FOUND.version, downloaded: 256, total: 1024 });
    notNow();
    expect(read(updateStore)).toEqual({ kind: 'downloading', update: FOUND, fraction: 0.25, shown: false });
    expect(dialogView(read(updateStore))).toBeNull();

    host.say({ kind: 'downloading', version: FOUND.version, downloaded: 512, total: 1024 });
    expect(read(updateStore)).toEqual({ kind: 'downloading', update: FOUND, fraction: 0.5, shown: false });
    expect(railView(read(updateStore), 0)).toEqual({ kind: 'downloading', version: FOUND.version, fraction: 0.5 });

    await checkForUpdates();
    expect(dialogView(read(updateStore))).toEqual({ phase: 'downloading', update: FOUND, fraction: 0.5, reason: null });
    expect(host.check).not.toHaveBeenCalled();
    expect(host.download).toHaveBeenCalledOnce();

    notNow();
    download.resolve();
    await restarting;
    stop();
  });

  it('waits as ready when a hidden download finishes, and installs only on an explicit restart', async () => {
    fakeTimers();
    const host = fakeHost();
    const download = deferred();
    host.download.mockReturnValueOnce(download.promise);
    write(updateStore, { kind: 'confirm', update: FOUND });
    const restarting = restartAndUpdate();
    notNow();
    download.resolve();
    await restarting;
    expect(read(updateStore)).toEqual({ kind: 'ready', update: FOUND, shown: false });
    expect(dialogView(read(updateStore))).toBeNull();
    await pass(CHECK_EVERY * 3);
    expect(host.installAndRestart).not.toHaveBeenCalled();

    await checkForUpdates();
    expect(dialogView(read(updateStore))).toEqual({ phase: 'ready', update: FOUND, fraction: 1, reason: null });
    notNow();
    expect(read(updateStore)).toEqual({ kind: 'ready', update: FOUND, shown: false });
    expect(host.installAndRestart).not.toHaveBeenCalled();

    await checkForUpdates();
    await restartAndUpdate();
    expect(read(updateStore)).toEqual({ kind: 'installing', update: FOUND });
    expect(host.download).toHaveBeenCalledOnce();
    expect(host.installAndRestart).toHaveBeenCalledOnce();
  });

  it('installs at once when the download finishes in front of the person who confirmed it', async () => {
    const host = fakeHost();
    const download = deferred();
    host.download.mockReturnValueOnce(download.promise);
    write(updateStore, { kind: 'confirm', update: FOUND });
    const restarting = restartAndUpdate();
    notNow();
    await checkForUpdates();
    download.resolve();
    await restarting;
    expect(read(updateStore)).toEqual({ kind: 'installing', update: FOUND });
    expect(host.installAndRestart).toHaveBeenCalledOnce();
  });

  it('surfaces a hidden download’s failure on the rail, and reopening offers Try again', async () => {
    const host = fakeHost();
    host.download.mockRejectedValueOnce(hostFailure('update_download', 'connection reset'));
    write(updateStore, { kind: 'confirm', update: FOUND });
    const restarting = restartAndUpdate();
    notNow();
    await restarting;
    expect(read(updateStore)).toMatchObject({ kind: 'error', failed: 'download', shown: false });
    expect(dialogView(read(updateStore))).toBeNull();
    expect(railView(read(updateStore), 0)).toEqual({ kind: 'update_failed', version: FOUND.version });

    await checkForUpdates();
    expect(dialogView(read(updateStore))).toMatchObject({
      phase: 'download_failed',
      reason: 'update_download: connection reset',
    });
    host.check.mockResolvedValue(FOUND);
    host.download.mockResolvedValue();
    await retryUpdate();
    expect(host.check).toHaveBeenCalledOnce();
    expect(read(updateStore)).toEqual({ kind: 'installing', update: FOUND });
  });
});

describe('a download kept across a reload or a restart', () => {
  const keep = (update: UpdateFound | null) => localStorage.setItem(KEPT_DOWNLOAD, JSON.stringify(update));
  const kept = () => JSON.parse(localStorage.getItem(KEPT_DOWNLOAD) ?? 'null') as unknown;

  it('keeps the build being downloaded or ready, and forgets it once it installs', async () => {
    const host = fakeHost();
    const stop = watchForUpdates();
    const download = deferred();
    host.download.mockReturnValueOnce(download.promise);
    write(updateStore, { kind: 'confirm', update: FOUND });
    expect(kept()).toBeNull();
    const restarting = restartAndUpdate();
    expect(kept()).toEqual(FOUND);
    notNow();
    download.resolve();
    await restarting;
    expect(read(updateStore).kind).toBe('ready');
    expect(kept()).toEqual(FOUND);
    await restartAndUpdate();
    expect(read(updateStore).kind).toBe('installing');
    expect(kept()).toBeNull();
    stop();
  });

  it('picks the download up at launch, hidden, and waits as ready without restarting', async () => {
    fakeTimers();
    const host = fakeHost();
    host.check.mockResolvedValue(FOUND);
    const download = deferred();
    host.download.mockReturnValueOnce(download.promise);
    keep(FOUND);
    const stop = watchForUpdates();
    expect(read(updateStore)).toEqual({ kind: 'downloading', update: FOUND, fraction: null, shown: false });
    await pass(0);
    expect(host.check).toHaveBeenCalledOnce();
    expect(host.download).toHaveBeenCalledOnce();
    host.say({ kind: 'downloading', version: FOUND.version, downloaded: 3, total: 4 });
    expect(railView(read(updateStore), 0)).toEqual({ kind: 'downloading', version: FOUND.version, fraction: 0.75 });
    download.resolve();
    await pass(0);
    expect(read(updateStore)).toEqual({ kind: 'ready', update: FOUND, shown: false });
    await pass(FIRST_CHECK + CHECK_EVERY);
    expect(host.check).toHaveBeenCalledOnce();
    expect(host.installAndRestart).not.toHaveBeenCalled();
    stop();
  });

  it('lets go of a kept build the endpoint no longer offers', async () => {
    const host = fakeHost();
    host.check.mockResolvedValueOnce(NEWER).mockResolvedValueOnce(null);
    keep(FOUND);
    let stop = watchForUpdates();
    await vi.waitFor(() => expect(read(updateStore)).toEqual({ kind: 'available', update: NEWER }));
    expect(kept()).toBeNull();
    stop();

    write(updateStore, IDLE);
    keep(FOUND);
    stop = watchForUpdates();
    await vi.waitFor(() => expect(read(updateStore).kind).toBe('idle'));
    expect(host.download).not.toHaveBeenCalled();
    expect(kept()).toBeNull();
    stop();
  });

  it('shows a launch that could not reach the endpoint as a failed download, and Try again checks first', async () => {
    const host = fakeHost();
    host.check.mockRejectedValueOnce(hostFailure('update_check', 'offline')).mockResolvedValue(FOUND);
    keep(FOUND);
    const stop = watchForUpdates();
    await vi.waitFor(() =>
      expect(read(updateStore)).toMatchObject({ kind: 'error', failed: 'download', shown: false }),
    );
    expect(host.download).not.toHaveBeenCalled();
    await retryUpdate();
    expect(host.check).toHaveBeenCalledTimes(2);
    expect(host.download).toHaveBeenCalledOnce();
    expect(read(updateStore)).toEqual({ kind: 'installing', update: FOUND });
    stop();
  });

  it('ignores a kept record it cannot read', async () => {
    fakeTimers();
    const host = fakeHost();
    localStorage.setItem(KEPT_DOWNLOAD, '{"version":3}');
    const stop = watchForUpdates();
    expect(read(updateStore)).toEqual(IDLE);
    localStorage.setItem(KEPT_DOWNLOAD, 'not json');
    stop();
    const again = watchForUpdates();
    expect(read(updateStore)).toEqual(IDLE);
    await pass(0);
    expect(host.check).not.toHaveBeenCalled();
    again();
  });
});

describe('failures', () => {
  it('keeps a failed check by the timer out of sight and tries again at the next tick', async () => {
    fakeTimers();
    const host = fakeHost();
    host.check.mockRejectedValueOnce(hostFailure('update_check', 'offline')).mockResolvedValue(FOUND);
    const stop = watchForUpdates();
    await pass(FIRST_CHECK);
    expect(read(updateStore)).toMatchObject({ kind: 'error', failed: 'check', asked: false });
    expect(promptView(read(updateStore))).toBeNull();
    expect(dialogView(read(updateStore))).toBeNull();
    await pass(CHECK_EVERY);
    expect(host.check).toHaveBeenCalledTimes(2);
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
    stop();
  });

  it('keeps a standing offer through a silent timer failure', async () => {
    fakeTimers();
    const host = fakeHost();
    const stop = await findOne(host);
    updateLater();
    const snoozed = read(updateStore);

    host.check.mockRejectedValueOnce(hostFailure('update_check', 'offline'));
    await pass(CHECK_EVERY);
    expect(read(updateStore)).toEqual(snoozed);
    stop();
  });

  it('tells a person whose check failed, and retries or dismisses on their word', async () => {
    const host = fakeHost();
    host.check.mockRejectedValueOnce(hostFailure('update_check', 'offline')).mockResolvedValueOnce(null);
    await checkForUpdates();
    expect(read(updateStore)).toMatchObject({ kind: 'error', failed: 'check', asked: true });
    expect(promptView(read(updateStore))).toEqual({ kind: 'check_failed' });
    await retryUpdate();
    expect(host.check).toHaveBeenCalledTimes(2);
    expect(read(updateStore).kind).toBe('idle');

    host.check.mockRejectedValueOnce(hostFailure('update_check', 'offline'));
    await checkForUpdates();
    dismissUpdateError();
    expect(read(updateStore).kind).toBe('idle');
    expect(host.download).not.toHaveBeenCalled();
    expect(host.installAndRestart).not.toHaveBeenCalled();
  });

  it('shows a failure to a person who asked while the timer’s check was under way', async () => {
    fakeTimers();
    const host = fakeHost();
    const answer = deferred<UpdateFound | null>();
    host.check.mockReturnValue(answer.promise);
    const stop = watchForUpdates();
    await pass(FIRST_CHECK);
    expect(read(updateStore)).toEqual({ kind: 'checking', asked: false });
    const asking = checkForUpdates();
    expect(host.check).toHaveBeenCalledOnce();
    expect(read(updateStore)).toEqual({ kind: 'checking', asked: true });
    answer.reject(hostFailure('update_check', 'offline'));
    await asking;
    expect(promptView(read(updateStore))).toEqual({ kind: 'check_failed' });
    stop();
  });

  it('retries a failed download, then installs', async () => {
    const host = fakeHost();
    host.check.mockResolvedValue(FOUND);
    host.download.mockRejectedValueOnce(hostFailure('update_download', 'signature mismatch'));
    write(updateStore, { kind: 'confirm', update: FOUND });
    await restartAndUpdate();
    expect(read(updateStore)).toMatchObject({
      kind: 'error',
      failed: 'download',
      update: FOUND,
      asked: true,
      shown: true,
    });
    expect(dialogView(read(updateStore))).toMatchObject({ phase: 'download_failed' });
    expect(dialogView(read(updateStore))?.reason).toContain('signature mismatch');
    expect(host.installAndRestart).not.toHaveBeenCalled();

    await retryUpdate();
    expect(host.download).toHaveBeenCalledTimes(2);
    expect(host.installAndRestart).toHaveBeenCalledOnce();
    expect(read(updateStore)).toEqual({ kind: 'installing', update: FOUND });
  });

  it('stops at a failed install without restarting by itself, and Close leaves the offer standing', async () => {
    fakeTimers();
    const host = fakeHost();
    host.installAndRestart.mockRejectedValueOnce(hostFailure('update_install', 'disk full'));
    write(updateStore, { kind: 'confirm', update: FOUND });
    await restartAndUpdate();
    expect(read(updateStore)).toMatchObject({ kind: 'error', failed: 'install', update: FOUND });
    expect(dialogView(read(updateStore))).toMatchObject({ phase: 'install_failed' });
    await pass(CHECK_EVERY * 3);
    expect(host.installAndRestart).toHaveBeenCalledOnce();
    dismissUpdateError();
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
  });
});
