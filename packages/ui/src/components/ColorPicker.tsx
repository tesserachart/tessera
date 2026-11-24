import {
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  alphaOfHex,
  hexFromCss,
  hexFromHsva,
  hsvaFromHex,
  hueHex,
  isHexColor,
  normalizeHex,
  opaqueHex,
  withAlpha,
  type Hsva,
} from '../color.ts';
import { cx } from '../cx.ts';
import { TOKENS } from '../tokens.ts';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from './Floating.tsx';

export interface ColorSwatch {
  color: string;
  name: string;
  value?: string;
}

export interface ColorChange {
  opacity: number;
  gesture: string;
}

export const COLOR_PICKER_SWATCHES: readonly ColorSwatch[] = [
  { color: '#000000', name: 'Black' },
  { color: TOKENS.ink, name: 'Ink' },
  { color: TOKENS.panel, name: 'Panel' },
  { color: TOKENS.raise, name: 'Raise' },
  { color: TOKENS.t4, name: 'Faint grey' },
  { color: TOKENS.t3, name: 'Quiet grey' },
  { color: TOKENS.t2, name: 'Grey' },
  { color: TOKENS.mist, name: 'Mist' },
  { color: '#ffffff', name: 'White' },
  { color: TOKENS.up, name: 'Up' },
  { color: TOKENS.down, name: 'Down' },
  { color: TOKENS.aqua, name: 'Aqua' },
  { color: TOKENS.brass, name: 'Brass' },
  { color: TOKENS.teal, name: 'Teal' },
  { color: '#26a69a', name: 'Classic green' },
  { color: '#ef5350', name: 'Classic red' },
  { color: '#5b8def', name: 'Blue' },
  { color: '#a98bf0', name: 'Violet' },
];

const RECENT_MAX = 9;
const RECENT_KEY = 'tessera.recentColors';
const ECHOES_KEPT = 64;
const WHITE: Hsva = { h: 0, s: 0, v: 1, a: 1 };

const recent = {
  list: readRecent(),
  listeners: new Set<() => void>(),
  push(color: string) {
    const c = color.toLowerCase();
    if (this.list[0] === c) return;
    this.list = [c, ...this.list.filter((x) => x !== c)].slice(0, RECENT_MAX);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.list));
    } catch {}
    for (const l of this.listeners) l();
  },
};

function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && isHexColor(x)).slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function useRecentColors(): readonly string[] {
  return useSyncExternalStore(
    (l) => {
      recent.listeners.add(l);
      return () => recent.listeners.delete(l);
    },
    () => recent.list,
  );
}

let gestures = 0;
const newGesture = () => `color-${String(++gestures)}`;

export interface ColorPickerProps {
  value: string | null;
  opacity?: number;
  onChange: (color: string, change: ColorChange) => void;
  label: string;
  hint?: string;
  valueName?: string;
  swatches?: readonly ColorSwatch[];
  alpha?: boolean;
  onReset?: () => void;
  resetLabel?: string;
  error?: string | null;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  popoverClassName?: string;
  triggerClassName?: string;
}

