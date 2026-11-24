import type { HTMLAttributes, ReactElement } from 'react';
import { cx } from '../cx.ts';
import { MARK_PIX, MARK_PIX16, MARK_VEC } from '../icons/glyphs.gen.ts';

export type MarkState = 'rest' | 'draft' | 'rise' | 'level' | 'lit' | 'drain';

const AQUA = 'var(--aqua)';
const HUMAN = 'currentColor';

function drainColor(p: number): string {
  return `color-mix(in oklab, var(--aqua) ${String(Math.round((1 - p) * 100))}%, var(--mist))`;
}

function rects(list: readonly (readonly number[])[], dy: number, keyPrefix: string, solid = false): ReactElement[] {
  return list.map((r, i) => (
    <rect
      key={`${keyPrefix}${String(i)}`}
      x={r[0]}
      y={r[1]! + dy}
      width={r[2]}
      height={r[3]}
      fillOpacity={!solid && r[4] !== undefined && r[4] < 1 ? r[4] : undefined}
    />
  ));
}

export function markSvg(size: number, state: MarkState = 'rest', progress = 0): ReactElement {
  const p = Math.max(0, Math.min(1, progress));
  const aCol = state === 'rest' ? HUMAN : state === 'drain' ? drainColor(p) : AQUA;
  const lift = state === 'draft' ? 0 : state === 'rise' ? p : 1;
  const seamP = state === 'lit' ? p : state === 'drain' ? 1 - p : 0;

  if (size === 16) {
    const low = state !== 'rest' && lift < 1;
    return (
      <svg className="block" width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
        {low ? (
          <>
            <g fill={HUMAN}>{rects(MARK_PIX16.draft_h, 0, 'h')}</g>
            <g style={{ fill: aCol }}>{rects(MARK_PIX16.draft_a, 0, 'a')}</g>
          </>
        ) : (
          <g fill={HUMAN}>{rects(MARK_PIX16.rest, 0, 'r')}</g>
        )}
      </svg>
    );
  }

  const key = String(size) as keyof typeof MARK_PIX;
  const pix = MARK_PIX[key] as (typeof MARK_PIX)[typeof key] | undefined;
  if (pix) {
    const total = Math.round(2 * (1 - lift));
    const dh = -Math.floor(total / 2);
    const da = total + dh;
    const lit = seamP > 0 && lift === 1 ? pix.s.slice(0, Math.ceil(pix.s.length * seamP)) : [];
    return (
      <svg
        className="block"
        width={size}
        height={size}
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        shapeRendering="crispEdges"
        overflow="visible"
        aria-hidden="true"
      >
        <g fill={HUMAN}>{rects(pix.h, dh, 'h')}</g>
        <g style={{ fill: aCol }}>{rects(pix.a, da, 'a')}</g>
        {lit.length ? <g style={{ fill: AQUA }}>{rects(lit, 0, 's', true)}</g> : null}
      </svg>
    );
  }

  const scale = size / MARK_VEC.hgt;
  const width = Math.round(MARK_VEC.w * scale);
  const drop = MARK_VEC.drop * (1 - lift);
  return (
    <svg
      className="block"
      width={width}
      height={size}
      viewBox={`0 0 ${String(MARK_VEC.w)} ${String(MARK_VEC.hgt)}`}
      overflow="visible"
      aria-hidden="true"
    >
      <path fill={HUMAN} d={MARK_VEC.h} />
      <path style={{ fill: aCol }} transform={`translate(0 ${String(drop)})`} d={MARK_VEC.a} />
      {seamP > 0 && lift === 1 ? (
        <path
          d={MARK_VEC.seam}
          fill="none"
          style={{ stroke: AQUA }}
          strokeWidth={13}
          pathLength={1}
          strokeDasharray={`${String(seamP)} 1`}
        />
      ) : null}
    </svg>
  );
}

export interface MarkProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  size?: number;
  state?: MarkState;
  p?: number;
  label?: string;
}

export function Mark({ size = 24, state = 'rest', p = 0, label, className, ...rest }: MarkProps) {
  return (
    <i
      className={cx('inline-flex flex-none not-italic leading-[0] text-mist', className)}
      data-size={size}
      data-state={state}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...rest}
    >
      {markSvg(size, state, p)}
    </i>
  );
}

export interface CountProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  n: number;
  label?: string;
}

export function Count({ n, label, className, ...rest }: CountProps) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const text = n > 99 ? '99+' : String(Math.floor(n));
  return (
    <i
      className={cx(
        'inline-flex items-center justify-center flex-none min-w-4 h-4 px-[3px] bg-aqua text-ink font-sans text-meta not-italic font-strong leading-none tabular-nums',
        className,
      )}
      role="img"
      aria-label={label ?? text}
      {...rest}
    >
      {text}
    </i>
  );
}
