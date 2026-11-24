import { motionAllowed } from './motion';

const REVEAL_SELECTOR = '[data-reveal], .words';

function revealTargets(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR);
}

function showAll(targets: NodeListOf<HTMLElement>): void {
  targets.forEach((el) => el.classList.add('is-in'));
}

function reveal(): void {
  const targets = revealTargets();
  if (!motionAllowed() || !('IntersectionObserver' in window)) {
    showAll(targets);
    return;
  }

  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    const fold = window.innerHeight;
    targets.forEach((el) => {
      if (el.getBoundingClientRect().top < fold) el.classList.add('is-in');
    });
    document.documentElement.setAttribute('data-reveal-ready', '');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.01 },
    );
    targets.forEach((el) => {
      if (!el.classList.contains('is-in')) io.observe(el);
    });
  };

  if (window.scrollY > 0) {
    start();
    return;
  }
  window.addEventListener('scroll', start, { passive: true, once: true });
  window.addEventListener(
    'load',
    () => {
      if (window.scrollY > 0) start();
    },
    { once: true },
  );
}

function nav(): void {
  const el = document.querySelector<HTMLElement>('[data-nav]');
  if (!el) return;
  let last = window.scrollY;
  let queued = false;
  const update = (): void => {
    queued = false;
    const y = window.scrollY;
    el.classList.toggle('is-solid', y > 8);
    if (motionAllowed() && !el.contains(document.activeElement)) {
      const down = y > last + 4;
      const up = y < last - 4;
      if (down && y > 640) el.classList.add('is-hidden');
      else if (up || y < 640) el.classList.remove('is-hidden');
    }
    last = y;
  };
  window.addEventListener(
    'scroll',
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  el.addEventListener('focusin', () => el.classList.remove('is-hidden'));
  update();
}

reveal();
nav();
