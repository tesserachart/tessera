export const FOLD_ORDER = ['close', 'scope', 'popout', 'maximise', 'split', 'add', 'tab-close'] as const;

export type Fold = (typeof FOLD_ORDER)[number];

export interface HeaderMeasure {
  room: number;
  fixed: number;
  tabs: readonly number[];
  active: number;
  more: number;
  folds: readonly { fold: Fold; width: number }[];
}

export interface HeaderFit {
  shown: ReadonlySet<number>;
  folded: ReadonlySet<Fold>;
  squeeze: number;
}

const rank = (f: Fold) => FOLD_ORDER.indexOf(f);
const sum = (xs: readonly number[]) => xs.reduce((s, w) => s + w, 0);

function withNeighbours(tabs: readonly number[], active: number, space: number): Set<number> {
  const shown = new Set([active]);
  let left = space - (tabs[active] ?? 0);
  tabs.forEach((w, i) => {
    if (i === active || w > left) return;
    shown.add(i);
    left -= w;
  });
  return shown;
}

export function fitHeader(m: HeaderMeasure): HeaderFit {
  const folds = [...m.folds].sort((a, b) => rank(a.fold) - rank(b.fold));
  const all = new Set(m.tabs.keys());
  const active = m.tabs[m.active] ?? 0;
  const more = m.tabs.length > 1 ? m.more : 0;
  for (let k = 0; k <= folds.length; k++) {
    const folded = new Set(folds.slice(0, k).map((f) => f.fold));
    const space = m.room - m.fixed - sum(folds.slice(k).map((f) => f.width));
    if (sum(m.tabs) <= space) return { shown: all, folded, squeeze: 0 };
    if (active <= space - more) return { shown: withNeighbours(m.tabs, m.active, space - more), folded, squeeze: 0 };
  }
  return {
    shown: new Set([m.active]),
    folded: new Set(folds.map((f) => f.fold)),
    squeeze: Math.ceil(active - (m.room - m.fixed - more)),
  };
}

export function sameFit(a: HeaderFit, b: HeaderFit): boolean {
  const same = <T>(x: ReadonlySet<T>, y: ReadonlySet<T>) => x.size === y.size && [...x].every((v) => y.has(v));
  return a.squeeze === b.squeeze && same(a.shown, b.shown) && same(a.folded, b.folded);
}
