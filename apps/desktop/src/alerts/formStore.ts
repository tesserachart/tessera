import type { Alert, AlertDelivery } from '@tessera/protocol';
import { patch, read, makeStore, useStore } from '../app/store.ts';
import { displaySymbol } from '../market/instruments.ts';
import { readSetting } from '../state/runtimeSettings.ts';
import { defineSetting } from '../state/setting.ts';
import { formFromAlert, formFromSeed, type AlertForm, type AlertSeed, type OperandChoice } from './form.ts';
import { markPrice } from './store.ts';

export interface FormOpen {
  form: AlertForm;
  at: { x: number; y: number } | null;
  price: number | null;
  seq: number;
}

let opened = 0;

export const alertFormStore = makeStore<{ open: FormOpen | null }>({ open: null });

export function useAlertForm(): FormOpen | null {
  return useStore(alertFormStore, (s) => s.open);
}

const DELIVERY_DEFAULT: AlertDelivery = { sound: true, desktop: true, discord: false };

function deliveryOf(v: unknown): AlertDelivery {
  const o = typeof v === 'object' && v !== null ? (v as Partial<Record<keyof AlertDelivery, unknown>>) : {};
  const pick = (k: keyof AlertDelivery) => {
    const on = o[k];
    return typeof on === 'boolean' ? on : DELIVERY_DEFAULT[k];
  };
  return { sound: pick('sound'), desktop: pick('desktop'), discord: pick('discord') };
}

export const DEFAULT_DELIVERY = defineSetting('alerts.defaultDelivery', deliveryOf);

/** A closing Radix menu hands the focus back to its trigger. */
export function openAlertForm(seed: AlertSeed, at: { x: number; y: number } | null = null): void {
  const open = { form: formFromSeed(seed, readSetting(DEFAULT_DELIVERY)), at, price: seed.price, seq: ++opened };
  setTimeout(() => patch(alertFormStore, { open }), 0);
}

export function editAlert(
  a: Alert,
  opts: { decimals: number; tick: number; more?: readonly OperandChoice[] },
  at: { x: number; y: number } | null = null,
): void {
  const form = formFromAlert(a, { ...opts, symbol: displaySymbol(a.instrument) });
  const open = { form, at, price: markPrice(a), seq: ++opened };
  setTimeout(() => patch(alertFormStore, { open }), 0);
}

export function setAlertForm(fn: (f: AlertForm) => AlertForm): void {
  const { open } = read(alertFormStore);
  if (open) patch(alertFormStore, { open: { ...open, form: fn(open.form) } });
}

export function closeAlertForm(seq?: number): void {
  if (seq === undefined || read(alertFormStore).open?.seq === seq) patch(alertFormStore, { open: null });
}

export function formStillOpen(seq: number): boolean {
  return read(alertFormStore).open?.seq === seq;
}
