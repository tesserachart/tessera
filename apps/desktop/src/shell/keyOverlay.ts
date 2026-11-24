import { SHOW_KEYS_MS, type Platform } from '@tessera/ui';
import { patch, read, makeStore } from '../app/store.ts';
import {
  groupRows,
  heldModifierOf,
  isLoneModifierPress,
  modifierRows,
  searchRows,
  type HeldModifier,
  type ModifierGroup,
  type ModifierRow,
  type TypedKey,
} from '../commands/modifierMap.ts';
import { commands, isTextInput, zoneOf, type CommandRegistry, type FocusZone } from '../commands/registry.ts';
import { activeChartTarget } from '../workspace/controller.ts';

export interface Anchor {
  left: number;
  top: number;
  width: number;
}

export interface KeyOverlayState {
  held: HeldModifier | null;
  pinned: boolean;
  platform: Platform;
  zone: FocusZone;
  anchor: Anchor | null;
  query: string;
  first: TypedKey | null;
  active: number;
}

const CLOSED: KeyOverlayState = {
  held: null,
  pinned: false,
  platform: 'other',
  zone: 'global',
  anchor: null,
  query: '',
  first: null,
  active: -1,
};

export const keyOverlayStore = makeStore<KeyOverlayState>(CLOSED);

export interface KeyOverlayView {
  groups: ModifierGroup[];
  rows: ModifierRow[];
  searching: boolean;
}

export function overlayView(s: KeyOverlayState, registry: CommandRegistry = commands): KeyOverlayView {
  if (!s.held) return { groups: [], rows: [], searching: false };
  const all = modifierRows(registry.all(), s.held, {
    platform: s.platform,
    zone: s.zone,
    hasChart: activeChartTarget() !== null,
    isEnabled: (c) => registry.isEnabled(c.id),
  });
  if (s.query) {
    const rows = searchRows(all, { query: s.query, first: s.first }, s.held, s.platform);
    return { groups: [], rows, searching: true };
  }
  const groups = groupRows(all, s.zone);
  return { groups, rows: groups.flatMap((g) => g.rows), searching: false };
}

function firstEnabled(rows: readonly ModifierRow[]): number {
  return rows.findIndex((r) => r.enabled);
}

export interface OpenAt {
  platform: Platform;
  zone: FocusZone;
  anchor: Anchor | null;
}

export function openKeyOverlay(held: HeldModifier, pinned: boolean, at: OpenAt, registry: CommandRegistry = commands) {
  const next: KeyOverlayState = { ...CLOSED, held, pinned, ...at };
  if (overlayView(next, registry).rows.length === 0) return false;
  keyOverlayStore.setState(next, true);
  return true;
}

export function closeKeyOverlay() {
  if (read(keyOverlayStore).held) keyOverlayStore.setState(CLOSED, true);
}

function pinKeyOverlay() {
  patch(keyOverlayStore, { pinned: true });
}

function typeIntoOverlay(query: string, typed: TypedKey | null, registry: CommandRegistry = commands) {
  const s = read(keyOverlayStore);
  const first = query.length === 0 ? null : s.query.length === 0 ? typed : s.first;
  const next = { ...s, query, first };
  const rows = overlayView(next, registry).rows;
  keyOverlayStore.setState({ ...next, active: query ? firstEnabled(rows) : -1 }, true);
}

function moveOverlay(step: 1 | -1, registry: CommandRegistry = commands) {
  const s = read(keyOverlayStore);
  const rows = overlayView(s, registry).rows;
  const n = rows.length;
  const from = s.active < 0 && step < 0 ? 0 : s.active;
  for (let i = 1; i <= n; i++) {
    const at = (((from + step * i) % n) + n) % n;
    if (rows[at]?.enabled) {
      patch(keyOverlayStore, { active: at });
      return;
    }
  }
}

export function hoverOverlay(index: number) {
  patch(keyOverlayStore, { active: index });
}

