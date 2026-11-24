import { forwardRef, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Icon } from './Icon.tsx';
import { Key } from './Key.tsx';

export interface EnterAction {
  shortcut: string;
  label: ReactNode;
}

export interface CommandLineProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> {
  value: string;
  onChange: (value: string) => void;
  to?: 'you' | 'analyst';
  enter?: readonly EnterAction[] | { inert: ReactNode } | null;
  lineClassName?: string;
}

export const CommandLine = forwardRef<HTMLInputElement, CommandLineProps>(function CommandLine(
  { value, onChange, to = 'you', enter, lineClassName, className, ...rest },
  ref,
) {
  return (
    <div className={cx('t-cmd', lineClassName)} data-to={to === 'analyst' ? 'analyst' : undefined}>
      <Icon name="analyst" className="prompt" />
      <input
        ref={ref}
        className={cx('text', className)}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      {enter ? <EnterHint enter={enter} /> : null}
    </div>
  );
});

export function EnterHint({ enter }: { enter: readonly EnterAction[] | { inert: ReactNode } }) {
  if ('inert' in enter) return <span className="t-enter is-inert">{enter.inert}</span>;
  return (
    <span className="t-enter">
      {enter.map((a, i) => (
        <span key={i} className="act">
          <Key shortcut={a.shortcut} />
          {a.label}
        </span>
      ))}
    </span>
  );
}

export interface ReadbackProps extends HTMLAttributes<HTMLDivElement> {
  rule?: ReactNode;
}

export function Readback({ rule, children, className, ...rest }: ReadbackProps) {
  return (
    <div className={cx('t-readback', className)} {...rest}>
      {children}
      {rule !== undefined ? <span className="rule">{rule}</span> : null}
    </div>
  );
}
