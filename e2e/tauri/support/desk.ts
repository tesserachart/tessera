import { type Element, type Session, until, untilSaying } from './webdriver.ts';

const CONTROL = '\uE009';
const ENTER = '\uE007';

const UNDER_THE_POINTER = `
  const target = (() => { %FIND% })();
  if (!target) return 'it is not on the page';
  const busy = [...document.querySelectorAll('[role=status][aria-busy=true], [role=status][aria-label="Loading bars"]')];
  if (busy.length > 0) return 'the page is loading: ' + busy.map((b) => b.getAttribute('aria-label') ?? b.textContent).join(', ');
  const r = target.getBoundingClientRect();
  const at = [r.x, r.y, r.width, r.height].map(Math.round).join(',');
  const settled = target.__tesseraAt === at;
  target.__tesseraAt = at;
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  if (!hit || !target.contains(hit)) {
    const name = (e) => e ? e.tagName.toLowerCase() + (e.getAttribute('aria-label') ? ' "' + e.getAttribute('aria-label') + '"' : '') + '.' + String(e.className).split(' ').filter(Boolean).slice(0, 2).join('.') : 'nothing';
    const style = getComputedStyle(target);
    return 'at ' + at + ' in a ' + innerWidth + 'x' + innerHeight + ' window, ' + name(hit) + ' is on top of it' +
      (style.visibility !== 'visible' ? ' (it is ' + style.visibility + (target.closest('[data-folded]') ? ', folded into More' : '') + ')' : '');
  }
  return settled ? target : 'it is still moving, at ' + at;`;

const GROUP_BUTTON = `
  const group = [...document.querySelectorAll('.dv-groupview')].find((g) =>
    [...g.querySelectorAll('.dock-tab')].some((t) => t.textContent === arguments[0]));
  return group?.querySelector('[role=toolbar] button[aria-label="' + arguments[1] + '"]');`;

export class Desk {
  readonly session: Session;
  readonly main: string;

  private constructor(session: Session, main: string) {
    this.session = session;
    this.main = main;
  }

  static async of(session: Session): Promise<Desk> {
    return new Desk(session, await session.handle());
  }

  private async press(what: string, find: string, ...args: unknown[]): Promise<void> {
    const script = UNDER_THE_POINTER.replace('%FIND%', find);
    const target = () => untilSaying(what, () => this.session.execute<Element | string>(script, ...args));
    await this.session.hover(await target());
    await this.session.click(await target());
  }

  async inWindow<T>(handle: string, read: () => Promise<T>): Promise<T> {
    await this.session.switchTo(handle);
    try {
      return await read();
    } finally {
      await this.session.switchTo(this.main);
    }
  }

  chartTabs(): Promise<string[]> {
    return this.session.execute<string[]>(
      `return [...document.querySelectorAll('.dock-tab')].map((t) => t.textContent).filter((t) => t.includes(' · '))`,
    );
  }

  async popOut(tab: string): Promise<string> {
    const before = await this.session.handles();
    await this.press(`Pop out on ${tab}`, GROUP_BUTTON, tab, 'Pop out');
    return until(`a window for ${tab}`, async () => (await this.session.handles()).find((h) => !before.includes(h)));
  }

  async closeChart(tab: string): Promise<void> {
    await this.press(`Close Chart on ${tab}`, GROUP_BUTTON, tab, 'Close Chart');
    await until(`${tab} off the desk`, async () => !(await this.chartTabs()).includes(tab));
  }

  async newChart(symbol: string): Promise<void> {
    await this.session.press(CONTROL, 't');
    await this.session.settle();
    const search = await this.session.execute<Element | null>(
      `return document.querySelector('input[aria-label="Search symbols for a new chart tab"]')`,
    );
    if (!search) throw new Error('New chart (Ctrl+T) opened no symbol search');
    await this.session.keys(search, symbol);
    await until(`${symbol} picked by Enter`, () =>
      this.session.execute<boolean>(
        `const picked = document.getElementById(arguments[0].getAttribute('aria-activedescendant') ?? '');
        return !!picked?.textContent.startsWith(arguments[1]);`,
        search,
        symbol,
      ),
    );
    await this.session.press(ENTER);
  }

  async showsItsChart(handle: string): Promise<void> {
    await this.inWindow(handle, () =>
      until('the chart drawn in its window', () =>
        this.session.execute<boolean>(
          `return !!document.querySelector('[aria-label="Orders on the chart"]') &&
            !document.querySelector('[role=status][aria-busy=true], [role=status][aria-label="Loading bars"]')`,
        ),
      ),
    );
  }

  async dockBack(handle: string): Promise<void> {
    await this.inWindow(handle, () =>
      this.press('Dock back', `return document.querySelector('[role=toolbar] button[aria-label="Dock back"]')`),
    );
  }

  async undoClose(title: string): Promise<void> {
    await this.press(
      `the Undo of Closed ${title}`,
      `const notice = document.querySelector('[aria-label="Desk notices"]');
      if (!notice?.querySelector('[role=status]')?.textContent.startsWith('Closed ' + arguments[0])) return null;
      return [...notice.querySelectorAll('button')].find((b) => b.textContent === 'Undo');`,
      title,
    );
  }

  async listenForClicks(handle: string): Promise<void> {
    await this.inWindow(handle, () =>
      this.session.execute(
        `window.__pointerDowns = 0; window.addEventListener('pointerdown', () => { window.__pointerDowns += 1; }, true)`,
      ),
    );
  }

  clicksIn(handle: string): Promise<number> {
    return this.inWindow(handle, () => this.session.execute<number>(`return window.__pointerDowns ?? 0`));
  }
}
