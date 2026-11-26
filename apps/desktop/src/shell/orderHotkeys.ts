import {
  modifierLabel,
  parseShortcut,
  type KeyEventLike,
  type Modifier,
  type ParsedShortcut,
  type Platform,
} from '@tessera/ui';
import { defineSetting } from '../state/setting.ts';

export type OrderKeyAction = 'buyMarket' | 'buyBid' | 'sellMarket' | 'sellAsk' | 'reverse' | 'flatten' | 'cancelAll';

export interface OrderKeyDef {
  action: OrderKeyAction;
  label: string;
  help: string;
  key: string;
}

export const ORDER_KEYS: readonly OrderKeyDef[] = [
  { action: 'buyMarket', label: 'Buy market', help: 'The panel’s size and bracket', key: 'alt+w' },
  { action: 'buyBid', label: 'Buy bid', help: 'A limit at the bid', key: 'alt+q' },
  { action: 'sellMarket', label: 'Sell market', help: 'The panel’s size and bracket', key: 'alt+s' },
  { action: 'sellAsk', label: 'Sell ask', help: 'A limit at the ask', key: 'alt+a' },
  { action: 'reverse', label: 'Reverse', help: 'The position to the other side, same size', key: 'alt+z' },
  { action: 'flatten', label: 'Flatten', help: 'The position closed and its orders cancelled', key: 'alt+x' },
  {
    action: 'cancelAll',
    label: 'Cancel all',
    help: 'Every working order but the position’s stop and target',
    key: 'alt+c',
  },
];

export interface OrderHotkeys {
  enabled: boolean;
  keys: Readonly<Record<OrderKeyAction, string>>;
}

export const DEFAULT_ORDER_KEYS: Readonly<Record<OrderKeyAction, string>> = Object.fromEntries(
  ORDER_KEYS.map((d) => [d.action, d.key]),
) as Record<OrderKeyAction, string>;

export function orderHotkeysOf(v: unknown): OrderHotkeys {
  const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const stored = o.keys !== null && typeof o.keys === 'object' ? (o.keys as Record<string, unknown>) : {};
  const keys = { ...DEFAULT_ORDER_KEYS };
  for (const d of ORDER_KEYS) {
    const k = stored[d.action];
    if (typeof k === 'string' && validShortcut(k)) keys[d.action] = k;
  }
  return { enabled: o.enabled === true, keys };
}

export const ORDER_HOTKEYS = defineSetting('trade.orderHotkeys', orderHotkeysOf);

export function orderHotkeysValue(h: OrderHotkeys): { enabled: boolean; keys: Record<OrderKeyAction, string | null> } {
  const keys = {} as Record<OrderKeyAction, string | null>;
  for (const d of ORDER_KEYS)
    keys[d.action] = canonical(h.keys[d.action]) === canonical(d.key) ? null : h.keys[d.action];
  return { enabled: h.enabled, keys };
}

function validShortcut(s: string): boolean {
  try {
    parseShortcut(s);
    return true;
  } catch {
    return false;
  }
}

export function canonical(shortcut: string, platform: Platform = 'other'): string {
  let s: ParsedShortcut;
  try {
    s = parseShortcut(shortcut);
  } catch {
    return shortcut;
  }
  const ctrl = s.ctrl || (s.mod && platform === 'other');
  const meta = s.meta || (s.mod && platform === 'mac');
  return [ctrl && 'ctrl', s.alt && 'alt', s.shift && 'shift', meta && 'meta', s.key].filter(Boolean).join('+');
}

const FUNCTION_KEY = /^f([1-9]|1[0-2])$/;

const RESERVED = new Set(
  [
    'mod+w',
    'mod+q',
    'mod+t',
    'mod+n',
    'mod+r',
    'mod+l',
    'mod+h',
    'mod+m',
    'mod+c',
    'mod+v',
    'mod+x',
    'mod+z',
    'mod+a',
    'mod+f',
    'mod+p',
    'mod+s',
    'mod+tab',
    'mod+shift+t',
    'mod+shift+w',
    'mod+shift+n',
    'mod+shift+z',
    'alt+tab',
    'alt+f4',
    'alt+space',
    'ctrl+alt+delete',
    'f5',
    'f11',
    'f12',
  ].flatMap((k) => [canonical(k, 'mac'), canonical(k, 'other')]),
);

function modifierWords(platform: Platform): string {
  const mods: Modifier[] = platform === 'mac' ? ['alt', 'ctrl', 'meta'] : ['alt', 'ctrl'];
  const words = mods.map((m) => modifierLabel(m, platform));
  return `${words.slice(0, -1).join(', ')} or ${words.at(-1)!}`;
}

function keyProblem(shortcut: string, platform: Platform = 'other'): string | null {
  let s: ParsedShortcut;
  try {
    s = parseShortcut(shortcut);
  } catch {
    return 'Not a key';
  }
  if (RESERVED.has(canonical(shortcut, platform))) return 'Kept by the browser or the system';
  const modified = s.mod || s.ctrl || s.alt || s.meta;
  if (FUNCTION_KEY.test(s.key)) return null;
  if (!modified)
    return s.key.length === 1 ? `Add ${modifierWords(platform)}: a plain key types` : 'Kept for moving and closing';
  return null;
}

export interface TakenKey {
  shortcut: string;
  zone: string;
  title: string;
}

export function keyConflicts(
  keys: Readonly<Record<OrderKeyAction, string>>,
  taken: readonly TakenKey[],
  platform: Platform = 'other',
): Partial<Record<OrderKeyAction, string>> {
  const out: Partial<Record<OrderKeyAction, string>> = {};
  for (const d of ORDER_KEYS) {
    const key = keys[d.action];
    const problem = keyProblem(key, platform);
    if (problem) {
      out[d.action] = problem;
      continue;
    }
    const mine = canonical(key, platform);
    const twin = ORDER_KEYS.find((o) => o.action !== d.action && canonical(keys[o.action], platform) === mine);
    if (twin) {
      out[d.action] = `Also ${twin.label}’s key`;
      continue;
    }
    const other = taken.find(
      (t) => ['chart', 'dom', 'global'].includes(t.zone) && canonical(t.shortcut, platform) === mine,
    );
    if (other) out[d.action] = `Taken by ${other.title}`;
  }
  return out;
}

/** ⌥W types ∑ on a Mac, so the letter or digit is read from `code`, not `key`. */
export function shortcutOfEvent(e: KeyEventLike, platform: Platform): string | null {
  if (['Shift', 'Alt', 'Control', 'Meta', 'OS', 'AltGraph', 'CapsLock'].includes(e.key)) return null;
  const code = e.code ?? '';
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3).toLowerCase()
    : /^Digit[0-9]$/.test(code)
      ? code.slice(5)
      : e.key === ' '
        ? 'space'
        : e.key.toLowerCase();
  const mods: string[] = [];
  if (platform === 'mac') {
    if (e.metaKey) mods.push('mod');
    if (e.ctrlKey) mods.push('ctrl');
  } else {
    if (e.ctrlKey) mods.push('mod');
    if (e.metaKey) mods.push('meta');
  }
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  return [...mods, key].join('+');
}
