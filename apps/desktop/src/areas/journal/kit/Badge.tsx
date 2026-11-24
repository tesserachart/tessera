import type { Side, TradeResult } from '@tessera/protocol';
import { Icon, cx } from '@tessera/ui';
import type { ReactNode } from 'react';

export type BadgeTone = 'default' | 'outline' | 'profit' | 'loss' | 'brass' | 'mist';

export function Badge({
  tone = 'default',
  color,
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  color?: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cx('jk-badge', `is-${color ? 'tag' : tone}`, className)}
      style={color ? { ['--tag' as string]: color } : undefined}
      title={title}
    >
      {children}
    </span>
  );
}

const RESULT: Record<TradeResult, { short: string; long: string; tone: BadgeTone }> = {
  target: { short: 'TP', long: 'Take profit', tone: 'profit' },
  stop: { short: 'SL', long: 'Stop loss', tone: 'loss' },
  trailed: { short: 'Trail', long: 'Trailed stop', tone: 'brass' },
  breakeven: { short: 'BE', long: 'Breakeven', tone: 'mist' },
  manual: { short: 'Manual', long: 'Closed by hand', tone: 'outline' },
  open: { short: 'Open', long: 'Still open', tone: 'outline' },
};

export function ResultBadge({ result }: { result: TradeResult }) {
  const r = RESULT[result];
  return (
    <Badge tone={r.tone} title={r.long}>
      {r.short}
    </Badge>
  );
}

export function DirectionChip({ side, size = 'm' }: { side: Side; size?: 's' | 'm' }) {
  const long = side === 'buy';
  return (
    <span className={cx('jk-dir', long ? 'up' : 'down', size === 's' && 's')}>
      <Icon name={long ? 'long' : 'short'} />
      {long ? 'Long' : 'Short'}
    </span>
  );
}
