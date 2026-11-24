import { formatElapsed, PRICE_TEXT, cx } from '@tessera/ui';
import { useNow } from '../app/runtimeContext.ts';

export function Elapsed({ verb, since }: { verb: string; since: number }) {
  const ms = Math.max(0, useNow() - since);
  return (
    <span className="cn-wait" role="status">
      {verb} · <span className={cx('text-t3', PRICE_TEXT)}>{formatElapsed(ms)}</span>
    </span>
  );
}
