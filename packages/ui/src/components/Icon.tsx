import type { SVGAttributes } from 'react';
import { cx } from '../cx.ts';
import { GLYPHS, ICON_CUT_SIZES, ICON_LABELS, type IconName } from '../icons/glyphs.gen.ts';

export type { IconName };

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];

export function iconLabel(name: IconName): string {
  return ICON_LABELS[name];
}

export const ICON = 't-icon inline-block flex-none align-middle text-t3';

export interface IconProps extends Omit<SVGAttributes<SVGSVGElement>, 'name'> {
  name: IconName;
  title?: string;
}

export function Icon({ name, title, className, ...rest }: IconProps) {
  const glyph = GLYPHS[name];
  return (
    <svg
      className={cx(ICON, className)}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      data-icon={name}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <g className="t-icon-vec">
        {glyph.stroke ? (
          <path
            d={glyph.stroke}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="square"
            strokeLinejoin="miter"
          />
        ) : null}
        {glyph.fills.map((d) => (
          <path key={d} d={d} fill="currentColor" stroke="none" />
        ))}
      </g>
      {ICON_CUT_SIZES.map((size) => (
        <path
          key={size}
          className="t-icon-cut"
          data-cut={size}
          d={glyph.cuts[size]}
          transform={`scale(${String(20 / size)})`}
          fill="currentColor"
          shapeRendering="crispEdges"
        />
      ))}
    </svg>
  );
}
