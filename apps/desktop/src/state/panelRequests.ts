import type { JsonValue } from '@tessera/protocol';
import { patch, read, makeStore, useStore } from '../app/store.ts';
import { OCO_UNITS, readOco, type OcoConfig, type OcoUnit } from '../shell/oco.ts';
import { readExecuteAs } from '../market/families.ts';
import { MAX_STOP_LIMIT_TICKS, type TicketSetup } from './tickets.ts';

type JsonObject = { [k: string]: JsonValue };

const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

interface PanelRequests {
  pending: Readonly<Record<string, JsonObject>>;
}

export const panelRequestsStore = makeStore<PanelRequests>({ pending: {} });

const keyOf = (layoutId: string, tileId: string) => `${layoutId}/${tileId}`;

export function requestPanel(layoutId: string, tileId: string, change: JsonObject): void {
  const key = keyOf(layoutId, tileId);
  const was = read(panelRequestsStore).pending[key] ?? {};
  const next: JsonObject = { ...was, ...change };
  if (isObject(was.oco) && isObject(change.oco)) next.oco = mergeOcoPatch(was.oco, change.oco);
  patch(panelRequestsStore, (s) => ({ pending: { ...s.pending, [key]: next } }));
}

export function usePanelRequest(layoutId: string, tileId: string): JsonObject | null {
  return useStore(panelRequestsStore, (s) => s.pending[keyOf(layoutId, tileId)] ?? null);
}

export function settlePanelRequest(layoutId: string, tileId: string, rest: JsonObject | null): void {
  const key = keyOf(layoutId, tileId);
  patch(panelRequestsStore, (s) => {
    const others = Object.fromEntries(Object.entries(s.pending).filter(([k]) => k !== key));
    return { pending: rest && Object.keys(rest).length > 0 ? { ...others, [key]: rest } : others };
  });
}

export interface PanelChange {
  accountId: string | null;
  ticket: Partial<TicketSetup>;
  oco: JsonObject | null;
}

export function panelChange(patch: JsonObject): PanelChange {
  const ticket: Partial<TicketSetup> = {};
  const n = (v: JsonValue | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const qty = n(patch.qty);
  if (qty !== null && qty >= 1) ticket.qty = Math.floor(qty);
  if (patch.sizing === 'qty' || patch.sizing === 'risk') ticket.sizing = patch.sizing;
  const risk = n(patch.risk);
  if (risk !== null && risk > 0) ticket.risk = risk;
  const ticks = n(patch.stopLimitTicks);
  if (ticks !== null && ticks >= 0) ticket.stopLimitTicks = Math.min(MAX_STOP_LIMIT_TICKS, Math.round(ticks));
  if (typeof patch.execute === 'string') ticket.execute = readExecuteAs(patch.execute);
  if (patch.bracket === 'open' || patch.bracket === 'closed') ticket.bracket = patch.bracket;
  if (patch.rules === 'open' || patch.rules === 'closed') ticket.rules = patch.rules;
  return {
    accountId: typeof patch.accountId === 'string' && patch.accountId !== '' ? patch.accountId : null,
    ticket,
    oco: isObject(patch.oco) ? patch.oco : null,
  };
}

export interface PanelAt {
  accountId: string | null;
  root: string | null;
  oco: OcoConfig;
  accounts: readonly string[];
}

export type PanelStep =
  { pick: string } | { ticket: Partial<TicketSetup>; oco: OcoConfig | null; rest: JsonObject | null } | null;

export function nextPanelStep(asked: JsonObject, at: PanelAt): PanelStep {
  const change = panelChange(asked);
  if (change.accountId && change.accountId !== at.accountId)
    return at.accounts.includes(change.accountId) ? { pick: change.accountId } : null;
  if (change.oco && !(at.accountId && at.root)) return { ticket: change.ticket, oco: null, rest: { oco: change.oco } };
  return { ticket: change.ticket, oco: change.oco ? withOcoChange(at.oco, change.oco) : null, rest: null };
}

function mergeOcoPatch(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObject(v) && isObject(a[k]) ? { ...a[k], ...v } : v;
  return out;
}

export function withOcoChange(oco: OcoConfig, change: JsonObject): OcoConfig {
  const leg = (was: OcoConfig['stop'], c: JsonValue | undefined) => {
    if (!isObject(c)) return was;
    return {
      on: typeof c.on === 'boolean' ? c.on : was.on,
      unit: OCO_UNITS.includes(c.unit as OcoUnit) ? (c.unit as OcoUnit) : was.unit,
      value: typeof c.value === 'number' && c.value > 0 ? c.value : was.value,
    };
  };
  const be = isObject(change.breakeven) ? change.breakeven : {};
  const tr = isObject(change.trail) ? change.trail : {};
  return readOco({
    on: typeof change.on === 'boolean' ? change.on : oco.on,
    stop: leg(oco.stop, change.stop),
    target: leg(oco.target, change.target),
    breakeven: {
      on: typeof be.on === 'boolean' ? be.on : oco.breakeven.on,
      trigger: typeof be.trigger === 'number' ? be.trigger : oco.breakeven.trigger,
      offset: typeof be.offset === 'number' ? be.offset : oco.breakeven.offset,
    },
    trail: {
      on: typeof tr.on === 'boolean' ? tr.on : oco.trail.on,
      ticks: typeof tr.ticks === 'number' ? tr.ticks : oco.trail.ticks,
      trigger: typeof tr.trigger === 'number' ? tr.trigger : oco.trail.trigger,
      step: typeof tr.step === 'number' ? tr.step : oco.trail.step,
    },
  });
}
