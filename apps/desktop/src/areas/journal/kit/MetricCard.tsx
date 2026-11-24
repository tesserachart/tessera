import { Tooltip, cx } from '@tessera/ui';
import type { ReactNode } from 'react';
import type { MetricTip } from './tips.ts';

export function MetricCard({
  title,
  value,
  description,
  tip,
  tone,
  className,
}: {
  title: string;
  value: ReactNode;
  description?: ReactNode;
  tip?: MetricTip | undefined;
  tone?: 'up' | 'down' | 'brass' | undefined;
  className?: string;
}) {
  return (
    <div className={cx('jk-metric', className)}>
      <div className="jk-metric-head">
        <span className="jk-caps">{title}</span>
        {tip ? (
          <Tooltip content={<TipBody tip={tip} />} side="top">
            <button type="button" className="jk-info" aria-label={`About ${title}`}>
              i
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div className={cx('jk-metric-v', tone)}>{value}</div>
      {description ? <p className="jk-metric-d">{description}</p> : null}
    </div>
  );
}

function TipBody({ tip }: { tip: MetricTip }) {
  return (
    <div className="jk-tip">
      <span className="jk-tip-k">What</span>
      <p>{tip.what}</p>
      <span className="jk-tip-k">Why</span>
      <p>{tip.why}</p>
      <span className="jk-tip-k">Rule of thumb</span>
      <p>{tip.benchmark}</p>
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="jk-metrics">{children}</div>;
}
