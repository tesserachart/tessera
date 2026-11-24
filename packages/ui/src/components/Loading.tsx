import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  SkeletonBox,
  Skeleton as SkulletSkeleton,
  SkulletProvider,
  type SkeletonProps,
  type SkulletConfig,
} from 'skullet/react';
import { cx } from '../cx.ts';

interface LoadGroup {
  report(id: string, pending: boolean): void;
  leave(id: string): void;
}

const LoadGroupContext = createContext<LoadGroup | null>(null);

export function useLoadPending(pending: boolean): void {
  const group = useContext(LoadGroupContext);
  const id = useId();
  useLayoutEffect(() => {
    group?.report(id, pending);
  }, [group, id, pending]);
  useLayoutEffect(() => (group ? () => group.leave(id) : undefined), [group, id]);
}

export const LOADING_THEME: NonNullable<SkulletConfig['theme']> = {
  light: { base: 'var(--raise)', highlight: 'var(--mist-10)' },
  dark: { base: 'var(--raise)', highlight: 'var(--mist-10)' },
  animation: 'shimmer',
  speed: 'slow',
  radius: 'var(--radius)',
};

export function LoadingProvider({ children }: { children: ReactNode }) {
  return (
    <SkulletProvider theme={LOADING_THEME} reveal="together">
      {children}
    </SkulletProvider>
  );
}

export const SKIP_SKELETON = { 'skullet-ignore': '' } as const;

const LOADED_CLASS = 't-loaded';
const COVERED_CLASS = 't-load-covered';

export interface LoadedProps {
  label: string;
  pending?: boolean;
  alone?: boolean;
  sample?: ReactNode;
  children: ReactNode;
}

export function Loaded({ label, pending: own = false, alone = false, sample, children }: LoadedProps) {
  const pending = useRef(new Map<string, boolean>());
  const [changes, setChanges] = useState(0);
  const [group] = useState<LoadGroup>(() => ({
    report: (id, isPending) => {
      if (pending.current.get(id) === isPending) return;
      pending.current.set(id, isPending);
      setChanges((n) => n + 1);
    },
    leave: (id) => {
      if (pending.current.delete(id)) setChanges((n) => n + 1);
    },
  }));
  const [shown, setShown] = useState(false);
  useLoadPending(!alone && !shown);
  useLayoutEffect(() => {
    if (!shown && !own && ![...pending.current.values()].includes(true)) setShown(true);
  }, [shown, own, changes]);
  return (
    <LoadGroupContext.Provider value={group}>
      {shown ? null : (
        <div className="contents" role="status" aria-busy="true" aria-label={label}>
          <RememberedSkeleton label={label} sample={sample} />
        </div>
      )}
      <div className={shown ? 'contents' : 'hidden'}>
        <SkulletSkeleton id={label} className={LOADED_CLASS}>
          {children}
        </SkulletSkeleton>
      </div>
    </LoadGroupContext.Provider>
  );
}

function RememberedSkeleton({
  label,
  sample = null,
  className = LOADED_CLASS,
}: {
  label: string;
  sample?: ReactNode;
  className?: string;
}) {
  return (
    <SkulletSkeleton id={label} loading className={className}>
      {sample}
    </SkulletSkeleton>
  );
}

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type RevealProps<T> = Without<SkeletonProps<T>, 'id' | 'label' | 'className'> & { label: string };

export function Reveal<T>({ label, ...rest }: RevealProps<T>) {
  return <SkulletSkeleton {...rest} id={label} label={label} className={LOADED_CLASS} />;
}

export interface LoadCoverProps {
  label: string;
  active: boolean;
  held: boolean;
  waitMs: number;
  children: ReactNode;
}

function drawsOnlyFiller(cover: HTMLElement | null): boolean {
  const snapshot = cover?.querySelector('[skullet-snapshot]');
  return !!snapshot && [...snapshot.children].every((c) => c.hasAttribute('skullet-block') && !c.className);
}

export function LoadCover({ label, active, held, waitMs, children }: LoadCoverProps) {
  const pending = useRef(new Map<string, boolean>());
  const [changes, setChanges] = useState(0);
  const [group] = useState<LoadGroup>(() => ({
    report: (id, isPending) => {
      if (pending.current.get(id) === isPending) return;
      pending.current.set(id, isPending);
      setChanges((n) => n + 1);
    },
    leave: (id) => {
      if (pending.current.delete(id)) setChanges((n) => n + 1);
    },
  }));
  const [settled, setSettled] = useState(!active);
  useLayoutEffect(() => {
    if (settled || held || [...pending.current.values()].includes(true)) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setSettled(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [settled, held, changes]);
  const cover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (settled) return;
    const frame = requestAnimationFrame(() => {
      if (drawsOnlyFiller(cover.current)) setSettled(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [settled]);
  useLayoutEffect(() => {
    if (settled) return;
    const t = setTimeout(() => setSettled(true), waitMs);
    return () => clearTimeout(t);
  }, [settled, waitMs]);
  return (
    <LoadGroupContext.Provider value={settled ? null : group}>
      <SkulletSkeleton id={label} className={COVERED_CLASS}>
        {children}
      </SkulletSkeleton>
      {settled ? null : (
        <div ref={cover} className="absolute inset-0 z-[2000] bg-ink" role="status" aria-busy="true" aria-label={label}>
          <RememberedSkeleton label={label} className="t-load-cover" />
        </div>
      )}
    </LoadGroupContext.Provider>
  );
}

export interface SampleSkeletonProps {
  label: string;
  className?: string;
  children: ReactNode;
}

export function SampleSkeleton({ label, className, children }: SampleSkeletonProps) {
  return (
    <div className={className} role="status" aria-busy="true" aria-label={label}>
      <SkulletSkeleton loading className={LOADED_CLASS}>
        {children}
      </SkulletSkeleton>
    </div>
  );
}

export interface BoneProps {
  w?: number | string;
  h?: number;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ w, h = 12, className, style }: BoneProps) {
  return (
    <span
      className={cx('block shrink-0', className)}
      style={{ width: w ?? '100%', height: h, ...style }}
      aria-hidden="true"
    >
      <SkeletonBox width="100%" height="100%" radius="var(--radius)" />
    </span>
  );
}
