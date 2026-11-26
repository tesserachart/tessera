import { AxisBottom, AxisRight, type AxisScale } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { Line } from '@visx/shape';
import type { ReactNode } from 'react';
import { money, tipLeft, VALUE_TICKS, X_TICKS, type ValueScale } from './scales.ts';

const BARE = { fill: undefined, fontFamily: undefined, fontSize: undefined };
const AXIS_LABEL = { ...BARE, className: 'gr-axis', dx: 8, dy: '0.32em', textAnchor: 'start' as const };
const X_LABEL = { ...BARE, className: 'gr-axis', dy: '0.71em', textAnchor: 'middle' as const };

export function ValueAxis({
  y,
  width,
  format = money,
}: {
  y: ValueScale;
  width: number;
  format?: (v: number) => string;
}) {
  const ticks = y.ticks(VALUE_TICKS);
  return (
    <>
      <GridRows scale={y} width={width} tickValues={ticks.filter((t) => t !== 0)} className="gr-grid" />
      {y.domain()[0]! <= 0 && y.domain()[1]! >= 0 ? (
        <Line from={{ x: 0, y: y(0) }} to={{ x: width, y: y(0) }} className="gr-zero" />
      ) : null}
      <AxisRight
        scale={y}
        left={width}
        tickValues={ticks}
        tickFormat={(v) => format(Number(v))}
        hideAxisLine
        hideTicks
        tickLabelProps={() => AXIS_LABEL}
      />
    </>
  );
}

export function XAxis({
  scale,
  top,
  values,
  format,
}: {
  scale: AxisScale<number>;
  top: number;
  values?: readonly number[];
  format: (v: number | Date) => string;
}) {
  return (
    <AxisBottom
      scale={scale}
      top={top}
      numTicks={X_TICKS}
      tickValues={values ? [...values] : undefined}
      tickFormat={(v) => format(v as number | Date)}
      hideAxisLine
      hideTicks
      tickLength={2}
      tickLabelProps={() => X_LABEL}
    />
  );
}

export function Crosshair({ x, top = 0, bottom }: { x: number; top?: number; bottom: number }) {
  return <Line from={{ x, y: top }} to={{ x, y: bottom }} className="gr-cross" />;
}

export function Tip({ x, plotW, children }: { x: number; plotW: number; children: ReactNode }) {
  return (
    <div className="gr-tip" style={{ left: tipLeft(x, plotW) }}>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="gr-empty">{children}</div>;
}