export function ColorPicker({
  value,
  opacity,
  onChange,
  label,
  hint,
  valueName,
  swatches = COLOR_PICKER_SWATCHES,
  alpha = false,
  onReset,
  resetLabel = 'Back to the default',
  error = null,
  disabled = false,
  align = 'end',
  popoverClassName,
  triggerClassName,
}: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const translucent = alpha || opacity !== undefined;
  const chosen = value === null ? undefined : swatches.find((s) => s.value !== undefined && s.value === value);
  const base = chosen ? hexFromCss(chosen.color) : value === null ? null : normalizeHex(value);
  const withOpacity = base !== null && opacity !== undefined ? withAlpha(base, opacity) : base;
  const shown = withOpacity !== null && !translucent ? opaqueHex(withOpacity) : withOpacity;
  const name = valueName ?? chosen?.name ?? (shown ? opaqueHex(shown) : 'none');
  const dim = shown !== null && alphaOfHex(shown) < 1 ? `, ${percent(alphaOfHex(shown))}` : '';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={hint ?? label}>
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            className={cx('t-color', triggerClassName)}
            aria-label={`${label}: ${name}${dim}`}
            data-empty={shown ? undefined : ''}
          >
            <span className="t-color-chip" style={shown ? colorVar(shown) : undefined} />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        className={cx('t-color-pop', popoverClassName)}
        align={align}
        side="bottom"
        aria-label={label}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <ColorPanel
          label={label}
          shown={shown}
          chosen={chosen}
          swatches={swatches}
          translucent={translucent}
          opacityApart={opacity !== undefined}
          onChange={onChange}
        />
        {error ? (
          <p className="t-color-err" role="alert">
            {error}
          </p>
        ) : null}
        {onReset ? (
          <button
            type="button"
            className="t-color-reset"
            onClick={() => {
              onReset();
              setOpen(false);
            }}
          >
            {resetLabel}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

interface Held {
  hsva: Hsva;
  gesture: string;
  dragging: boolean;
  echoes: readonly string[];
}

type Phase = 'live' | 'done';

function ColorPanel({
  label,
  shown,
  chosen,
  swatches,
  translucent,
  opacityApart,
  onChange,
}: {
  label: string;
  shown: string | null;
  chosen: ColorSwatch | undefined;
  swatches: readonly ColorSwatch[];
  translucent: boolean;
  opacityApart: boolean;
  onChange: (color: string, change: ColorChange) => void;
}) {
  const [held, setHeld] = useState<Held | null>(null);
  const [text, setText] = useState<string | null>(null);
  const gesture = useRef<string | null>(null);
  const lastSent = useRef<string | null>(null);
  const recentColors = useRecentColors();
  const echoed = held !== null && (held.dragging || (shown !== null && held.echoes.includes(shown)));
  const hsva = echoed ? held.hsva : ((shown ? hsvaFromHex(shown, held?.hsva.h ?? 0) : null) ?? WHITE);
  const current = hexFromHsva(hsva);
  const own = echoed ? undefined : chosen;

  const emit = (next: Hsva, phase: Phase, from?: ColorSwatch) => {
    const g = gesture.current ?? newGesture();
    if (phase === 'done') gesture.current = null;
    const pick = { ...next, a: translucent ? Math.round(next.a * 100) / 100 : 1 };
    const key = hexFromHsva(pick);
    lastSent.current = key;
    setHeld((h) => ({
      hsva: pick,
      gesture: g,
      dragging: phase === 'live',
      echoes: h?.gesture === g ? [...h.echoes.slice(1 - ECHOES_KEPT), key] : [key],
    }));
    const same = chosen && opaqueHex(hexFromCss(chosen.color) ?? '') === opaqueHex(key) ? chosen : undefined;
    const swatch = from ?? same;
    const swatchValue = swatch && (opacityApart || pick.a === 1) ? (swatch.value ?? hexFromCss(swatch.color)) : null;
    onChange(swatchValue ?? (opacityApart ? opaqueHex(key) : key), { opacity: pick.a, gesture: g });
    if (phase === 'done') recent.push(key);
  };
  const begin = () => {
    gesture.current = newGesture();
  };
  const settle = () => {
    gesture.current = null;
    setHeld((h) => (h ? { ...h, dragging: false } : h));
    if (lastSent.current) recent.push(lastSent.current);
  };
  const pickHex = (hex: string, from?: ColorSwatch) => {
    const n = hexFromCss(hex);
    const at = n ? hsvaFromHex(n, hsva.h) : null;
    if (!n || !at) return;
    const keepsOpacity = from !== undefined || n.length !== 9;
    begin();
    emit({ ...at, a: keepsOpacity ? hsva.a : at.a }, 'done', from);
  };
  const commitText = () => {
    if (text === null) return;
    const n = normalizeHex(text);
    if (n) {
      setText(null);
      if (n !== current && n !== opaqueHex(current)) pickHex(n);
    }
  };
  const onHexKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitText();
    } else if (e.key === 'Escape' && text !== null) {
      e.preventDefault();
      e.stopPropagation();
      setText(null);
    }
  };
  const swatchOn = (s: ColorSwatch) => (own ? s === own : opaqueHex(hexFromCss(s.color) ?? '') === opaqueHex(current));
  const opaque = opaqueHex(current);

  return (
    <>
      <DragSurface
        className="t-color-plane"
        style={{ '--hue': hueHex(hsva.h) } as CSSProperties}
        label="Saturation and brightness"
        valueNow={Math.round(hsva.s * 100)}
        valueMax={100}
        valueText={`Saturation ${percent(hsva.s)}, brightness ${percent(hsva.v)}`}
        onBegin={begin}
        onDrag={(x, y) => emit({ ...hsva, s: x, v: 1 - y }, 'live')}
        onStep={(k, big) => {
          const d = big ? 0.1 : 0.01;
          if (k === 'ArrowLeft' || k === 'ArrowRight')
            return { ...hsva, s: clamp01(hsva.s + (k === 'ArrowLeft' ? -d : d)) };
          if (k === 'ArrowUp' || k === 'ArrowDown')
            return { ...hsva, v: clamp01(hsva.v + (k === 'ArrowDown' ? -d : d)) };
          return null;
        }}
        onLive={(next) => emit(next, 'live')}
        onSettle={settle}
      >
        <span
          className="t-color-thumb"
          style={{ left: percent(hsva.s), top: percent(1 - hsva.v), ...colorVar(opaque) }}
        />
      </DragSurface>
      <DragSurface
        className="t-color-strip t-color-hue"
        label="Hue"
        valueNow={Math.round(hsva.h)}
        valueMax={360}
        valueText={`${String(Math.round(hsva.h))}°`}
        onBegin={begin}
        onDrag={(x) => emit({ ...hsva, h: x * 360 }, 'live')}
        onStep={(k, big) => stepped(k, hsva.h, big ? 10 : 1, 360, (h) => ({ ...hsva, h }))}
        onLive={(next) => emit(next, 'live')}
        onSettle={settle}
      >
        <span className="t-color-knob" style={{ left: percent(hsva.h / 360), ...colorVar(hueHex(hsva.h)) }} />
      </DragSurface>
      {translucent ? (
        <DragSurface
          className="t-color-strip t-color-opacity"
          style={colorVar(opaque)}
          label="Opacity"
          valueNow={Math.round(hsva.a * 100)}
          valueMax={100}
          valueText={percent(hsva.a)}
          onBegin={begin}
          onDrag={(x) => emit({ ...hsva, a: x }, 'live')}
          onStep={(k, big) => stepped(k, hsva.a, big ? 0.1 : 0.01, 1, (a) => ({ ...hsva, a }))}
          onLive={(next) => emit(next, 'live')}
          onSettle={settle}
        >
          <span className="t-color-knob" style={{ left: percent(hsva.a), ...colorVar(current) }} />
        </DragSurface>
      ) : null}
      <div className="t-color-grid" role="radiogroup" aria-label="Swatches">
        {swatches.map((s) => (
          <SwatchButton key={s.color + s.name} swatch={s} on={swatchOn(s)} onPick={() => pickHex(s.color, s)} />
        ))}
      </div>
      {recentColors.length > 0 ? (
        <div className="t-color-recent">
          <span className="t-color-cap">Recent</span>
          <div className="t-color-grid" role="radiogroup" aria-label="Recent colours">
            {recentColors.map((c) => (
              <SwatchButton
                key={c}
                swatch={{ color: c, name: c }}
                on={c === (translucent ? current : opaque)}
                onPick={() => pickHex(translucent ? c : opaqueHex(c))}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div className="t-color-fields">
        <div
          className={cx('t-input', 's', 't-color-hex', text !== null && normalizeHex(text) === null && 'is-invalid')}
        >
          <span className="t-color-dot" style={colorVar(current)} aria-hidden="true" />
          <input
            aria-label={`${label}, hex`}
            spellCheck={false}
            autoComplete="off"
            value={text ?? opaque}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onHexKey}
            onBlur={commitText}
          />
        </div>
        {translucent ? <span className="t-color-pct">{percent(hsva.a)}</span> : null}
      </div>
    </>
  );
}

function stepped(key: string, now: number, step: number, max: number, at: (x: number) => Hsva): Hsva | null {
  if (key === 'Home') return at(0);
  if (key === 'End') return at(max);
  if (key === 'ArrowLeft' || key === 'ArrowDown') return at(Math.max(0, now - step));
  if (key === 'ArrowRight' || key === 'ArrowUp') return at(Math.min(max, now + step));
  return null;
}

function DragSurface({
  className,
  style,
  label,
  valueNow,
  valueMax,
  valueText,
  onBegin,
  onDrag,
  onStep,
  onLive,
  onSettle,
  children,
}: {
  className: string;
  style?: CSSProperties;
  label: string;
  valueNow: number;
  valueMax: number;
  valueText: string;
  onBegin: () => void;
  onDrag: (x: number, y: number) => void;
  onStep: (key: string, big: boolean) => Hsva | null;
  onLive: (next: Hsva) => void;
  onSettle: () => void;
  children: ReactNode;
}) {
  const engaged = useRef(false);
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onDrag(clamp01((e.clientX - r.left) / (r.width || 1)), clamp01((e.clientY - r.top) / (r.height || 1)));
  };
  const release = () => {
    if (!engaged.current) return;
    engaged.current = false;
    onSettle();
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      className={className}
      style={style}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      aria-valuetext={valueText}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}
        engaged.current = true;
        onBegin();
        at(e);
      }}
      onPointerMove={(e) => {
        if (engaged.current) at(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e) => {
        const next = onStep(e.key, e.shiftKey);
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        if (!engaged.current) {
          engaged.current = true;
          onBegin();
        }
        onLive(next);
      }}
      onKeyUp={release}
      onBlur={release}
    >
      {children}
    </div>
  );
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function percent(x: number): string {
  return `${String(Math.round(x * 100))}%`;
}

function colorVar(color: string): CSSProperties {
  return { '--c': color } as CSSProperties;
}

function SwatchButton({ swatch, on, onPick }: { swatch: ColorSwatch; on: boolean; onPick: () => void }) {
  return (
    <Tooltip content={swatch.name}>
      <button
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={swatch.name}
        className={cx('t-color-swatch', on && 'is-on')}
        onClick={onPick}
      >
        <span style={colorVar(swatch.color)} />
      </button>
    </Tooltip>
  );
}
