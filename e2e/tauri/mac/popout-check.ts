import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface CgWindow {
  number: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AxWindow {
  title: string;
  subrole: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Facts {
  trusted: boolean;
  active: boolean;
  frontmostPid?: number;
  windows: CgWindow[];
  anywhere: string[];
  screen: { width: number; height: number };
  ax: AxWindow[];
  focused: string | null;
}

interface Case {
  name: string;
  bug?: string;
  holds: boolean;
  saw: string;
}

const KNOWN_BUGS = new Set<string>();

const FIRST_RUN_ANSWERS = ['No', 'Continue', 'Not now'];

const [app, out] = process.argv.slice(2).map((p) => resolve(p));
if (!app || !out) {
  console.error('usage: node e2e/tauri/mac/popout-check.ts <Tessera.app> <output dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'tessera-popout-'));
const helper = join(profile, 'mac-windows');
execFileSync('clang', [
  '-fobjc-arc',
  '-framework',
  'AppKit',
  '-framework',
  'ApplicationServices',
  '-framework',
  'CoreGraphics',
  '-framework',
  'Foundation',
  '-o',
  helper,
  join(import.meta.dirname, 'mac-windows.m'),
]);

const executable = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', join(app, 'Contents/Info.plist')], {
  encoding: 'utf8',
}).trim();
const log = openSync(join(out, 'app.log'), 'w');
const child = spawn(join(app, 'Contents/MacOS', executable), [], {
  env: {
    ...process.env,
    TESSERA_DATA_DIR: join(profile, 'data'),
    TESSERA_WEBVIEW_DATA_DIR: join(profile, 'webview'),
    TESSERA_CLOUD_URL: '',
    TESSERA_POSTHOG_HOST: 'http://127.0.0.1:9',
    TESSERA_NO_RITHMIC: '1',
    TESSERA_SECRET_STORE: 'file',
    XDG_CONFIG_HOME: join(profile, 'config'),
  },
  stdio: ['ignore', log, log],
});
const pid = child.pid ?? 0;

function facts(): Facts {
  return JSON.parse(execFileSync(helper, ['facts', String(pid)], { encoding: 'utf8' })) as Facts;
}

function pressed(label: string): boolean {
  try {
    execFileSync(helper, ['press', String(pid), label], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function drawn(): boolean {
  return execFileSync(helper, ['tree', String(pid)], { encoding: 'utf8' }).includes('description=Dock back');
}

function osascript(script: string): string {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

async function until<T>(what: string, probe: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gave up waiting for ${what}`);
}

async function settled(): Promise<Facts> {
  let last = '';
  return until('the windows to stop moving', () => {
    const now = facts();
    const key = JSON.stringify([now.windows, now.ax, now.focused]);
    const same = key === last;
    last = key;
    return same && now;
  });
}

function dockMenu(): string[] {
  const names = osascript(`
    tell application "System Events" to tell process "Dock"
      set tile to UI element "Tessera" of list 1
      perform action "AXShowMenu" of tile
      repeat 50 times
        if exists menu 1 of tile then exit repeat
        delay 0.1
      end repeat
      set names to name of menu items of menu 1 of tile
      key code 53
      return names
    end tell`);
  return names.split(', ').filter((n) => n !== 'missing value');
}

const same = (a: { width: number; height: number }, b: { width: number; height: number }) =>
  Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

try {
  const first = await until('the main window', () => {
    const f = facts();
    return f.windows.length === 1 && f.ax.length === 1 && f;
  });
  if (!first.trusted) throw new Error('this runner gives the check no Accessibility permission');
  const main = first.windows[0]!;
  osascript(
    `tell application "System Events" to set frontmost of (first process whose unix id is ${String(pid)}) to true`,
  );
  await until('a panel’s Pop out button, past the first-run prompts', () => {
    if (pressed('Pop out')) return true;
    for (const answer of FIRST_RUN_ANSWERS) pressed(answer);
    return false;
  });
  await until('the pop-out window', () => facts().windows.length === 2);
  await until('the pop-out’s page, with its Dock back button', drawn);
  const after = await settled();
  execFileSync('screencapture', ['-x', join(out, 'popout.png')]);
  const popout = after.windows.find((w) => w.number !== main.number)!;
  const popoutAx = after.ax.find(
    (w) => w.title === popout.title && same(w, popout) && w.x === popout.x && w.y === popout.y,
  );
  const mainAx = after.ax.find((w) => w !== popoutAx);
  const mainNow = after.windows.find((w) => w.number === main.number)!;
  const dock = dockMenu();
  writeFileSync(join(out, 'facts.json'), JSON.stringify({ before: first, after, dock }, null, 2));

  const behind = 'pop-out panels open behind the main window and can’t be clicked';
  const dockList = 'pop-out panels are missing from the macOS Dock window list';
  const sized = 'pop-out panels are sized to the panel instead of the app';
  const inFront = (f: Facts, number: number) => f.windows[0]?.number === number && f.frontmostPid === pid;
  const onScreen = (w: CgWindow, f: Facts) =>
    w.x >= 0 && w.y >= 0 && w.x + w.width <= f.screen.width + 1 && w.y + w.height <= f.screen.height + 1;
  const where = (w: CgWindow, f: Facts) =>
    `the pop-out at ${String(w.x)},${String(w.y)} ${String(w.width)}×${String(w.height)} on a ${String(f.screen.width)}×${String(f.screen.height)} screen`;
  const order = (f: Facts) =>
    `front to back ${f.windows.map((w) => w.title || `#${String(w.number)}`).join(', ')}; frontmost pid ${String(f.frontmostPid)}`;
  const cases: Case[] = [
    {
      name: 'the pop-out is in front of the main window, on the screen where a click reaches it',
      bug: behind,
      holds: inFront(after, popout.number) && onScreen(popout, after),
      saw: `${order(after)}; ${where(popout, after)}`,
    },
    {
      name: 'the pop-out has the keyboard focus',
      holds: after.active && after.focused === popoutAx?.title,
      saw: `app active ${String(after.active)}, focused window "${String(after.focused)}"`,
    },
    {
      name: 'the pop-out is a titled window the Dock lists, and so is the main window',
      bug: dockList,
      holds:
        popoutAx?.subrole === 'AXStandardWindow' &&
        popoutAx.title !== '' &&
        dock.includes(popoutAx.title) &&
        mainAx !== undefined &&
        dock.includes(mainAx.title),
      saw: `subrole ${popoutAx?.subrole ?? 'none'}, title "${popoutAx?.title ?? ''}", main "${mainAx?.title ?? ''}", Dock menu [${dock.join(', ')}]`,
    },
    {
      name: 'the pop-out is the size of the app window',
      bug: sized,
      holds: same(popout, mainNow),
      saw: `pop-out ${String(popout.width)}×${String(popout.height)}, main ${String(mainNow.width)}×${String(mainNow.height)}`,
    },
  ];

  await until('the pop-out docked back', () => {
    pressed('Dock back');
    return facts().windows.length === 1;
  });
  execFileSync(helper, ['fullscreen', String(pid)]);
  await until('the main window in full screen', () => {
    const f = facts();
    return f.windows.length === 1 && (f.windows[0]?.width ?? 0) >= f.screen.width;
  });
  await until('Pop out, with the main window in full screen', () => pressed('Pop out'));
  await until('the pop-out window, on any Space', () => facts().anywhere.includes(popout.title));
  await until('the pop-out’s page, with its Dock back button', drawn);
  const full = await settled();
  execFileSync('screencapture', ['-x', join(out, 'popout-over-full-screen.png')]);
  writeFileSync(join(out, 'facts-full-screen.json'), JSON.stringify(full, null, 2));
  const again = full.windows.find((w) => w.title === popout.title);
  cases.push({
    name: 'with the main window in full screen, the pop-out comes up in front of it, on the screen',
    bug: behind,
    holds: again !== undefined && inFront(full, again.number) && onScreen(again, full),
    saw: `${order(full)}; ${again ? where(again, full) : 'the pop-out is on another Space'}`,
  });

  let failed = false;
  for (const c of cases) {
    const known = c.bug !== undefined && KNOWN_BUGS.has(c.bug);
    const verdict = c.holds ? (known ? 'FIXED' : 'ok') : known ? 'known bug' : 'FAILED';
    if (verdict === 'FIXED' || verdict === 'FAILED') failed = true;
    console.info(`${verdict.padEnd(9)} ${c.name}${known ? ` (bug: ${c.bug ?? ''})` : ''}\n          ${c.saw}`);
  }
  if (failed) {
    console.error(
      '\nA case FAILED, or a known bug now passes: take it out of KNOWN_BUGS in e2e/tauri/mac/popout-check.ts.',
    );
    process.exitCode = 1;
  }
} catch (error) {
  execFileSync('screencapture', ['-x', join(out, 'failure.png')]);
  writeFileSync(join(out, 'ax-tree.txt'), execFileSync(helper, ['tree', String(pid)], { encoding: 'utf8' }));
  throw error;
} finally {
  child.kill('SIGTERM');
}
