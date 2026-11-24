import { Icon, cx, type IconName } from '@tessera/ui';
import type { CSSProperties, ReactNode } from 'react';

function panelName(name: string): string {
  const label = name.replace(/-/g, ' ').replace(/\bpnl\b/gi, 'P&L');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function Dots() {
  return (
    <span className="jk-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function Panel({
  chrome,
  title,
  description,
  onView,
  viewLabel = 'View',
  actions,
  children,
  className,
  bodyClassName,
  flush,
  style,
}: {
  chrome: string;
  title?: ReactNode;
  description?: ReactNode;
  onView?: () => void;
  viewLabel?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
  style?: CSSProperties;
}) {
  return (
    <section
      className={cx('jk-panel', className)}
      style={style}
      aria-label={typeof title === 'string' ? title : chrome}
    >
      <header className="jk-chrome">
        <Dots />
        <div className="jk-titles">
          <h3 className="jk-title">{title ?? panelName(chrome)}</h3>
          {description ? <p className="jk-desc">{description}</p> : null}
        </div>
        {actions ? <div className="jk-actions">{actions}</div> : null}
        {onView ? (
          <button type="button" className="jk-view" onClick={onView}>
            {viewLabel}
            <Icon name="chevron-right" />
          </button>
        ) : null}
      </header>
      <div className={cx('jk-body', flush && 'is-flush', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Section({
  title,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('jk-section', className)}>
      <header className="jk-section-head">
        <h4 className="jk-caps">{title}</h4>
        {actions ? <div className="jk-actions">{actions}</div> : null}
      </header>
      <div className="jk-section-body">{children}</div>
    </section>
  );
}

export function StatRow({
  label,
  value,
  tone,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'up' | 'down' | 'brass' | undefined;
  hint?: ReactNode;
}) {
  return (
    <div className="jk-statrow">
      <span className="jk-statrow-l">
        {label}
        {hint}
      </span>
      <span className={cx('jk-statrow-v', tone)}>{value}</span>
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="jk-pagehead">
      <div className="jk-pagehead-l">
        <h2 className="jk-pagetitle">{title}</h2>
        {sub ? <p className="jk-pagesub">{sub}</p> : null}
      </div>
      {children ? <div className="jk-pagehead-r">{children}</div> : null}
    </header>
  );
}

export function Empty({
  title,
  children,
  actions,
  compact,
}: {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx('jk-empty', compact && 'is-compact')}>
      <p className="jk-empty-title">{title}</p>
      {children ? <p className="jk-empty-sub">{children}</p> : null}
      {actions ? <div className="jk-empty-actions">{actions}</div> : null}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = 'mist',
  label,
}: {
  value: number | null;
  tone?: 'up' | 'down' | 'brass' | 'mist';
  label?: string;
}) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  return (
    <span
      className="jk-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <span className={cx('jk-progress-fill', tone)} style={{ width: `${String(v * 100)}%` }} />
    </span>
  );
}
