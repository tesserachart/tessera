import type { ContractSpec, SessionCalendar } from '@tessera/protocol';
import type { SessionOptions } from '@tessera/chart';
import { useHasTool, useToolValue } from '../app/tools.ts';
import { displayZone } from '../state/timeZone.ts';

export { DEFAULT_WATCHLIST } from './defaults.ts';
export * from './intervals.ts';

const REPLAY_ID = /^(.+)-R\d+(\.[^.]+)?$/;

export function replayedContract(instrument: string): string | null {
  const m = REPLAY_ID.exec(instrument);
  return m ? `${m[1]!}${m[2] ?? ''}` : null;
}

export function isReplay(instrument: string | null): boolean {
  return instrument !== null && replayedContract(instrument) !== null;
}

export function displaySymbol(instrument: string): string {
  const replayed = replayedContract(instrument);
  if (replayed !== null) return `${displaySymbol(replayed)} replay`;
  const base = instrument.split('.')[0] ?? instrument;
  const fut = /^([A-Z][A-Z0-9]{0,2})([FGHJKMNQUVXZ]\d)$/.exec(base);
  if (fut && instrument.includes('.')) return `${fut[1]!} ${fut[2]!}`;
  return base.replace('-', '');
}

const NEW_YORK = 'America/New_York';

const GLOBEX_REOPEN_NEW_YORK = 18 * 60;

export function sessionOptionsFor(calendar: SessionCalendar, zone: string = displayZone()): SessionOptions {
  switch (calendar) {
    case 'us_equities':
      return { mode: 'collapse', timezone: zone, dayStartMinutes: 0, dayStartZone: NEW_YORK };
    case 'cme_equity_index':
    case 'cme_interest_rates':
    case 'cme_fx':
    case 'cme_energy':
    case 'cme_gold':
    case 'cme_silver':
    case 'cme_copper':
    case 'cme_platinum':
    case 'cme_globex':
      return { mode: 'continuous', timezone: zone, dayStartMinutes: GLOBEX_REOPEN_NEW_YORK, dayStartZone: NEW_YORK };
    case 'crypto24x7':
      return { mode: 'continuous', timezone: zone, dayStartMinutes: 0, dayStartZone: 'UTC' };
  }
}

export function tradingDayZone(o: SessionOptions): string {
  return o.dayStartZone ?? o.timezone;
}

export function guessSessionOptions(instrument: string, zone: string = displayZone()): SessionOptions {
  if (/\.(CME|CBOT|NYMEX|COMEX)(-[A-Z]+)?$/.test(instrument)) return sessionOptionsFor('cme_globex', zone);
  if (instrument.includes('-USD')) return sessionOptionsFor('crypto24x7', zone);
  return sessionOptionsFor('us_equities', zone);
}

export function useInstrumentSpec(instrument: string | null): ContractSpec | null {
  const has = useHasTool('market.get_contract_spec');
  const q = useToolValue('market.get_contract_spec', has && !!instrument ? { instrument: instrument } : null, {
    keepFor: Infinity,
  });
  return q?.spec ?? null;
}
