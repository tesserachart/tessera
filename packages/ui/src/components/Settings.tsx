import {
  Children,
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../cx.ts';
import { Button } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';

export interface RailItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  current?: boolean;
  badge?: ReactNode;
  progress?: number | null | undefined;
}

function RailProgress({ fraction }: { fraction: number | null }) {
  return (
    <span
      aria-hidden="true"
      className="t-rail-progress absolute inset-x-0 top-[calc(100%+1px)] h-0.5 overflow-hidden bg-line-2"
    >
      <span
        className="block h-full origin-left bg-mist [transition:transform_200ms_var(--ease-out)] motion-reduce:[transition:none]"
        style={{ transform: `scaleX(${String(fraction ?? 0)})` }}
      />
    </span>
  );
}

export const RailItem = forwardRef<HTMLButtonElement, RailItemProps>(function RailItem(
  { icon, label, current = false, badge, progress, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('t-rail-item', current && 'is-on', className)}
      aria-current={current ? 'page' : undefined}
      {...rest}
    >
      <span className={cx('ic', progress !== undefined && 'mb-0.75')}>
        <Icon name={icon} />
        {badge ? <span className="t-rail-badge">{badge}</span> : null}
        {progress === undefined ? null : <RailProgress fraction={progress} />}
      </span>
      <span className="w">{label}</span>
    </button>
  );
});

export interface SettingsNavItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  label: ReactNode;
  current?: boolean;
}

export function SettingsNavItem({ icon, label, current = false, className, ...rest }: SettingsNavItemProps) {
  return (
    <button
      type="button"
      className={cx('t-set-nav-item', current && 'is-on', className)}
      aria-current={current ? 'page' : undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      <span className="w">{label}</span>
    </button>
  );
}

export interface SettingsSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  bare?: boolean;
  children?: ReactNode;
}

export function SettingsSection({
  title,
  description,
  actions,
  bare = false,
  className,
  children,
  ...rest
}: SettingsSectionProps) {
  return (
    <section className={cx('t-set-sec', className)} {...rest}>
      <header className="hd">
        <div className="tt">
          <h2 className="t-set-title">{title}</h2>
          {description ? <p className="t-set-note">{description}</p> : null}
        </div>
        {actions ? <div className="end">{actions}</div> : null}
      </header>
      {Children.toArray(children).length > 0 ? (
        <div className={bare ? 't-set-bare' : 't-set-card'}>{children}</div>
      ) : null}
    </section>
  );
}

export interface SettingsRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  layout?: 'end' | 'stack';
  compact?: boolean;
  children?: ReactNode;
}

export function SettingsRow({
  label,
  help,
  error,
  layout = 'end',
  compact = false,
  className,
  children,
  ...rest
}: SettingsRowProps) {
  return (
    <div
      className={cx('t-set-row', compact && 'is-compact', error ? 'is-error' : undefined, className)}
      data-layout={layout}
      {...rest}
    >
      <div className="lab">
        <span className="t">{label}</span>
        {error ? (
          <span className="err" role="alert">
            <Icon name="attention" />
            {error}
          </span>
        ) : help ? (
          <span className="help">{help}</span>
        ) : null}
      </div>
      {children !== undefined && children !== null ? <div className="val">{children}</div> : null}
    </div>
  );
}

export interface SearchFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  className?: string;
  controls?: string;
  activeDescendant?: string;
}

export function SearchField({
  value,
  onValueChange,
  label,
  placeholder,
  onKeyDown,
  inputRef,
  autoFocus,
  className,
  controls,
  activeDescendant,
}: SearchFieldProps) {
  const own = useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? own;
  return (
    <div className={cx('t-search-field', className)}>
      <Icon name="search" />
      <input
        ref={ref}
        type="search"
        role={controls ? 'combobox' : undefined}
        aria-expanded={controls ? value !== '' : undefined}
        aria-controls={controls}
        aria-activedescendant={activeDescendant}
        aria-autocomplete={controls ? 'list' : undefined}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          if (value) onValueChange('');
          else ref.current?.blur();
        }}
      />
      {value ? (
        <button
          type="button"
          className="x"
          aria-label="Clear the search"
          tabIndex={-1}
          onClick={() => {
            onValueChange('');
            ref.current?.focus();
          }}
        >
          <Icon name="close" />
        </button>
      ) : null}
    </div>
  );
}

export interface ConfirmButtonProps {
  children: ReactNode;
  what?: ReactNode;
  question?: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  blocked?: boolean;
  keepLabel?: string;
  className?: string;
  describedBy?: string;
}

export function ConfirmButton({
  children,
  what,
  question,
  onConfirm,
  disabled,
  blocked,
  keepLabel = 'Keep',
  className,
  describedBy,
}: ConfirmButtonProps) {
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!asking) return;
    const away = (e: PointerEvent) => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setAsking(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [asking]);
  if (!asking)
    return (
      <Button
        size="s"
        variant="quiet"
        className={className}
        disabled={disabled}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={describedBy}
        onClick={() => {
          if (!blocked) setAsking(true);
        }}
      >
        {children}
      </Button>
    );
  return (
    <span
      ref={box}
      className={cx('t-confirm', className)}
      role="group"
      aria-label="Confirm"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        setAsking(false);
      }}
    >
      {question ? <span className="q">{question}</span> : null}
      <Button size="s" variant="quiet" autoFocus onClick={() => setAsking(false)}>
        {keepLabel}
      </Button>
      <Button
        size="s"
        variant="destructive"
        what={what}
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {children}
      </Button>
    </span>
  );
}

export function SecretMask({ className }: { className?: string }) {
  return (
    <span className={cx('t-secret', className)} role="img" aria-label="Hidden">
      ••••••••
    </span>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  rows?: number;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, rows = 5, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={cx('t-textarea', className)} {...rest} />;
});
