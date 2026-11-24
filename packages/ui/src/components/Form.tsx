import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Icon } from './Icon.tsx';

export interface FormSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  headerRight?: ReactNode;
  children: ReactNode;
}

export function FormSection({ title, description, headerRight, className, children, ...rest }: FormSectionProps) {
  return (
    <section className={cx('t-form-sec', className)} {...rest}>
      {title || description || headerRight ? (
        <header className="hd">
          <div className="tt">
            {title ? <h3 className="t-form-title">{title}</h3> : null}
            {description ? <p className="t-form-note">{description}</p> : null}
          </div>
          {headerRight ? <div className="end">{headerRight}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export interface FormRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  layout?: 'end' | 'fill' | 'stack';
  children: ReactNode;
}

export function FormRow({ label, htmlFor, hint, error, layout = 'end', className, children, ...rest }: FormRowProps) {
  return (
    <div className={cx('t-form-row', error ? 'is-error' : undefined, className)} data-layout={layout} {...rest}>
      {htmlFor ? (
        <label className="lab" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="lab">{label}</span>
      )}
      <div className="val">{children}</div>
      {error ? (
        <span className="err" role="alert">
          <Icon name="attention" />
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function FormHint({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx('t-form-hint', className)} {...rest} />;
}

export interface FormActionsProps extends HTMLAttributes<HTMLDivElement> {
  start?: ReactNode;
}

export function FormActions({ start, className, children, ...rest }: FormActionsProps) {
  return (
    <div className={cx('t-form-actions', className)} {...rest}>
      {start ? <div className="start">{start}</div> : null}
      {children}
    </div>
  );
}
