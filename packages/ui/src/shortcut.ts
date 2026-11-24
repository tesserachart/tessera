export type Platform = 'mac' | 'other';

export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  option: 'alt',
  opt: 'alt',
  cmd: 'meta',
  command: 'meta',
  control: 'ctrl',
};

export function detectPlatform(
  nav: { platform?: string; userAgent?: string } = typeof navigator === 'undefined' ? {} : navigator,
): Platform {
  const s = `${nav.platform ?? ''} ${nav.userAgent ?? ''}`;
  return /Mac|iPhone|iPad/i.test(s) ? 'mac' : 'other';
}

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut
    .toLowerCase()
    .split('+')
    .map((p) => p.trim());
  if (parts.length > 1 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, '+');
  const out: ParsedShortcut = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const raw of parts) {
    const p = ALIASES[raw] ?? raw;
    if (p === 'mod') out.mod = true;
    else if (p === 'ctrl') out.ctrl = true;
    else if (p === 'alt') out.alt = true;
    else if (p === 'shift') out.shift = true;
    else if (p === 'meta') out.meta = true;
    else out.key = p;
  }
  if (!out.key) throw new Error(`shortcut "${shortcut}" has no key`);
  return out;
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function eventKey(e: KeyEventLike, wanted: string): boolean {
  const k = e.key.toLowerCase();
  if (k === wanted) return true;
  // Alt/Option and Shift change `key` on many layouts (⌥1 → ¡, ⇧1 → !).
  if (e.code) {
    if (/^[a-z]$/.test(wanted) && e.code === `Key${wanted.toUpperCase()}`) return true;
    if (/^[0-9]$/.test(wanted) && (e.code === `Digit${wanted}` || e.code === `Numpad${wanted}`)) return true;
    if (wanted === '.' && e.code === 'Period') return true;
    if (wanted === '/' && e.code === 'Slash') return true;
    if (wanted === ',' && e.code === 'Comma') return true;
  }
  return false;
}

export function matchesShortcut(e: KeyEventLike, shortcut: string | ParsedShortcut, platform: Platform): boolean {
  const s = typeof shortcut === 'string' ? parseShortcut(shortcut) : shortcut;
  const wantCtrl = s.ctrl || (s.mod && platform === 'other');
  const wantMeta = s.meta || (s.mod && platform === 'mac');
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta || e.altKey !== s.alt) return false;
  const keyIsPrintableSymbol = s.key.length === 1 && !/[a-z0-9]/.test(s.key);
  if (!keyIsPrintableSymbol && e.shiftKey !== s.shift) return false;
  if (keyIsPrintableSymbol && s.shift && !e.shiftKey) return false;
  return eventKey(e, s.key);
}

const MAC_GLYPH: Record<string, string> = {
  mod: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  enter: '⏎',
  escape: 'Esc',
  backspace: '⌫',
  delete: '⌦',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  tab: '⇥',
  ' ': 'Space',
};

const OTHER_LABEL: Record<string, string> = {
  mod: 'Ctrl',
  meta: 'Super',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Del',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  tab: 'Tab',
  ' ': 'Space',
};

export function shortcutParts(shortcut: string, platform: Platform): string[] {
  const s = parseShortcut(shortcut);
  const table = platform === 'mac' ? MAC_GLYPH : OTHER_LABEL;
  const mods: string[] = [];
  const ctrl = s.ctrl || (s.mod && platform === 'other');
  const meta = s.meta || (s.mod && platform === 'mac');
  if (platform === 'mac') {
    if (ctrl) mods.push('⌃');
    if (s.alt) mods.push('⌥');
    if (s.shift) mods.push('⇧');
    if (meta) mods.push('⌘');
  } else {
    if (ctrl) mods.push('Ctrl');
    if (s.alt) mods.push('Alt');
    if (s.shift) mods.push('Shift');
    if (meta) mods.push('Super');
  }
  const key = table[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key[0]!.toUpperCase() + s.key.slice(1));
  return [...mods, key];
}

export type Modifier = 'mod' | 'ctrl' | 'alt' | 'shift' | 'meta';

export function modifierLabel(mod: Modifier, platform: Platform): string {
  return (platform === 'mac' ? MAC_GLYPH : OTHER_LABEL)[mod]!;
}

export function formatShortcut(shortcut: string, platform: Platform): string {
  return shortcutParts(shortcut, platform).join(platform === 'mac' ? '' : '+');
}
