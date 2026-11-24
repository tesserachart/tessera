import type { Command } from '../commands/registry.ts';
import { RECENT_COMMANDS } from '../state/ui.ts';

export type Reading = { kind: 'rows' } | { kind: 'price'; price: number } | { kind: 'ask'; text: string };

function bareNumber(query: string): { value: number; intDigits: number } | null {
  const q = query.trim().replace(/,/g, '');
  const m = /^(\d{1,7})(\.\d+)?$/.exec(q);
  if (!m) return null;
  return { value: Number(q), intDigits: m[1]!.length };
}

export function completePrice(typed: number, intDigits: number, last: number | null): number {
  if (last === null || !(last > 0) || typed >= last / 10) return typed;
  const step = 10 ** intDigits;
  const base = Math.floor(last / step) * step + typed;
  return [base - step, base, base + step].reduce((a, b) => (Math.abs(b - last) < Math.abs(a - last) ? b : a));
}

export function readingsOf(query: string, last: number | null, hasRows = false): Reading[] {
  const q = query.trim();
  if (q.startsWith('?')) return [{ kind: 'ask', text: q.slice(1).trim() }];
  const n = bareNumber(q);
  if (n) {
    const price = completePrice(n.value, n.intDigits, last);
    return [
      { kind: 'price', price },
      { kind: 'ask', text: `what about ${q}?` },
    ];
  }
  if (q.split(/\s+/).filter(Boolean).length >= 3) {
    return hasRows ? [{ kind: 'rows' }, { kind: 'ask', text: q }] : [{ kind: 'ask', text: q }, { kind: 'rows' }];
  }
  return [{ kind: 'rows' }];
}

export function symbolValue(instrument: string): string {
  return `symbol:${instrument.toLowerCase()}`;
}

export type PaletteEnter = { kind: 'symbol'; instrument: string } | { kind: 'command' } | { kind: 'none' };

export function paletteEnter(hits: readonly { instrument: string }[], active: string): PaletteEnter {
  const hit = hits.find((s) => symbolValue(s.instrument) === active);
  if (hit) return { kind: 'symbol', instrument: hit.instrument };
  if (active && !active.startsWith('symbol:')) return { kind: 'command' };
  return { kind: 'none' };
}

const VERBS = new Set(['open', 'show', 'reset', 'switch', 'focus', 'ask', 'change']);

export function commandVerb(title: string): string {
  const first = title.split(/[\s:]/)[0]!.toLowerCase();
  if (VERBS.has(first)) return first;
  if (/^timeframe /i.test(title)) return title.slice('Timeframe '.length);
  return 'run';
}

const BROWSE_GROUPS = ['View', 'Chart', 'Trade', 'Alerts', 'Settings'] as const;

type BrowseGroup = (typeof BROWSE_GROUPS)[number];

const BROWSE_OF: Readonly<Record<string, BrowseGroup>> = {
  View: 'View',
  Workspace: 'View',
  General: 'View',
  Analyst: 'View',
  Chart: 'Chart',
  DOM: 'Chart',
  'Time & sales': 'Chart',
  Trade: 'Trade',
  Alerts: 'Alerts',
  Settings: 'Settings',
  Appearance: 'Settings',
};

export interface Browse {
  recent: Command[];
  groups: { group: BrowseGroup; commands: Command[] }[];
}

export function browseCommands(shown: readonly Command[], recent: readonly string[]): Browse {
  const byId = new Map(shown.map((c) => [c.id, c]));
  return {
    recent: recent.flatMap((id) => byId.get(id) ?? []).slice(0, RECENT_COMMANDS),
    groups: BROWSE_GROUPS.map((group) => ({
      group,
      commands: shown.filter((c) => (BROWSE_OF[c.group] ?? 'View') === group),
    })).filter((g) => g.commands.length > 0),
  };
}

export const RECENT_PREFIX = 'recent:';
