import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Session, until } from './webdriver.ts';
import { osWindows, type OsWindow } from './x11.ts';

export interface Binaries {
  shell: string;
  runtime: string;
}

const SCREEN = { width: 1920, height: 1080 };

const OUT = resolve(import.meta.dirname, '../../../.e2e/tauri');

function binaries(): Binaries {
  const shell = process.env.TESSERA_TAURI_SHELL;
  const runtime = process.env.TESSERA_TEST_RUNTIME_BIN;
  if (!shell || !runtime)
    throw new Error('run these tests with bun run e2e:tauri: it builds the shell and finds the runtime');
  return { shell, runtime };
}

function freeDisplay(): string {
  for (let n = 140; n < 200; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${String(n)}`) && !existsSync(`/tmp/.X${String(n)}-lock`)) return `:${String(n)}`;
  }
  throw new Error('no free X display between :140 and :199');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });
}

function group(command: string, args: string[], env: NodeJS.ProcessEnv, log: number): ChildProcess {
  return spawn(command, args, { env, detached: true, stdio: ['ignore', log, log] });
}

function fileName(name: string): string {
  return name
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export class Desktop {
  readonly display: string;
  private readonly driver: string;
  private readonly bins: Binaries;
  private readonly profile: string;
  private readonly children: ChildProcess[];

  private constructor(display: string, driver: string, bins: Binaries, profile: string, children: ChildProcess[]) {
    this.display = display;
    this.driver = driver;
    this.bins = bins;
    this.profile = profile;
    this.children = children;
  }

  static async start(name: string, bins: Binaries = binaries()): Promise<Desktop> {
    const display = freeDisplay();
    const profile = mkdtempSync(join(tmpdir(), 'tessera-tauri-'));
    mkdirSync(join(OUT, 'logs'), { recursive: true });
    const log = openSync(join(OUT, 'logs', `${fileName(name)}.log`), 'w');
    const env = { ...process.env, DISPLAY: display };
    const screen = `${String(SCREEN.width)}x${String(SCREEN.height)}x24`;
    const children = [group('Xvfb', [display, '-screen', '0', screen, '-nolisten', 'tcp'], process.env, log)];
    await until(`the X display ${display}`, () => Promise.resolve(existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)));
    children.push(group('openbox', ['--sm-disable'], env, log));
    const port = await freePort();
    const nativePort = await freePort();
    children.push(
      group(
        'dbus-run-session',
        ['--', 'tauri-driver', '--port', String(port), '--native-port', String(nativePort)],
        {
          ...env,
          TESSERA_RUNTIME_BIN: bins.runtime,
          TESSERA_DATA_DIR: join(profile, 'data'),
          TESSERA_WEBVIEW_DATA_DIR: join(profile, 'webview'),
          WEBKIT_DISABLE_DMABUF_RENDERER: '1',
        },
        log,
      ),
    );
    closeSync(log);
    const driver = `http://127.0.0.1:${String(port)}`;
    await until('tauri-driver', async () => (await fetch(`${driver}/status`).catch(() => null))?.ok);
    return new Desktop(display, driver, bins, profile, children);
  }

  async launch(): Promise<Session> {
    const session = await Session.create(this.driver, { 'tauri:options': { application: this.bins.shell } });
    await session.switchTo(await session.handle());
    await until('the desk with its charts, the splash gone', () =>
      session.execute<boolean>(
        `return document.querySelectorAll('[aria-label="Orders on the chart"]').length > 0 &&
          !document.querySelector('.t-sh-splash')`,
      ),
    );
    return session;
  }

  async quit(session: Session): Promise<void> {
    await session.end();
    await until('the app to close every window', () => Promise.resolve(this.windows().length === 0));
  }

  windows(): OsWindow[] {
    return osWindows(this.display, this.bins.shell);
  }

  screenshot(name: string): void {
    mkdirSync(join(OUT, 'shots'), { recursive: true });
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'x11grab',
      '-video_size',
      `${String(SCREEN.width)}x${String(SCREEN.height)}`,
      '-i',
      this.display,
      '-frames:v',
      '1',
      '-y',
      join(OUT, 'shots', `${fileName(name)}.png`),
    ]);
  }

  stop(): void {
    for (const child of this.children.reverse()) {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    }
    rmSync(this.profile, { recursive: true, force: true });
  }
}
