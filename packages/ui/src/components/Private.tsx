import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';

const PrivateContext = createContext(false);

export function PrivateScope({ children }: { children: ReactNode }) {
  return <PrivateContext.Provider value={true}>{children}</PrivateContext.Provider>;
}

export function usePrivate(): { 'data-private'?: '' } {
  return useContext(PrivateContext) ? { 'data-private': '' } : {};
}

export function PrivateHost() {
  const mark = useRef<HTMLTemplateElement>(null);
  useLayoutEffect(() => {
    const host = mark.current?.parentElement;
    if (!host) return;
    host.setAttribute('data-private', '');
    return () => host.removeAttribute('data-private');
  }, []);
  return <template ref={mark} />;
}
