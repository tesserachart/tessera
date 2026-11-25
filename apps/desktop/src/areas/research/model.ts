import { formatMoney } from '@tessera/ui';
import type {
  DataCoverageInput,
  Gates,
  LevelCoverage,
  PlaceboResult,
  ResearchBudget,
  Rule,
  RunDigest,
  Study,
  StudyData,
  TimeWindow,
  Verdict,
} from '@tessera/protocol';
import { guessSessionOptions, tradingDayZone } from '../../market/instruments.ts';
import { dateIn, displayZone, zoneCity } from '../../state/timeZone.ts';

export const VERDICT_WORD: Record<Verdict, string> = {
  qualified: 'Qualified',
  lead: 'Lead',
  rejected: 'Rejected',
};

const RULE_WORD: Record<Rule['rule'], string> = {
  ema_cross: 'EMA cross',
  breakout: 'Breakout',
  rsi_reversion: 'RSI reversion',
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

export function dateValue(ns: number | null, zone: string = displayZone()): string {
  return ns === null ? '' : dateIn(ns / 1e6, zone);
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

function rangeWords(d: Pick<StudyData, 'from' | 'to'>): string {
  if (d.from === null && d.to === null) return 'All served history';
  return `${d.from === null ? 'Start' : dateValue(d.from)} to ${d.to === null ? 'now' : dateValue(d.to)}`;
}

const RUNTIME_WINDOW_ZONE = 'America/New_York';

function windowZone(w: TimeWindow): string {
  return w.timeZone ?? RUNTIME_WINDOW_ZONE;
}

function windowWords(w: TimeWindow): string {
  return `${w.start}–${w.end} ${zoneCity(windowZone(w))}`;
}

function ruleWords(r: Rule): string {
  const sides = r.sides === 'both' ? '' : `, ${r.sides} only`;
  switch (r.rule) {
    case 'ema_cross':
      return `${RULE_WORD[r.rule]} ${String(r.fast)} / ${String(r.slow)}${sides}`;
    case 'breakout':
      return `${RULE_WORD[r.rule]} of ${String(r.lookback)} bars, held ${String(r.holdBars)}${sides}`;
    case 'rsi_reversion':
      return `${RULE_WORD[r.rule]} ${String(r.length)}, long under ${String(r.lower)}, short over ${String(r.upper)}, held ${String(r.holdBars)}${sides}`;
  }
}

function ticksWords(n: number | null): string {
  return n === null ? 'None' : `${String(n)} ticks`;
}

function gatesWords(g: Gates): string[] {
  return [
    `At least ${String(g.minTrades)} later trades`,
    g.minWinRate === null ? null : `Later win rate at least ${pct(g.minWinRate)}`,
    g.ciAboveZero ? 'Later mean trade’s interval above zero' : null,
    g.eachHalfPositive ? 'Each half of the later sessions positive' : null,
    g.developmentPositive ? 'Development positive' : null,
  ].filter((s): s is string => s !== null);
}

export interface SetupRow {
  label: string;
  value: string;
}

export function setupRows(s: Study, symbol: string): SetupRow[] {
  const e = s.execution;
  const rows: (SetupRow | null)[] = [
    { label: 'Market', value: `${symbol} · ${s.data.tf}${s.data.rthOnly ? ' · RTH only' : ''}` },
    { label: 'History', value: rangeWords(s.data) },
    { label: 'Development', value: `First ${pct(s.data.developmentShare)} of sessions` },
    s.data.window ? { label: 'Window', value: windowWords(s.data.window) } : null,
    s.data.levels.length ? { label: 'Levels', value: s.data.levels.join(', ') } : null,
    { label: 'Rules', value: s.strategy.kind === 'rules' ? ruleWords(s.strategy.rule) : 'Script' },
    { label: 'Contracts', value: String(e.qty) },
    { label: 'Commission', value: `${formatMoney(e.commissionPerContract)} a contract a side` },
    { label: 'Stop', value: ticksWords(e.stopTicks) },
    { label: 'Target', value: ticksWords(e.targetTicks) },
    {
      label: 'Fill cases',
      value: e.fillCases.map((c) => `${c.name} ${String(c.slippageTicks)}t`).join(' · '),
    },
    { label: 'Pass rules', value: gatesWords(s.gates).join(' · ') },
    { label: 'Placebo runs', value: s.placeboRuns ? String(s.placeboRuns) : 'None' },
    { label: 'Family', value: s.family },
  ];
  return rows.filter((r): r is SetupRow => r !== null);
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
