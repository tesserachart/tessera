import { cx } from '@tessera/ui';
import type { ReactNode } from 'react';

export type WidgetSize = 'sm' | 'md' | 'lg' | 'wide';

export function WidgetGrid({ children }: { children: ReactNode }) {
  return <div className="jk-grid">{children}</div>;
}

export function GridItem({ size = 'sm', children }: { size?: WidgetSize; children: ReactNode }) {
  return <div className={cx('jk-cell', `is-${size}`)}>{children}</div>;
}
