import { formatMoney } from '@tessera/ui';
import type {
  DataCoverageInput,
  Execution,
  Gates,
  LevelCoverage,
  PlaceboResult,
  ResearchBudget,
  Rule,
  RunDigest,
  SaveStudyInput,
  Study,
  StudyData,
  Timeframe,
  TimeWindow,
  Verdict,
} from '@tessera/protocol';
import { guessSessionOptions, tradingDayZone } from '../../market/instruments.ts';
import { dateIn, displayZone, zoneCity, zonedMidnight } from '../../state/timeZone.ts';

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'];

export type RuleKind = Rule['rule'];

export const RULES: readonly {
  rule: RuleKind;
  label: string;
  what: string;
  params: readonly { key: string; label: string; min: number; max: number; step?: number }[];
}[] = [
  {
    rule: 'ema_cross',
    label: 'EMA cross',
    what: 'In the direction of the fast EMA against the slow one, flipping as they cross.',
    params: [
      { key: 'fast', label: 'Fast', min: 1, max: 500 },
      { key: 'slow', label: 'Slow', min: 2, max: 1000 },
    ],
  },
  {
    rule: 'breakout',
    label: 'Breakout',
    what: 'A close beyond the extreme of the bars before it, held a set number of bars.',
    params: [
      { key: 'lookback', label: 'Lookback', min: 1, max: 1000 },
      { key: 'holdBars', label: 'Hold bars', min: 1, max: 1000 },
    ],
  },
  {
    rule: 'rsi_reversion',
    label: 'RSI reversion',
    what: 'Against an RSI extreme, out at 50 or after the hold.',
    params: [
      { key: 'length', label: 'Length', min: 2, max: 200 },
      { key: 'lower', label: 'Long under', min: 1, max: 49 },
      { key: 'upper', label: 'Short over', min: 51, max: 99 },
      { key: 'holdBars', label: 'Hold bars', min: 1, max: 1000 },
    ],
  },
];

export function defaultRule(kind: RuleKind): Rule {
  switch (kind) {
    case 'ema_cross':
      return { rule: 'ema_cross', fast: 9, slow: 21, sides: 'both' };
    case 'breakout':
      return { rule: 'breakout', lookback: 20, holdBars: 12, sides: 'both' };
    case 'rsi_reversion':
      return { rule: 'rsi_reversion', length: 14, lower: 30, upper: 70, holdBars: 12, sides: 'both' };
  }
}

export const STRATEGY_TEMPLATE = `/**
 * positions(bars, inputs) returns a target position per bar: +n long n contracts, -n short,
 * 0 flat, NaN no change. A decision on bar i acts at bar i+1's open: never read past bar i.
 * Return { position, stopDistance, targetDistance } to give a trade its own stop and target,
 * in price from its fill, on the bar that decides it.
 *
 * bars: Float64Arrays time (UTC seconds), open, high, low, close, volume, day, session, and
 * buyVolume, sellVolume, delta where the market reports aggressor sides. ta and session are
 * the indicators' own helpers: ta.ema, ta.crossover, session.clock(t, 'America/New_York')…
 *
 * Levels listed under History › Levels: bars.levels[name] is the value standing at each bar's
 * open (NaN before the first and where the vendor marks it not applicable), and
 * bars.levelsAsOf[name] its vendor time. Only sessions with history of every level run.
 * History › Window (09:30 to 11:30 in its time zone) keeps the study flat outside it.
 */
export const strategy = { inputs: { length: 20 } };

export function positions(bars, inputs) {
  const position = new Float64Array(bars.length).fill(NaN);
  return position;
}
`;

export const DEFAULT_EXECUTION: Execution = {
  qty: 1,
  commissionPerContract: 1,
  stopTicks: null,
  targetTicks: null,
  fillCases: [
    { name: 'base', slippageTicks: 1 },
    { name: 'stressed', slippageTicks: 2 },
  ],
};

export const DEFAULT_GATES: Gates = {
  minTrades: 100,
  minWinRate: null,
  ciAboveZero: true,
  eachHalfPositive: true,
  developmentPositive: true,
};

export function blankStudy(instrument: string): SaveStudyInput {
  return {
    id: null,
    name: '',
    family: null,
    hypothesis: '',
    notes: null,
    data: {
      instrument,
      tf: '5m',
      from: null,
      to: null,
      rthOnly: false,
      developmentShare: 0.5,
      levels: [],
      window: null,
    },
    strategy: { kind: 'rules', rule: defaultRule('ema_cross') },
    execution: DEFAULT_EXECUTION,
    gates: DEFAULT_GATES,
    placeboRuns: 100,
  };
}

export function studyInput(s: Study): SaveStudyInput {
  return {
    id: s.id,
    name: s.name,
    family: s.family,
    hypothesis: s.hypothesis,
    notes: s.notes,
    data: s.data,
    strategy: s.strategy,
    execution: s.execution,
    gates: s.gates,
    placeboRuns: s.placeboRuns,
  };
}

