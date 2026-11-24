import { matchesShortcut, parseShortcut, type KeyEventLike, type Platform } from '@tessera/ui';
import { scoreCommand, type Command, type FocusZone } from './registry.ts';

export type HeldModifier = 'meta' | 'ctrl' | 'alt';

const KEY_OF: Readonly<Record<string, HeldModifier>> = { Meta: 'meta', Control: 'ctrl', Alt: 'alt' };

export function heldModifierOf(key: string): HeldModifier | null {
  return KEY_OF[key] ?? null;
}

export function isLoneModifierPress(e: KeyEventLike): HeldModifier | null {
  const held = heldModifierOf(e.key);
  if (!held || e.shiftKey) return null;
  const others = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey };
  return Object.entries(others).some(([m, down]) => m !== held && down) ? null : held;
}

export function usesModifier(shortcut: string, held: HeldModifier, platform: Platform): boolean {
  const s = parseShortcut(shortcut);
  if (held === 'alt') return s.alt;
  if (held === 'meta') return s.meta || (s.mod && platform === 'mac');
  return s.ctrl || (s.mod && platform === 'other');
}

export interface ModifierRow {
  id: string;
  title: string;
  group: string;
  shortcut: string;
  zone: FocusZone;
  keywords: readonly string[];
  enabled: boolean;
  why: string | null;
}

export interface ModifierGroup {
  group: string;
  rows: ModifierRow[];
}

const GROUP_ORDER: readonly string[] = [
  'Chart',
  'DOM',
  'Time & sales',
  'Trade',
  'View',
  'Workspace',
  'General',
  'Analyst',
  'Alerts',
  'Help',
  'Settings',
  'Appearance',
];

const NEEDS: Partial<Record<FocusZone, string>> = {
  chart: 'Open a chart first',
  dom: 'Focus a DOM first',
  tape: 'Focus time & sales first',
  ticket: 'Open the order ticket first',
};

export interface RowContext {
  platform: Platform;
  zone: FocusZone;
  hasChart: boolean;
  isEnabled: (command: Command) => boolean;
}

function unavailableWhy(command: Command, hasChart: boolean): string {
  const own = command.unavailable?.();
  if (own) return own;
  const needsChart = command.zone === 'chart' || command.group === 'Chart';
  if (needsChart && !hasChart) return NEEDS.chart!;
  if (command.zone && command.zone !== 'chart') return NEEDS[command.zone] ?? 'Not available right now';
  return 'Not available right now';
}

function groupRank(group: string): number {
  const i = GROUP_ORDER.indexOf(group);
  return i < 0 ? GROUP_ORDER.length : i;
}

export function modifierRows(all: readonly Command[], held: HeldModifier, ctx: RowContext): ModifierRow[] {
  const byKey = new Map<string, { command: Command; row: ModifierRow }>();
  for (const command of all) {
    const shortcut = command.shortcut;
    if (!shortcut || !usesModifier(shortcut, held, ctx.platform)) continue;
    const enabled = ctx.isEnabled(command);
    const row: ModifierRow = {
      id: command.id,
      title: command.title,
      group: command.group,
      shortcut,
      zone: command.zone ?? 'global',
      keywords: command.keywords ?? [],
      enabled,
      why: enabled ? null : unavailableWhy(command, ctx.hasChart),
    };
    const key = `${command.title}\u0000${shortcut}`;
    const kept = byKey.get(key);
    if (!kept || prefer(command, row, kept, ctx.zone)) byKey.set(key, { command, row });
  }
  return [...byKey.values()].map((v) => v.row);
}

function prefer(
  command: Command,
  row: ModifierRow,
  kept: { command: Command; row: ModifierRow },
  zone: FocusZone,
): boolean {
  if (row.enabled !== kept.row.enabled) return row.enabled;
  return command.zone === zone && kept.command.zone !== zone;
}

export function groupRows(rows: readonly ModifierRow[], zone: FocusZone): ModifierGroup[] {
  const groups = new Map<string, ModifierRow[]>();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const focused = (list: readonly ModifierRow[]) => zone !== 'global' && list.some((r) => r.zone === zone);
  return [...groups]
    .map(([group, list]) => ({ group, rows: list }))
    .sort((a, b) => Number(focused(b.rows)) - Number(focused(a.rows)) || groupRank(a.group) - groupRank(b.group));
}

export interface TypedKey {
  key: string;
  code?: string;
  shiftKey: boolean;
}

function chainHits(row: ModifierRow, typed: TypedKey, held: HeldModifier, platform: Platform): boolean {
  const event: KeyEventLike = {
    key: typed.key,
    ...(typed.code ? { code: typed.code } : {}),
    shiftKey: typed.shiftKey,
    altKey: held === 'alt',
    metaKey: held === 'meta',
    ctrlKey: held === 'ctrl',
  };
  return matchesShortcut(event, row.shortcut, platform);
}

export interface ModifierSearch {
  query: string;
  first: TypedKey | null;
}

export function searchRows(
  rows: readonly ModifierRow[],
  search: ModifierSearch,
  held: HeldModifier,
  platform: Platform,
): ModifierRow[] {
  const q = search.query.trim().toLowerCase();
  if (!q) return [...rows];
  const typed = search.query.length === 1 ? search.first : null;
  const scored = rows.flatMap((row) => {
    const keyHit = typed !== null && chainHits(row, typed, held, platform);
    const score = (keyHit ? 1000 : 0) + scoreCommand(row, q);
    return score > 0 ? [{ row, score }] : [];
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.row);
}
