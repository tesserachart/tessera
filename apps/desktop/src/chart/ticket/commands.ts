import { detectPlatform, usePlatform, type Platform } from '@tessera/ui';
import { useMemo } from 'react';
import { commands, type Command, type CommandRegistry } from '../../commands/registry.ts';
import { focusedTileKeys } from '../../orderflow/tileKeys.ts';
import { BREAKEVEN_KEY } from '../../shell/keys.ts';
import {
  ORDER_HOTKEYS_KEY,
  ORDER_KEYS,
  keyConflicts,
  orderHotkeysOf,
  type OrderHotkeys,
  type OrderKeyAction,
  type TakenKey,
} from '../../shell/orderHotkeys.ts';
import { runtimeSettingsStore } from '../../state/runtimeSettings.ts';
import { activeChartTarget } from '../../workspace/controller.ts';
import { read, watch, useStore } from '../../app/store.ts';

export interface TicketKeys {
  breakeven(): void;
  canBreakeven(): boolean;
  order?(action: OrderKeyAction): void;
}

let bound: TicketKeys | null = null;

export function bindTicketKeys(keys: TicketKeys): () => void {
  bound = keys;
  return () => {
    if (bound === keys) bound = null;
  };
}

function ticketKeys(): TicketKeys | null {
  return bound;
}

const charts = new Map<string, TicketKeys>();

export function bindChartKeys(tileId: string, keys: TicketKeys): () => void {
  charts.set(tileId, keys);
  return () => {
    if (charts.get(tileId) === keys) charts.delete(tileId);
  };
}

function chartKeys(): TicketKeys | null {
  const target = activeChartTarget();
  return target ? (charts.get(target.tileId) ?? null) : null;
}

export function ticketCommands(): Command[] {
  const can = () => ticketKeys()?.canBreakeven() ?? false;
  const run = () => ticketKeys()?.breakeven();
  const canChart = () => chartKeys()?.canBreakeven() ?? false;
  const runChart = () => chartKeys()?.breakeven();
  return [
    {
      id: 'trade.breakeven',
      title: 'Breakeven: the position’s stop to its entry',
      group: 'Trade',
      keywords: ['breakeven', 'stop', 'exit', 'protect'],
      shortcut: BREAKEVEN_KEY,
      zone: 'ticket',
      hidden: true,
      when: can,
      run,
    },
    {
      id: 'chart.breakeven',
      title: 'Breakeven: the position’s stop to its entry',
      group: 'Trade',
      keywords: ['breakeven', 'stop', 'exit', 'protect'],
      shortcut: BREAKEVEN_KEY,
      zone: 'chart',
      hidden: true,
      when: canChart,
      run: runChart,
    },
  ];
}

function isOrderKey(id: string): boolean {
  return id.startsWith('chart.order.') || id.startsWith('dom.order.');
}

export function takenKeys(all: readonly Command[]): TakenKey[] {
  return all
    .filter((c) => c.shortcut && !isOrderKey(c.id))
    .map((c) => ({ shortcut: c.shortcut!, zone: c.zone ?? 'global', title: c.title }));
}

export function liveOrderKeys(
  h: OrderHotkeys,
  taken: readonly TakenKey[],
  platform: Platform = detectPlatform(),
): Partial<Record<OrderKeyAction, string>> {
  if (!h.enabled) return {};
  const problems = keyConflicts(h.keys, taken, platform);
  const out: Partial<Record<OrderKeyAction, string>> = {};
  for (const d of ORDER_KEYS) if (!problems[d.action]) out[d.action] = h.keys[d.action];
  return out;
}

export function orderKeyCommands(
  h: OrderHotkeys,
  taken: readonly TakenKey[],
  platform: Platform = detectPlatform(),
): Command[] {
  const problems = keyConflicts(h.keys, taken, platform);
  return ORDER_KEYS.flatMap((d): Command[] => {
    const shortcut = problems[d.action] ? undefined : h.keys[d.action];
    const common = {
      title: `${d.label}: ${d.help.charAt(0).toLowerCase()}${d.help.slice(1)}`,
      group: 'Trade',
      keywords: ['order key', 'hotkey', d.label.toLowerCase()],
      hidden: true,
      once: true,
      unavailable: () => (h.enabled ? null : 'Order hotkeys are off'),
      ...(shortcut ? { shortcut } : {}),
    };
    return [
      {
        ...common,
        id: `chart.order.${d.action}`,
        zone: 'chart',
        when: () => h.enabled && chartKeys()?.order !== undefined,
        run: () => chartKeys()?.order?.(d.action),
      },
      {
        ...common,
        id: `dom.order.${d.action}`,
        zone: 'dom',
        when: () => h.enabled && (focusedTileKeys('dom')?.sends() ?? false),
        run: () => focusedTileKeys('dom')?.order(d.action),
      },
    ];
  });
}

function orderHotkeysNow(): OrderHotkeys {
  return orderHotkeysOf(read(runtimeSettingsStore).values[ORDER_HOTKEYS_KEY]);
}

export function registerOrderKeys(registry: CommandRegistry): () => void {
  let off: () => void = () => undefined;
  let last: string | null = null;
  const apply = () => {
    const h = orderHotkeysNow();
    const said = JSON.stringify(h);
    if (said === last) return;
    last = said;
    off();
    off = registry.registerAll(orderKeyCommands(h, takenKeys(registry.all())));
  };
  apply();
  const unsubscribe = watch(runtimeSettingsStore, apply);
  return () => {
    unsubscribe();
    off();
  };
}

export function useOrderHotkeys(): OrderHotkeys {
  const v = useStore(runtimeSettingsStore, (s) => s.values[ORDER_HOTKEYS_KEY]);
  return useMemo(() => orderHotkeysOf(v), [v]);
}

export function useOrderKeys(): Partial<Record<OrderKeyAction, string>> {
  const h = useOrderHotkeys();
  const platform = usePlatform();
  return useMemo(() => liveOrderKeys(h, takenKeys(commands.all()), platform), [h, platform]);
}
