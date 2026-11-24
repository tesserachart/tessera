import type { Alert, AlertDelivery } from '@tessera/protocol';
import { patch, read, makeStore, useStore } from '../app/store.ts';
import { displaySymbol } from '../market/instruments.ts';
import { runtimeSettingsStore } from '../state/runtimeSettings.ts';
import { formFromAlert, formFromSeed, type AlertForm, type AlertSeed, type OperandChoice } from './form.ts';
import { markPrice } from './store.ts';

const DEFAULT_DELIVERY_KEY = 'alerts.defaultDelivery';

export interface FormOpen {
  form: AlertForm;
  at: { x: number; y: number } | null;
  price: number | null;
}

export const alertFormStore = makeStore<{ open: FormOpen | null }>({ open: null });

export function useAlertForm(): FormOpen | null {
  return useStore(alertFormStore, (s) => s.open);
}

function defaultDelivery(): AlertDelivery {
  const v = read(runtimeSettingsStore).values[DEFAULT_DELIVERY_KEY];
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const flag = (k: string, d: boolean) => {
    const on = o[k];
    return typeof on === 'boolean' ? on : d;
  };
  return { sound: flag('sound', true), desktop: flag('desktop', true), discord: flag('discord', false) };
}

/** A closing Radix menu hands the focus back to its trigger. */
export function openAlertForm(seed: AlertSeed, at: { x: number; y: number } | null = null): void {
  const open = { form: formFromSeed(seed, defaultDelivery()), at, price: seed.price };
  setTimeout(() => patch(alertFormStore, { open }), 0);
}

export function editAlert(
  a: Alert,
  opts: { decimals: number; tick: number; more?: readonly OperandChoice[] },
  at: { x: number; y: number } | null = null,
): void {
  const form = formFromAlert(a, { ...opts, symbol: displaySymbol(a.instrument) });
  const open = { form, at, price: markPrice(a) };
  setTimeout(() => patch(alertFormStore, { open }), 0);
}

export function setAlertForm(fn: (f: AlertForm) => AlertForm): void {
  const { open } = read(alertFormStore);
  if (open) patch(alertFormStore, { open: { ...open, form: fn(open.form) } });
}

export function closeAlertForm(): void {
  patch(alertFormStore, { open: null });
}
