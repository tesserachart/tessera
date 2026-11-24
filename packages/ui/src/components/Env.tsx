import { useEffect, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx.ts';

export type EnvironmentName = 'paper' | 'sim' | 'eval' | 'funded' | 'live';

export type EnvKind = 'paper' | 'eval' | 'live';

export function envKind(env: EnvironmentName): EnvKind {
  if (env === 'eval') return 'eval';
  if (env === 'live' || env === 'funded') return 'live';
  return 'paper';
}

export const ENV_LABEL: Record<EnvironmentName, string> = {
  paper: 'Paper',
  sim: 'Sim',
  eval: 'Eval',
  funded: 'Funded',
  live: 'Live',
};

export function useDocumentEnv(env: EnvironmentName | null, root?: HTMLElement): void {
  useEffect(() => {
    const el = root ?? document.documentElement;
    if (env) el.setAttribute('data-env', envKind(env));
    else el.removeAttribute('data-env');
    return () => el.removeAttribute('data-env');
  }, [env, root]);
}

export interface EnvWordProps extends HTMLAttributes<HTMLSpanElement> {
  env: EnvironmentName;
  account?: ReactNode;
  left?: ReactNode;
  serif?: boolean;
  inherit?: boolean;
}

export function EnvWord({ env, account, left, serif, inherit, className, ...rest }: EnvWordProps) {
  return (
    <span
      className={cx('inline-flex items-baseline gap-2 text-t2 whitespace-nowrap', className)}
      data-env={inherit ? undefined : envKind(env)}
      aria-label={account === undefined && left === undefined ? `Environment ${ENV_LABEL[env]}` : undefined}
      {...rest}
    >
      <b
        className={cx(
          'font-strong text-(--env-fg) bg-(--env-bg) p-(--env-pad) m-(--env-mar)',
          serif && 'font-serif text-nav leading-none font-normal normal-nums',
        )}
      >
        {ENV_LABEL[env]}
      </b>
      {account !== undefined ? <span>{account}</span> : null}
      {left !== undefined ? (
        <>
          <span className="text-t4">·</span>
          <span className="text-brass">{left}</span>
        </>
      ) : null}
    </span>
  );
}
