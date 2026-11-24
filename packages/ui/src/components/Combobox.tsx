import { Popover as PopoverPrimitive } from 'radix-ui';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { cx } from '../cx.ts';
import { groupOptions, moveActive, normalizeQuery, rankOptions, type ListMove, type SearchOption } from '../search.ts';
import { Icon } from './Icon.tsx';
import { ScrollArea } from './ScrollArea.tsx';
import type { SelectVariant } from './Select.tsx';
import { usePrivate } from './Private.tsx';

/** Radix overlays hear Esc on the document in the capture phase, before the search line does. */
export function escapeClearsQuery(query: string, clear: () => void): (e: globalThis.KeyboardEvent) => void {
  return (e) => {
    if (!query) return;
    e.preventDefault();
    clear();
  };
}

export interface ComboboxOption<T extends string = string> extends SearchOption<T> {
  hint?: ReactNode;
  content?: ReactNode;
}

const PAGE = 8;

export interface SearchListProps<T extends string = string> {
  options: readonly ComboboxOption<T>[];
  value?: T | null;
  onSelect: (value: T) => void;
  label: string;
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  filter?: (options: readonly ComboboxOption<T>[], query: string) => readonly ComboboxOption<T>[];
  placeholder?: string;
  empty?: ReactNode | ((query: string) => ReactNode);
  autoFocus?: boolean;
  loop?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

function startRow<T extends string>(drawn: readonly ComboboxOption<T>[], query: string, value: T | null | undefined) {
  if (
    !normalizeQuery(query) &&
    value !== null &&
    value !== undefined &&
    drawn.some((o) => o.value === value && !o.disabled)
  )
    return value;
  return moveActive(drawn, null, 'first');
}

export function SearchList<T extends string = string>({
  options,
  value,
  onSelect,
  label,
  query,
  defaultQuery = '',
  onQueryChange,
  filter = rankOptions,
  placeholder = 'Search',
  empty,
  autoFocus,
  loop,
  inputRef,
  className,
}: SearchListProps<T>) {
  const id = useId();
  const [ownQuery, setOwnQuery] = useState(defaultQuery);
  const reveal = useRef(true);
  const q = query ?? ownQuery;
  const setQuery = (next: string) => {
    reveal.current = true;
    if (query === undefined) setOwnQuery(next);
    onQueryChange?.(next);
  };

  const groups = useMemo(() => groupOptions(filter(options, q)), [filter, options, q]);
  const drawn = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  const [active, setActive] = useState<{ q: string; value: T | null }>(() => ({
    q,
    value: startRow(drawn, q, value),
  }));
  let current = active.value;
  if (active.q !== q) {
    current = startRow(drawn, q, value);
    setActive({ q, value: current });
  } else if (current !== null && !drawn.some((o) => o.value === current && !o.disabled)) {
    current = startRow(drawn, q, value);
  }
  const at = current === null ? -1 : drawn.findIndex((o) => o.value === current);
  const index = useMemo(() => new Map(drawn.map((o, i) => [o, i])), [drawn]);
  const optionId = (i: number) => `${id}-o${String(i)}`;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal.current || at < 0) return;
    reveal.current = false;
    listRef.current?.ownerDocument.getElementById(optionId(at))?.scrollIntoView({ block: 'nearest' });
  });

  const move = (m: ListMove) => {
    reveal.current = true;
    setActive({ q, value: moveActive(drawn, current, m, loop) });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const step: Partial<Record<string, ListMove>> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: PAGE,
      PageUp: -PAGE,
      Home: 'first',
      End: 'last',
    };
    const m = step[e.key];
    if (m !== undefined) {
      e.preventDefault();
      move(m);
    } else if (e.key === 'Enter') {
      if (current === null) return;
      e.preventDefault();
      onSelect(current);
    } else if (e.key === 'Escape' && q) {
      e.preventDefault();
      setQuery('');
    }
  };

  const listId = `${id}-list`;
  const nothing = typeof empty === 'function' ? empty(q) : empty;
  return (
    <div className={cx('t-search', className)}>
      <div className="t-search-line">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={at >= 0 ? optionId(at) : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <ScrollArea className="t-search-scroll" viewportRef={listRef}>
        <div role="listbox" id={listId} aria-label={label}>
          {groups.map((g, gi) => {
            const head = g.group ? `${id}-g${String(gi)}` : undefined;
            return (
              <div key={g.group ?? ''} role="group" aria-labelledby={head} className="t-search-group">
                {g.group ? (
                  <div className="t-menu-label" id={head} role="presentation">
                    {g.group}
                  </div>
                ) : null}
                {g.options.map((o) => {
                  const i = index.get(o) ?? -1;
                  const on = i === at;
                  return (
                    <div
                      key={o.value}
                      id={optionId(i)}
                      role="option"
                      aria-selected={on}
                      aria-disabled={o.disabled ? true : undefined}
                      aria-current={o.value === value || undefined}
                      data-highlighted={on ? '' : undefined}
                      data-disabled={o.disabled ? '' : undefined}
                      data-state={o.value === value ? 'checked' : undefined}
                      className="t-menu-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onPointerMove={() => {
                        if (!o.disabled && !on) setActive({ q, value: o.value });
                      }}
                      onClick={() => {
                        if (!o.disabled) onSelect(o.value);
                      }}
                    >
                      <span className="w">{o.content ?? o.label}</span>
                      {o.hint ? <span className="r">{o.hint}</span> : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {/* a listbox owns only options and groups */}
        {drawn.length === 0 ? (
          <div className="t-search-empty" role="status">
            {nothing ?? (q ? `Nothing matches “${q.trim()}”` : 'Nothing to choose')}
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}

export interface ComboboxProps<T extends string = string> {
  options: readonly ComboboxOption<T>[];
  value?: T | null;
  defaultValue?: T | null;
  onValueChange?: (value: T) => void;
  label: string;
  id?: string;
  placeholder?: ReactNode;
  searchPlaceholder?: string;
  empty?: SearchListProps<T>['empty'];
  filter?: SearchListProps<T>['filter'];
  renderValue?: (option: ComboboxOption<T>) => ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: SelectVariant;
  size?: 'md' | 's';
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  className?: string;
  contentClassName?: string;
  custom?: (query: string) => ComboboxOption<T> | null;
}

export function comboboxRows<T extends string>(
  options: readonly ComboboxOption<T>[],
  query: string,
  custom?: (query: string) => ComboboxOption<T> | null,
): readonly ComboboxOption<T>[] {
  const q = query.trim();
  if (!custom || q === '' || options.some((o) => o.label.toLowerCase() === q.toLowerCase())) return options;
  const extra = custom(q);
  return extra ? [...options, { ...extra, keywords: [...(extra.keywords ?? []), q] }] : options;
}

/** A Radix dialog's scroll lock swallows the wheel over a list portaled out of it unless the popover is modal too. */
export function Combobox<T extends string = string>({
  options,
  value,
  defaultValue = null,
  onValueChange,
  label,
  id,
  placeholder,
  searchPlaceholder,
  empty,
  filter,
  renderValue,
  open,
  defaultOpen = false,
  onOpenChange,
  variant = 'field',
  size = 'md',
  disabled,
  align = 'start',
  className,
  contentClassName,
  custom,
}: ComboboxProps<T>) {
  const [ownValue, setOwnValue] = useState<T | null>(defaultValue);
  const chosen = value === undefined ? ownValue : value;
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const isOpen = open ?? ownOpen;
  const [query, setQuery] = useState('');
  const setOpen = (next: boolean) => {
    if (open === undefined) setOwnOpen(next);
    setQuery('');
    onOpenChange?.(next);
  };
  const option =
    chosen === null
      ? undefined
      : (options.find((o) => o.value === chosen) ?? (custom ? { value: chosen, label: chosen } : undefined));
  const rows = comboboxRows(options, query, custom);
  const shown = option ? (renderValue ? renderValue(option) : (option.content ?? option.label)) : null;

  const privacy = usePrivate();
  return (
    <PopoverPrimitive.Root open={isOpen} onOpenChange={setOpen} modal>
      <PopoverPrimitive.Trigger
        id={id}
        className={cx('t-select', variant === 'quiet' && 'quiet', size === 's' && 's', className)}
        aria-label={option ? `${label}: ${option.label}` : label}
        disabled={disabled}
        data-placeholder={option ? undefined : ''}
        data-press="none"
      >
        <span>{shown ?? placeholder}</span>
        <Icon name="chevron-down" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...privacy}
          className={cx('t-popover', 't-combo', contentClassName)}
          sideOffset={4}
          align={align}
          collisionPadding={8}
          onEscapeKeyDown={escapeClearsQuery(query, () => setQuery(''))}
        >
          <SearchList
            options={rows}
            value={chosen}
            label={label}
            query={query}
            onQueryChange={setQuery}
            placeholder={searchPlaceholder}
            empty={empty}
            filter={filter}
            autoFocus
            onSelect={(v) => {
              if (value === undefined) setOwnValue(v);
              onValueChange?.(v);
              setOpen(false);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
