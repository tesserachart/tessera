import { useLayoutEffect, useRef } from 'react';
import { tapeRow } from './tapeView.ts';

const SAMPLE_ROWS = 60;

export function TapeSample({ millis, aggregate }: { millis: boolean; aggregate: boolean }) {
  const rows = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = rows.current;
    if (!el) return;
    el.replaceChildren(
      ...Array.from({ length: SAMPLE_ROWS }, (_, i) => {
        const row = tapeRow(el.ownerDocument);
        row.el.style.top = `calc(var(--row-h-ladder) * ${String(i)})`;
        row.time.textContent = '00:00:00';
        if (millis) row.ms.textContent = '.000';
        row.price.textContent = '00000.00';
        row.size.textContent = String(1 + ((i * 13) % 40));
        if (aggregate) row.count.textContent = '×0';
        else row.count.remove();
        return row.el;
      }),
    );
  }, [millis, aggregate]);
  return (
    <div className="t-tape" data-millis={millis ? 'true' : 'false'} data-agg={aggregate ? 'true' : 'false'}>
      <div ref={rows} className="t-tape-rows" />
    </div>
  );
}
