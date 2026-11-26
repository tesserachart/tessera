import type { ComboboxOption } from '@tessera/ui';
import { readSetting, useSetting, watchSetting } from './runtimeSettings.ts';
import { defineSetting } from './setting.ts';

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const TIME_ZONE = defineSetting('display.timeZone', (v) => (isTimeZone(v) ? v : systemTimeZone()));

export function displayZone(): string {
  return readSetting(TIME_ZONE);
}

export function useDisplayZone(): string {
  return useSetting(TIME_ZONE);
}

export function onDisplayZone(listener: (zone: string) => void): () => void {
  return watchSetting(TIME_ZONE, listener);
}

const TIME_ZONES: readonly string[] = [
  'UTC',
  ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC' && z.includes('/')),
];

export function zoneLabel(zone: string): string {
  return zone.replace(/_/g, ' ');
}

export function zoneCity(zone: string): string {
  return zone.slice(zone.lastIndexOf('/') + 1).replace(/_/g, ' ');
}

export const TIME_ZONE_OPTIONS: readonly ComboboxOption[] = TIME_ZONES.map((z) => ({
  value: z,
  label: zoneLabel(z),
  group: z.includes('/') ? z.slice(0, z.indexOf('/')) : 'UTC',
  keywords: [zoneCity(z)],
}));

export function zonedFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): (zone?: string) => Intl.DateTimeFormat {
  const made = new Map<string, Intl.DateTimeFormat>();
  return (zone = displayZone()) => {
    let f = made.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
      made.set(zone, f);
    }
    return f;
  };
}

const ZONE_NAMES = {
  short: zonedFormat('en-US', { timeZoneName: 'short' }),
  shortGeneric: zonedFormat('en-US', { timeZoneName: 'shortGeneric' }),
};

export function zoneAbbreviation(
  zone: string,
  at: number = Date.now(),
  style: keyof typeof ZONE_NAMES = 'short',
): string {
  const part = ZONE_NAMES[style](zone)
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? zoneLabel(zone);
}

const WALL_CLOCK = zonedFormat('en-US', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

export function zoneOffsetMs(zone: string, at: number): number {
  const parts = WALL_CLOCK(zone).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

const ISO_DATE = zonedFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });

export function dateIn(ms: number, zone: string = displayZone()): string {
  return ISO_DATE(zone).format(ms);
}
