import { PrivateScope } from '@tessera/ui';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { ErrorBoundary } from '../app/ErrorBoundary.tsx';
import { useNoProfileWithoutAccounts } from './profile/hooks.ts';
import { AREAS, preloadAreas } from './registry.ts';
import { useArea, type AreaId } from './store.ts';

export function AreaView({ desk }: { desk: ReactNode }) {
  const area = useArea((s) => s.area);
  useNoProfileWithoutAccounts();
  const [seen, setSeen] = useState<ReadonlySet<AreaId>>(() => new Set([area]));
  if (!seen.has(area)) setSeen(new Set([...seen, area]));
  useEffect(() => {
    // WebKit (the desktop shell's webview) has no idle callback
    const w = window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => preloadAreas(), { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(preloadAreas, 2000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <>
      <div className="ar-desk" inert={area !== 'desk'}>
        {desk}
      </div>
      {AREAS.filter((a) => a.page !== null && seen.has(a.id)).map((a) => {
        const Page = a.page!;
        const page = (
          <Suspense fallback={null}>
            <Page />
          </Suspense>
        );
        return (
          <div
            key={a.id}
            className="ar-layer"
            hidden={area !== a.id}
            data-area={a.id}
            {...(a.private ? { 'data-private': '' } : {})}
          >
            <ErrorBoundary name={a.label}>{a.private ? <PrivateScope>{page}</PrivateScope> : page}</ErrorBoundary>
          </div>
        );
      })}
    </>
  );
}
