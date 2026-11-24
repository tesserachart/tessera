import { useLayoutEffect, useRef, type RefObject } from 'react';
import { ladderRow } from './ladderView.ts';

const SAMPLE_ROWS = 60;
const SAMPLE_PRICE = '00000.00';

function sampleSize(i: number): string {
  return String(1 + ((i * 37) % 180));
}

export function LadderSample({ like }: { like: RefObject<HTMLElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const real = like.current;
    if (real) {
      el.className = real.className;
      Object.assign(el.dataset, real.dataset);
    }
    const middle = SAMPLE_ROWS / 2;
    el.replaceChildren(
      ...Array.from({ length: SAMPLE_ROWS }, (_, i) => {
        const row = ladderRow(el.ownerDocument);
        row.price.data = SAMPLE_PRICE;
        if (i < middle) row.askSize.data = sampleSize(i);
        else row.bidSize.data = sampleSize(i);
        row.volA.data = sampleSize(i + 7);
        return row.el;
      }),
    );
  }, [like]);
  return <div ref={root} className="t-ladder" />;
}
