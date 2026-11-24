import type { ChartApi } from '@tessera/chart';
import { Skeleton } from '@tessera/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { chartFrame, chartSketch, rememberedAxisWidth, type ChartSketch } from './chartSkeleton.ts';
import { useChartTheme } from './chartTheme.ts';

export interface ChartSkeletonProps {
  chart: ChartApi | null;
  instrument: string | null;
}

export function ChartSkeleton({ chart, instrument }: ChartSkeletonProps) {
  const root = useRef<HTMLDivElement>(null);
  const [sketch, setSketch] = useState<ChartSketch | null>(null);
  const grid = useChartTheme((s) => s.theme.grid);
  const border = useChartTheme((s) => s.theme.border);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const axis = instrument ? rememberedAxisWidth(instrument) : null;
    const measure = () => {
      const size = { width: el.clientWidth, height: el.clientHeight };
      setSketch(chartSketch(chartFrame(size, chart?.coords() ?? null, axis)));
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    const offPanes = chart?.on('panes', measure);
    return () => {
      resize.disconnect();
      offPanes?.();
    };
  }, [chart, instrument]);
  const frame = sketch?.frame;
  return (
    <div ref={root} className="chart-sketch" aria-hidden="true">
      {sketch && frame ? (
        <>
          {sketch.gridYs.map((y) => (
            <i
              key={`g${String(y)}`}
              className="chart-sketch-rule"
              style={{ top: y, width: frame.main.w, background: grid }}
            />
          ))}
          {frame.panes.map((p) => (
            <i
              key={`p${String(p.y)}`}
              className="chart-sketch-rule"
              style={{ top: p.y, width: frame.width, background: border }}
            />
          ))}
          <i
            className="chart-sketch-rule"
            data-axis="price"
            style={{ left: frame.priceAxis.x, top: 0, width: 1, height: frame.priceAxis.h, background: border }}
          />
          <i
            className="chart-sketch-rule"
            data-axis="time"
            style={{ top: frame.timeAxis.y, width: frame.width, background: border }}
          />
          {sketch.candles.map((c) => (
            <span key={c.x} className="chart-sketch-candle" style={{ left: c.x, width: c.bodyW }}>
              <i className="chart-sketch-wick" style={{ top: c.wickTop, height: c.wickH }} />
              <Skeleton className="chart-sketch-at" w={c.bodyW} h={c.bodyH} style={{ top: c.bodyTop }} />
            </span>
          ))}
          {[...sketch.priceLabels, ...sketch.timeLabels].map((l) => (
            <Skeleton
              key={`l${String(l.x)}-${String(l.y)}`}
              className="chart-sketch-at"
              w={l.w}
              h={l.h}
              style={{ left: l.x, top: l.y }}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}