export function studyProblem(s: SaveStudyInput): string | null {
  if (!s.name.trim()) return 'Name the study';
  if (!s.hypothesis.trim()) return 'Register the hypothesis before it runs';
  if (s.strategy.kind === 'script' && !s.strategy.code.trim()) return 'The strategy has no code';
  if (s.data.levels.some((l) => !/^[^.\s@]+\.[^\s@]+(@\S+)?$/.test(l)))
    return 'Name levels as vendor.level, as Level history names them';
  if (
    s.data.window &&
    (!hhmm(s.data.window.start) || !hhmm(s.data.window.end) || s.data.window.end <= s.data.window.start)
  )
    return 'The window needs a start before its end (HH:MM)';
  if (s.strategy.kind === 'rules') {
    const r = s.strategy.rule;
    if (r.rule === 'ema_cross' && !(r.fast > 0 && r.slow > r.fast)) return 'The slow EMA must be longer than the fast';
  }
  return null;
}

export function stateWord(s: Pick<Study, 'state' | 'lastVerdict' | 'generation'>): string {
  const gen = s.generation > 1 ? ` · gen ${String(s.generation)}` : '';
  if (s.state === 'draft') return `Draft${gen}`;
  if (s.lastVerdict) return `${VERDICT_WORD[s.lastVerdict]}${gen}`;
  return `Frozen${gen}`;
}

export const VERDICT_WORD: Record<Verdict, string> = {
  qualified: 'Qualified',
  lead: 'Lead',
  rejected: 'Rejected',
};

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function pctCi(v: number | null, ci: [number, number] | null): string {
  if (v === null) return '—';
  return ci ? `${pct(v)} (${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)})` : pct(v);
}

export function moneyCi(v: number | null, ci: [number, number] | null): string {
  if (v === null) return '—';
  return ci ? `${formatMoney(v)} (${formatMoney(ci[0])} to ${formatMoney(ci[1])})` : formatMoney(v);
}

export function placeboLine(p: PlaceboResult | null): string | null {
  if (!p) return null;
  return `Beat ${(p.percentile * 100).toFixed(0)}% of ${String(p.runs)} placebo runs (the same trades at random bars; their median ${formatMoney(p.placeboMedian)} a trade)`;
}

export function budgetLine(b: ResearchBudget): string {
  return `${String(b.trials)} ${b.trials === 1 ? 'trial' : 'trials'} in ${b.family}`;
}

export function fillsLine(r: RunDigest): string | null {
  const base = r.cases[0];
  if (!base) return null;
  const n = base.development.approximateExits + base.later.approximateExits;
  if (n === 0) return null;
  const exits = n === 1 ? '1 stop or target exit' : `${String(n)} stop and target exits`;
  return `${exits} in the base case fell in sessions without saved prints: found on the bar's high and low, so they are approximate.`;
}

export function coverageInput(
  s: Pick<Study, 'data'>,
  run: { from: number; to: number } | null | undefined,
): DataCoverageInput | null {
  if (!run) return null;
  const tradeDateZone = tradingDayZone(guessSessionOptions(s.data.instrument));
  return {
    instrument: s.data.instrument,
    from: dateValue(run.from, tradeDateZone),
    to: dateValue(run.to, tradeDateZone),
    scope: s.data.rthOnly ? 'rth' : 'session',
  };
}

export function dateValue(ns: number | null, zone: string = displayZone()): string {
  return ns === null ? '' : dateIn(ns / 1e6, zone);
}

export function fromDateValue(v: string, endOfDay = false, zone: string = displayZone()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  if (!endOfDay) return zonedMidnight(v, zone) * 1e6;
  const next = new Date(`${v}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return (zonedMidnight(next.toISOString().slice(0, 10), zone) - 1) * 1e6;
}

export function dataWords(d: StudyData, symbol: string): string {
  const range =
    d.from === null && d.to === null
      ? 'all served history'
      : `${d.from === null ? 'start' : dateValue(d.from)} to ${d.to === null ? 'now' : dateValue(d.to)}`;
  const window = d.window ? ` · ${windowWords(d.window)}` : '';
  const levels = d.levels.length ? ` · ${d.levels.join(', ')}` : '';
  return `${symbol} · ${d.tf} · ${range}${d.rthOnly ? ' · RTH' : ''}${window}${levels}`;
}

const RUNTIME_WINDOW_ZONE = 'America/New_York';

export function windowZone(w: TimeWindow): string {
  return w.timeZone ?? RUNTIME_WINDOW_ZONE;
}

function windowWords(w: TimeWindow): string {
  return `${w.start}–${w.end} ${zoneCity(windowZone(w))}`;
}

export function levelExample(series: readonly { vendor: string; level: string }[]): string {
  const s = series[0];
  return s ? `${s.vendor.toLowerCase()}.${s.level}` : 'vendor.level';
}

export function parseLevels(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function hhmm(v: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${m[2]!}` : null;
}

export function coverageLines(c: LevelCoverage): string[] {
  const out = [
    `Ran on ${String(c.sessionsUsed)} of ${String(c.sessionsRead)} sessions${
      c.usedFrom && c.usedTo ? ` (${c.usedFrom} to ${c.usedTo})` : ''
    }: those with history of every level input.`,
  ];
  for (const i of c.inputs) {
    const dates = i.firstDate && i.lastDate ? `${i.firstDate} to ${i.lastDate}` : 'no values in range';
    out.push(
      `${i.name} · ${i.vendor}${i.label ? ` ${i.label}` : ''} on ${i.instrument}${
        i.basis && i.basis !== i.instrument ? ` (${i.basis} prices)` : ''
      } · ${dates} · ${String(i.sessions)} sessions`,
    );
  }
  const left = c.sessionsRead - c.sessionsUsed;
  if (left > 0) out.push(`${String(left)} sessions left out, none filled in.`);
  return out;
}
