import type { JsonValue } from '@tessera/protocol';
import { useEffect } from 'react';
import { useInRuntime } from '../app/connection.ts';
import { readOco, type OcoConfig } from '../shell/oco.ts';
import { stableStringify } from '../workspace/layouts.ts';
import { layoutGuard, layoutKeys, layoutsStore } from './layouts.ts';
import { BASE_TICKET, readTicketSetup, type TicketSetup, ticketsStore, replaceTickets } from './tickets.ts';
import { tradeSettingsStore } from './tradeSettings.ts';
import { read, watch, patch } from '../app/store.ts';
import { runTool } from '../app/tools.ts';

export interface WorkspaceTrade {
  v: 2;
  tickets: Record<string, TicketSetup>;
  oco: Record<string, OcoConfig>;
}

const TRADE_SAVE_MS = 400;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function readWorkspaceTrade(v: unknown): WorkspaceTrade | null {
  if (!isObject(v)) return null;
  const oco: Record<string, OcoConfig> = {};
  if (isObject(v.oco)) for (const [k, x] of Object.entries(v.oco)) oco[k] = readOco(x);
  const tickets: Record<string, TicketSetup> = {};
  if (v.v === 2) {
    if (isObject(v.tickets)) for (const [k, x] of Object.entries(v.tickets)) tickets[k] = readTicketSetup(x);
  } else {
    tickets[BASE_TICKET] = readTicketSetup(v);
  }
  return { v: 2, tickets, oco };
}

export function currentTrade(): WorkspaceTrade {
  return { v: 2, tickets: read(ticketsStore).tickets, oco: read(tradeSettingsStore).lastOco };
}

export function applyTrade(t: WorkspaceTrade): void {
  replaceTickets(t.tickets);
  patch(tradeSettingsStore, { lastOco: t.oco });
}

export function useWorkspaceTradeSync(layoutId: string | null): void {
  const inRuntime = useInRuntime();
  useEffect(() => {
    if (!layoutId || !inRuntime) return;
    const key = layoutKeys.trade(layoutId);
    let started = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fromLayout = () => {
      const stored = readWorkspaceTrade(read(layoutsStore).layouts[layoutId]?.trade);
      if (!stored) {
        if (!started) applyTrade({ v: 2, tickets: {}, oco: read(tradeSettingsStore).lastOco });
        started = true;
        return;
      }
      const own = currentTrade();
      if (started && !layoutGuard.admit(key, stored, own)) return;
      if (!started) layoutGuard.agree(key, stored);
      started = true;
      if (stableStringify(stored) !== stableStringify(own)) applyTrade(stored);
    };
    const save = () => {
      timer = null;
      const trade = currentTrade();
      if (layoutGuard.agreed(key) === stableStringify(trade) || !read(layoutsStore).layouts[layoutId]) return;
      const done = layoutGuard.write(key, trade);
      void runTool('layout.save', { layoutId, trade: trade as unknown as JsonValue })
        .catch((err: unknown) => {
          console.warn(`[workspace] trade setup of ${layoutId} not saved`, err);
        })
        .finally(() => done());
    };
    const changed = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, TRADE_SAVE_MS);
    };
    fromLayout();
    const offLayouts = watch(layoutsStore, (s, prev) => {
      if (s.layouts[layoutId]?.trade !== prev.layouts[layoutId]?.trade) fromLayout();
    });
    const offTickets = watch(ticketsStore, (s, prev) => {
      if (s.tickets !== prev.tickets) changed();
    });
    const offOco = watch(tradeSettingsStore, (s, prev) => {
      if (s.lastOco !== prev.lastOco) changed();
    });
    return () => {
      if (timer) {
        clearTimeout(timer);
        save();
      }
      offLayouts();
      offTickets();
      offOco();
    };
  }, [layoutId, inRuntime]);
}