export function runOverlayRow(row: ModifierRow, registry: CommandRegistry = commands): boolean {
  if (!row.enabled) return false;
  closeKeyOverlay();
  return registry.run(row.id);
}

export function keyOverlayKey(e: KeyboardEvent, registry: CommandRegistry = commands): boolean {
  const s = read(keyOverlayStore);
  if (!s.held || !s.pinned) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === 'Shift' || heldModifierOf(e.key)) return false;
  if (e.key === 'Escape') {
    closeKeyOverlay();
  } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    moveOverlay(1, registry);
  } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    moveOverlay(-1, registry);
  } else if (e.key === 'Enter') {
    const row = overlayView(s, registry).rows[s.active];
    if (row) runOverlayRow(row, registry);
  } else if (e.key === 'Backspace') {
    typeIntoOverlay(s.query.slice(0, -1), null, registry);
  } else if (e.key.length === 1) {
    typeIntoOverlay(s.query + e.key, { key: e.key, code: e.code, shiftKey: e.shiftKey }, registry);
  }
  return true;
}

export interface GestureHost {
  canArm: (target: Element | null) => boolean;
  open: (held: HeldModifier, pinned: boolean) => boolean;
  inside: (target: Element | null) => boolean;
  holdMs?: number;
}

export interface Gesture {
  keydown: (e: KeyboardEvent) => void;
  keyup: (e: KeyboardEvent) => void;
  pointerdown: (e: PointerEvent) => void;
  blur: () => void;
  dispose: () => void;
}

const isModifierKey = (key: string) => key === 'Shift' || key === 'AltGraph' || heldModifierOf(key) !== null;

export function modifierGesture(host: GestureHost): Gesture {
  let armed: HeldModifier | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    armed = null;
  };
  const shown = () => read(keyOverlayStore);
  const peeking = () => shown().held !== null && !shown().pinned;
  const targetOf = (e: Event) => (e.target instanceof Element ? e.target : document.activeElement);
  return {
    keydown: (e) => {
      if (e.isComposing) return;
      const lone = isLoneModifierPress(e);
      if (lone) {
        if (e.repeat) return;
        disarm();
        if (!host.canArm(targetOf(e))) return;
        armed = lone;
        if (shown().held === null) {
          timer = setTimeout(() => {
            timer = null;
            if (armed === lone) host.open(lone, false);
          }, host.holdMs ?? SHOW_KEYS_MS);
        }
        return;
      }
      disarm();
      if (isModifierKey(e.key)) return;
      if (peeking()) closeKeyOverlay();
      else if (shown().held !== null && (e.ctrlKey || e.metaKey || e.altKey)) closeKeyOverlay();
    },
    keyup: (e) => {
      const held = heldModifierOf(e.key);
      if (!held) return;
      const tapped = armed === held;
      disarm();
      const s = shown();
      if (tapped) {
        e.preventDefault();
        if (s.held !== null && s.pinned) {
          if (s.held === held) closeKeyOverlay();
          else host.open(held, true);
        } else if (s.held === held) {
          pinKeyOverlay();
        } else {
          host.open(held, true);
        }
        return;
      }
      if (peeking() && s.held === held) closeKeyOverlay();
    },
    pointerdown: (e) => {
      disarm();
      if (shown().held === null) return;
      if (peeking() || !host.inside(targetOf(e))) closeKeyOverlay();
    },
    blur: () => {
      disarm();
      closeKeyOverlay();
    },
    dispose: () => {
      disarm();
    },
  };
}

export function canSummonFrom(target: Element | null, paletteOpen: boolean): boolean {
  if (paletteOpen || isTextInput(target)) return false;
  return !target?.closest('[aria-modal="true"]');
}

export function anchorOf(target: Element | null): { zone: FocusZone; el: Element | null } {
  const zoned = target?.closest('[data-focus-zone]') ?? null;
  return { zone: zoneOf(target), el: zoned };
}
