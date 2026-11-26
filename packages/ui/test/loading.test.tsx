import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { forgetShapes } from 'skullet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOADING_THEME, LoadCover, Loaded, LoadingProvider, Skeleton } from '../src/index.ts';

beforeEach(() => {
  forgetShapes();
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Card() {
  return (
    <section className="card-grid">
      <h2>Open positions</h2>
      <p>NQ Z6 long 2</p>
    </section>
  );
}

const busy = (label: string) => screen.getByRole('status', { name: label });

describe('a surface that loads', () => {
  it('shows a measured skeleton from Skullet while it loads, with no words', () => {
    render(
      <Loaded label="Loading the card" pending>
        <Card />
      </Loaded>,
    );
    const status = busy('Loading the card');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.querySelector('[skullet-loading]')).not.toBeNull();
    expect(status.querySelector('[skullet-loading]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it('draws the layout it last showed under the same label the next time it loads, and stores no words', async () => {
    const first = render(
      <Loaded label="Loading the card">
        <Card />
      </Loaded>,
    );
    await waitFor(() => expect(localStorage.getItem('skullet:shapes')).toContain('card-grid'));
    first.unmount();

    render(
      <Loaded label="Loading the card" pending>
        <Card />
      </Loaded>,
    );
    const snapshot = busy('Loading the card').querySelector('[skullet-snapshot]');
    const remembered = snapshot?.querySelector('section.card-grid');
    expect(remembered?.querySelector('h2')).not.toBeNull();
    const stored = localStorage.getItem('skullet:shapes') ?? '';
    expect(stored).toContain('card-grid');
    expect(stored).not.toContain('Open positions');
    expect(stored).not.toContain('NQ Z6');
  });

  it('measures its sample the first time, when there is nothing remembered yet', () => {
    render(
      <Loaded label="Loading the picker" pending sample={<button type="button">Every account</button>}>
        <Card />
      </Loaded>,
    );
    const ghost = busy('Loading the picker').querySelector('[skullet-ghost]');
    expect(ghost?.querySelector('button')?.textContent).toBe('Every account');
    expect(ghost?.hasAttribute('skullet-inactive')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Every account' })).toBeNull();
  });

  it('keeps what loads mounted once, so it never reads or runs twice', () => {
    const mounts = vi.fn();
    function Counted() {
      useEffect(() => {
        mounts();
      }, []);
      return <p>ready</p>;
    }
    const view = render(
      <Loaded label="Loading the counter" pending>
        <Counted />
      </Loaded>,
    );
    view.rerender(
      <Loaded label="Loading the counter">
        <Counted />
      </Loaded>,
    );
    expect(screen.queryByRole('status', { name: 'Loading the counter' })).toBeNull();
    expect(screen.getByText('ready')).toBeTruthy();
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it('covers the desk with the desk it last showed', async () => {
    function Desk({ active }: { active: boolean }) {
      return (
        <div className="relative">
          <LoadCover label="Loading the desk" active={active} held={false} waitMs={60_000}>
            <header className="desk-head">Desk</header>
          </LoadCover>
        </div>
      );
    }
    const first = render(<Desk active={false} />);
    await waitFor(() => expect(localStorage.getItem('skullet:shapes')).toContain('desk-head'));
    first.unmount();
    render(<Desk active />);
    const cover = busy('Loading the desk');
    expect(cover.querySelector('[skullet-snapshot] header.desk-head')).not.toBeNull();
  });

  it('lets the desk’s own skeletons show rather than cover them with an empty sheet when it has never shown it', async () => {
    render(
      <div className="relative">
        <LoadCover label="Loading a desk never shown" active held={false} waitMs={60_000}>
          <header className="desk-head">Desk</header>
        </LoadCover>
      </div>,
    );
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(screen.queryByRole('status', { name: 'Loading a desk never shown' })).toBeNull();
  });
});

describe('a loaded surface in a hidden window', () => {
  function List({ rows }: { rows: number }) {
    return (
      <ul className="row-list">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="row">
            row
          </li>
        ))}
      </ul>
    );
  }
  const rememberedRows = () =>
    (localStorage.getItem('skullet:shapes') ?? '').split('row-list')[1]?.split('class=\\"row\\"').length ?? 0;
  const windowShown = (shown: boolean) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(shown ? 'visible' : 'hidden');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(!shown);
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('stops remembering its shape while hidden, and remembers the latest once shown', async () => {
    const view = render(
      <Loaded label="Loading the list">
        <List rows={1} />
      </Loaded>,
    );
    await waitFor(() => expect(rememberedRows()).toBe(2));
    windowShown(false);
    view.rerender(
      <Loaded label="Loading the list">
        <List rows={3} />
      </Loaded>,
    );
    await new Promise((r) => setTimeout(r, 600));
    expect(rememberedRows()).toBe(2);
    windowShown(true);
    await waitFor(() => expect(rememberedRows()).toBe(4));
  });
});

describe('the look of a skeleton', () => {
  it('uses Tessera’s own muted surface with one slow, faint shimmer', () => {
    expect(LOADING_THEME).toMatchObject({
      dark: { base: 'var(--raise)', highlight: 'var(--mist-10)' },
      light: { base: 'var(--raise)', highlight: 'var(--mist-10)' },
      animation: 'shimmer',
      speed: 'slow',
      radius: 'var(--radius)',
    });
    render(
      <LoadingProvider>
        <Skeleton w={40} />
      </LoadingProvider>,
    );
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(css).toContain('--skullet-base: var(--raise)');
    expect(css).toContain('--skullet-animation: shimmer');
  });

  it('draws a lone placeholder as one of Skullet’s bars, hidden from screen readers', () => {
    const { container } = render(<Skeleton w={40} h={10} className="lone" />);
    const box = container.querySelector('.lone');
    expect(box?.getAttribute('aria-hidden')).toBe('true');
    expect(box?.querySelector('[skullet-bar]')).not.toBeNull();
  });
});

describe('the motion of a skeleton', () => {
  function shimmerRuns(reduceMotion: boolean): boolean {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduceMotion && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const animate = vi.fn(() => ({ cancel: () => undefined, startTime: 0 }) as unknown as Animation);
    vi.spyOn(Element.prototype, 'animate').mockImplementation(animate);
    render(
      <LoadingProvider>
        <Skeleton w={40} className="moving" />
      </LoadingProvider>,
    );
    return animate.mock.calls.length > 0;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sweeps its shimmer across a placeholder', () => {
    expect(shimmerRuns(false)).toBe(true);
  });

  it('holds every placeholder still for someone who asks for reduced motion', () => {
    expect(shimmerRuns(true)).toBe(false);
  });
});

describe('a skeleton that goes away', () => {
  function endlessMotion(): Set<Element> {
    const running = new Map<object, Element>();
    vi.spyOn(Element.prototype, 'animate').mockImplementation(function (this: Element, _frames, options) {
      const endless = typeof options === 'object' && options.iterations === Infinity;
      const animation = {
        startTime: 0,
        finished: Promise.resolve(),
        cancel: () => running.delete(animation),
      };
      if (endless) running.set(animation, this);
      return animation as unknown as Animation;
    });
    vi.spyOn(Element.prototype, 'getAnimations').mockImplementation(function (this: Element) {
      return [...running].filter(([, target]) => target === this).map(([a]) => a as Animation);
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 16));
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 200, 16)] as never);
    return {
      get size() {
        return running.size;
      },
    } as Set<Element>;
  }

  it('stops a placeholder’s shimmer when the placeholder leaves', () => {
    const motion = endlessMotion();
    const view = render(
      <LoadingProvider>
        <Skeleton w={40} />
      </LoadingProvider>,
    );
    expect(motion.size).toBeGreaterThan(0);
    view.unmount();
    expect(motion.size).toBe(0);
  });

  it('stops every bone’s shimmer once what it stood for has loaded', () => {
    const motion = endlessMotion();
    const view = render(
      <LoadingProvider>
        <Loaded label="Loading the card" pending>
          <Card />
        </Loaded>
      </LoadingProvider>,
    );
    expect(motion.size).toBeGreaterThan(0);
    view.rerender(
      <LoadingProvider>
        <Loaded label="Loading the card">
          <Card />
        </Loaded>
      </LoadingProvider>,
    );
    expect(screen.queryByRole('status', { name: 'Loading the card' })).toBeNull();
    expect(motion.size).toBe(0);
  });
});
