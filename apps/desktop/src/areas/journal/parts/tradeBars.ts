import { msToNs, normalizeEpochMs, type Timeframe, type TradeDetail } from '@tessera/protocol';
import { useMemo, useState } from 'react';
import { useHasTool, useTool, valueOf } from '../../../app/tools.ts';
import { autoTimeframe } from '../model/chart.ts';
import { nsToMs } from '../model/format.ts';

export const TF_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function useTradeBars(d: TradeDetail, tf: Timeframe): { bars: Bar[]; state: 'loading' | 'ready' | 'none' } {
  const t = d.trade;
  const has = useHasTool('market.get_candles');
  const step = TF_MS[tf] ?? 60_000;
  const open = nsToMs(t.openedAt);
  const from = open - step * 40;
  const to = t.closedAt === null ? undefined : nsToMs(t.closedAt) + step * 25;
  const q = useTool(
    'market.get_candles',
    has
      ? {
          instrument: t.instrument,
          tf,
          from: msToNs(from),
          ...(to === undefined ? {} : { to: msToNs(to) }),
          limit: 1500,
        }
      : null,
    { keepFor: 5 * 60_000 },
  );
  const bars = useMemo(
    () =>
      (valueOf(q)?.bars ?? []).map((b) => ({ t: normalizeEpochMs(b[0]), o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] })),
    [valueOf(q)],
  );
  const state = !has || q.isError ? 'none' : q.isSuccess ? (bars.length ? 'ready' : 'none') : 'loading';
  return { bars, state };
}

export type TfChoice = 'auto' | Timeframe;
const TF_KEY = 'tessera.journal.tradeTf';

function storedTf(): TfChoice {
  const v = localStorage.getItem(TF_KEY);
  return v === '1m' || v === '5m' || v === '15m' || v === '1h' ? v : 'auto';
}

export function useTradeTf(holdSecs: number | null): [Timeframe, TfChoice, (c: TfChoice) => void] {
  const [choice, setChoice] = useState<TfChoice>(storedTf);
  const set = (c: TfChoice) => {
    localStorage.setItem(TF_KEY, c);
    setChoice(c);
  };
  return [choice === 'auto' ? autoTimeframe(holdSecs) : choice, choice, set];
}
