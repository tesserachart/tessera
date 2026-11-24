import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Desk } from './support/desk.ts';
import { Desktop } from './support/desktop.ts';
import { until, untilSaying } from './support/webdriver.ts';
import { clickAt, closeByWindowManager, type OsWindow } from './support/x11.ts';

const NQ = 'NQ Z6 · 5m';
const ES = 'ES Z6 · 1m';
const NQ_WINDOW = 'Chart 1';

interface Popped {
  handle: string;
  window: OsWindow;
  main: OsWindow;
}

async function popOut(d: Desktop, desk: Desk, tab: string): Promise<Popped> {
  const [first] = d.windows();
  const handle = await desk.popOut(tab);
  await desk.showsItsChart(handle);
  const windows = await untilSaying('the pop-out among the app windows', () => {
    const now = d.windows();
    return Promise.resolve(
      now.length === 2 ? now : `the app has ${String(now.length)}: ${now.map((w) => `"${w.title}"`).join(', ')}`,
    );
  });
  const window = windows.find((w) => w.id !== first?.id);
  const main = windows.find((w) => w.id === first?.id);
  if (!window || !main) throw new Error(`no pop-out among ${JSON.stringify(windows)}`);
  return { handle, window, main };
}

const size = (w: OsWindow) => ({ width: w.bounds.width, height: w.bounds.height });

describe('a chart popped out of the desk', () => {
  let d: Desktop;
  let desk: Desk;
  let popped: Popped;

  beforeAll(async () => {
    d = await Desktop.start('a chart popped out of the desk');
    desk = await Desk.of(await d.launch());
    popped = await popOut(d, desk, NQ);
    d.screenshot('popped-out');
  });

  afterAll(() => {
    d.stop();
  });

  it('opens in its own window titled after the chart, and leaves the desk', async () => {
    expect(popped.window.title).toBe(NQ_WINDOW);
    expect(await desk.chartTabs()).toEqual([ES]);
  });

  it('comes up in front of the main window, with the keyboard focus', () => {
    expect(d.windows()[0]?.id).toBe(popped.window.id);
    expect(popped.window.active).toBe(true);
  });

  it('is a normal titled window that the taskbar lists', () => {
    expect(popped.window.types).toEqual(['_NET_WM_WINDOW_TYPE_NORMAL']);
    expect(popped.window.states).not.toContain('_NET_WM_STATE_SKIP_TASKBAR');
  });

  it('opens at the size of the app window', () => {
    expect(size(popped.window)).toEqual(size(popped.main));
  });

  it('takes a click: it lands in the pop-out, not in the main window behind it', async () => {
    const { handle, window } = popped;
    await desk.listenForClicks(handle);
    await desk.listenForClicks(desk.main);
    clickAt(d.display, { x: window.bounds.x + Math.round(window.bounds.width / 2), y: window.bounds.y + 12 });
    await until('the click in the pop-out', async () => (await desk.clicksIn(handle)) === 1);
    expect(await desk.clicksIn(desk.main)).toBe(0);
  });
});

describe('the desk while a chart is popped out', () => {
  let d: Desktop | null = null;

  afterEach(() => {
    d?.stop();
    d = null;
  });

  async function open(name: string): Promise<{ d: Desktop; desk: Desk }> {
    d = await Desktop.start(name);
    return { d, desk: await Desk.of(await d.launch()) };
  }

  it('opens a new chart (Ctrl+T) on the desk while its only chart is popped out', async () => {
    const { d, desk } = await open('new chart while popped');
    await desk.closeChart(ES);
    await popOut(d, desk, NQ);
    try {
      await desk.newChart('ES');
      await until('the new chart on the desk', async () => (await desk.chartTabs()).length === 1);
    } finally {
      d.screenshot('new-chart-while-popped');
    }
  });

  it('docks the chart back onto the desk and closes its window', async () => {
    const { d, desk } = await open('dock back');
    const { handle } = await popOut(d, desk, NQ);
    await desk.dockBack(handle);
    await until('the pop-out window gone', () => Promise.resolve(d.windows().length === 1));
    expect((await desk.chartTabs()).sort()).toEqual([ES, NQ].sort());
  });

  it('closes the chart when its window is closed, and Undo restores it to the desk', async () => {
    const { d, desk } = await open('close and undo');
    const { window } = await popOut(d, desk, NQ);
    closeByWindowManager(d.display, window.id);
    await until('the pop-out window gone', () => Promise.resolve(d.windows().length === 1));
    expect(await desk.chartTabs()).toEqual([ES]);
    await desk.undoClose(NQ_WINDOW);
    await until('NQ back on the desk', async () => (await desk.chartTabs()).includes(NQ));
  });

  it('reopens a pop-out where it stood when the app starts again', async () => {
    const { d, desk } = await open('reopen after restart');
    const { window } = await popOut(d, desk, NQ);
    await d.quit(desk.session);
    const again = await Desk.of(await d.launch());
    const handle = await until('the pop-out back', async () =>
      (await again.session.handles()).find((h) => h !== again.main),
    );
    await again.showsItsChart(handle);
    d.screenshot('reopened-after-restart');
    expect(d.windows().find((w) => w.title === NQ_WINDOW)?.bounds).toEqual(window.bounds);
    expect(await again.chartTabs()).toEqual([ES]);
  });
});
