import { useEffect } from 'react';

const REST = { svg: '/favicon.svg', ico: '/favicon.ico', png16: '/favicon-16.png', png32: '/favicon-32.png' };
const DRAFT = { svg: null, ico: '/favicon-draft.ico', png16: '/favicon-draft-16.png', png32: '/favicon-draft-32.png' };

export function setFaviconDraft(waiting: boolean, doc: Document = document): void {
  const set = waiting ? DRAFT : REST;
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    const which = link.dataset.icon as keyof typeof REST | undefined;
    if (!which) continue;
    const href = set[which] ?? DRAFT.png32;
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }
}

export function useFaviconDraft(waiting: boolean): void {
  useEffect(() => {
    setFaviconDraft(waiting);
  }, [waiting]);
  useEffect(() => () => setFaviconDraft(false), []);
}
