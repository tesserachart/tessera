import { useLayoutEffect, useState, type RefObject } from 'react';
import { fitHeader, FOLD_ORDER, sameFit, type Fold, type HeaderFit, type HeaderMeasure } from './fit.ts';

const FOLDED = 'data-folded';
const ITEMS = '[data-fit-tab], [data-fold], [data-fit-more], [data-fit-fixed]';

const px = (v: string) => parseFloat(v) || 0;

function outerWidth(el: Element): number {
  const s = getComputedStyle(el);
  return el.getBoundingClientRect().width + px(s.marginLeft) + px(s.marginRight);
}

function isFold(v: string | undefined): v is Fold {
  return (FOLD_ORDER as readonly string[]).includes(v ?? '');
}

const shownWidth = (el: Element | null) => (el && !el.hasAttribute(FOLDED) ? outerWidth(el) : 0);

function titleCut(title: HTMLElement): number {
  return Math.max(0, ...[title, ...title.children].map((el) => el.scrollWidth - el.clientWidth));
}

function naturalTitleWidth(title: HTMLElement): number {
  return title.clientWidth + titleCut(title);
}

function naturalTabWidth(tab: HTMLElement, active: boolean): number {
  const own = active ? shownWidth(tab.querySelector('[data-fold="tab-close"]')) : 0;
  const title = tab.querySelector<HTMLElement>('[data-fit-title]');
  return outerWidth(tab) + (title ? titleCut(title) : 0) - own;
}

function measureHeader(root: HTMLElement): HeaderMeasure | null {
  const tabs = [...root.querySelectorAll<HTMLElement>('[data-fit-tab]')];
  const active = tabs.findIndex((t) => t.hasAttribute('data-active'));
  if (active < 0) return null;
  const s = getComputedStyle(root);
  const folds = [...root.querySelectorAll<HTMLElement>('[data-fold]')].flatMap((el) => {
    const fold = el.dataset.fold;
    if (!isFold(fold)) return [];
    if (el.closest('[data-fit-tab]') !== (fold === 'tab-close' ? tabs[active] : null)) return [];
    return [{ fold, width: outerWidth(el) }];
  });
  const more = root.querySelector('[data-fit-more]');
  return {
    room: root.clientWidth - px(s.paddingLeft) - px(s.paddingRight),
    fixed: [...root.querySelectorAll('[data-fit-fixed]')].reduce((w, el) => w + outerWidth(el), 0),
    tabs: tabs.map((t, i) => naturalTabWidth(t, i === active)),
    active,
    more: more ? outerWidth(more) : 0,
    folds,
  };
}

export interface FittedHeader extends HeaderFit {
  titleFit: number | null;
}

function titleFitOf(root: HTMLElement, squeeze: number): number | null {
  if (squeeze <= 0) return null;
  const tab = root.querySelector<HTMLElement>('[data-fit-tab][data-active]');
  const title = tab?.querySelector<HTMLElement>('[data-fit-title]');
  if (!tab || !title) return null;
  return Math.max(0, Math.floor(naturalTitleWidth(title) - squeeze));
}

const sameFitted = (a: FittedHeader, b: FittedHeader) => a.titleFit === b.titleFit && sameFit(a, b);

export function useHeaderFit(root: RefObject<HTMLElement | null>, layoutKey: string): FittedHeader | null {
  const [fit, setFit] = useState<FittedHeader | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const pass = () => {
      frame = 0;
      const m = measureHeader(el);
      if (!m) return;
      const f = fitHeader(m);
      const next = { ...f, titleFit: titleFitOf(el, f.squeeze) };
      setFit((was) => (was && sameFitted(was, next) ? was : next));
    };
    const schedule = () => {
      if (!frame) frame = el.ownerDocument.defaultView?.requestAnimationFrame(pass) ?? 0;
    };
    const sizes = new ResizeObserver(schedule);
    const observeItems = () => {
      for (const item of el.querySelectorAll(ITEMS)) sizes.observe(item);
    };
    const added = new MutationObserver(() => {
      observeItems();
      schedule();
    });
    sizes.observe(el);
    observeItems();
    added.observe(el, { childList: true, subtree: true });
    pass();
    return () => {
      if (frame) el.ownerDocument.defaultView?.cancelAnimationFrame(frame);
      sizes.disconnect();
      added.disconnect();
    };
  }, [root, layoutKey]);
  return fit;
}
