import type { ContractSpec, Quote } from '@tessera/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { Lifetime } from '../app/lifetime.ts';
import { peekTool, runTool, toolCode, useHasTool, useTool, useToolValue, valueOf } from '../app/tools.ts';
import { quoteStore } from '../market/quotes.ts';

export interface RowVisibility {
  observe: (el: Element, cb: (visible: boolean) => void) => () => void;
}

export const RowVisibilityContext = createContext<RowVisibility | null>(null);

export function createRowVisibility(
  root: Element | null,
  margin = '160px 0px',
): RowVisibility & { dispose: () => void } {
  const listeners = new Map<Element, (visible: boolean) => void>();
  const io =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const e of entries) listeners.get(e.target)?.(e.isIntersecting);
          },
          { root, rootMargin: margin },
        );
  return {
    observe: (el, cb) => {
      if (!io) {
        cb(true);
        return () => undefined;
      }
      listeners.set(el, cb);
      io.observe(el);
      return () => {
        listeners.delete(el);
        io.unobserve(el);
      };
    },
    dispose: () => {
      io?.disconnect();
      listeners.clear();
    },
  };
}

const ROW_PX = 24;
const OVERSCAN_ROWS = 7;

export function firstScreenRows(): number {
  return Math.ceil((typeof window === 'undefined' ? 0 : window.innerHeight) / ROW_PX) + OVERSCAN_ROWS;
}

export function useRowInView(ref: RefObject<Element | null>, eager = false): { visible: boolean; seen: boolean } {
  const vis = useContext(RowVisibilityContext);
  const [visible, setVisible] = useState(vis === null);
  const [seen, setSeen] = useState(vis === null);
  useEffect(() => {
    const el = ref.current;
    if (!vis || !el) return;
    return vis.observe(el, (v) => {
      setVisible(v);
      if (v) setSeen(true);
    });
  }, [vis, ref]);
  return { visible, seen: seen || eager };
}

const FIRST_QUOTE_KEPT = { keepFor: 60_000 };

export function useRowQuote(instrument: string | null, live: boolean, seed = true): Quote | undefined {
  const has = useHasTool('market.get_quote');
  const first = useToolValue('market.get_quote', has && seed && instrument ? { instrument } : null, FIRST_QUOTE_KEPT);
  useEffect(() => (instrument && live ? quoteStore.watch(instrument) : undefined), [instrument, live]);
  const subscribe = useCallback(
    (cb: () => void) => (instrument ? quoteStore.listen(instrument, cb) : () => undefined),
    [instrument],
  );
  const snapshot = useCallback(() => (instrument ? quoteStore.get(instrument) : undefined), [instrument]);
  return useSyncExternalStore(subscribe, snapshot) ?? first;
}

export function useRowSpec(
  id: string,
  listed: boolean,
  seen: boolean,
): { spec: ContractSpec | null; resolved: string | null; missing: boolean } {
  const has = useHasTool('market.get_contract_spec');
  const q = useTool('market.get_contract_spec', has && seen && id !== '' ? { instrument: id } : null, SPEC_KEPT);
  const spec = valueOf(q)?.spec ?? null;
  return {
    spec,
    resolved: listed ? id : (spec?.instrument ?? null),
    missing: q.isError && !spec && toolCode(q.error) === 'not_found',
  };
}

const SPEC_KEPT = { keepFor: Infinity };

export function useResolvedOf(): (id: string) => string {
  return useCallback(
    (id: string) => peekTool('market.get_contract_spec', { instrument: id })?.spec.instrument ?? id,
    [],
  );
}

export function useSortQuotes(ids: readonly string[], fill: boolean, cap = 150): (id: string) => Quote | undefined {
  const version = useRef(0);
  const subscribe = useCallback((cb: () => void) => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = quoteStore.listenAll(() => {
      t ??= setTimeout(() => {
        t = null;
        version.current++;
        cb();
      }, 1000);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, []);
  useSyncExternalStore(subscribe, () => version.current);
  const asked = useRef(new Map<string, number>());
  const key = ids.join('\n');
  useEffect(() => {
    if (!fill || !key) return;
    const now = Date.now();
    const want = key
      .split('\n')
      .filter((id) => !quoteStore.get(id) && now - (asked.current.get(id) ?? 0) > 60_000)
      .slice(0, cap);
    for (const id of want) asked.current.set(id, now);
    const reads = new Lifetime();
    void fillQuotes(want, reads.live());
    return () => {
      reads.end();
    };
  }, [fill, key, cap]);
  return useCallback((id: string) => quoteStore.get(id), []);
}

async function fillQuotes(ids: readonly string[], live: () => boolean): Promise<void> {
  for (let i = 0; i < ids.length && live(); i += 6) {
    const got = await Promise.all(
      ids.slice(i, i + 6).map((instrument) => runTool('market.get_quote', { instrument }).catch(() => undefined)),
    );
    if (!live()) return;
    for (const q of got) if (q && !quoteStore.get(q.instrument)) quoteStore.apply(q);
    quoteStore.notifyNow();
  }
}
