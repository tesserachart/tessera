import { isAskSource, type AskTarget, type ChartApi } from '@tessera/chart';
import { displayZone, zoneAbbreviation } from '../state/timeZone.ts';

export function orderFlowAsks(chart: ChartApi, x: number, y: number): AskTarget[] {
  const out: AskTarget[] = [];
  for (const info of chart.layers()) {
    if (!info.visible || !info.id.startsWith('model:')) continue;
    const layer = chart.getLayer(info.id);
    if (!isAskSource(layer)) continue;
    const t = layer.askTarget(x, y);
    if (t && !out.some((o) => o.kind === t.kind)) out.push(t);
  }
  const rank = { bubble: 0, bar: 1, profile: 2 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function clock(ms: number, seconds: boolean): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
    timeZone: displayZone(),
  });
}

function zoned(ms: number, seconds: boolean): string {
  return `${clock(ms, seconds)} ${zoneAbbreviation(displayZone(), ms)}`;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: displayZone(),
  });
}

export function askQuestion(t: AskTarget, symbol: string, tf: string, price: (p: number) => string): string {
  const range = t.low === t.high ? price(t.low) : `${price(t.low)}–${price(t.high)}`;
  const facts = t.detail ? ` (${t.detail})` : '';
  if (t.kind === 'bar') {
    return `What does the order flow of the ${symbol} ${tf} bar at ${zoned(t.from, false)} on ${day(t.from)}, ${range}, say${facts}? Measured numbers first, then your reading.`;
  }
  if (t.kind === 'bubble') {
    return `What does the big trade on ${symbol} at ${zoned(t.from, true)} on ${day(t.from)}, ${range}, tell us${facts}? Measured numbers first, then your reading.`;
  }
  return `What does ${t.label} of ${symbol} (${tf} chart, ${day(t.from)} ${clock(t.from, false)}–${zoned(t.to, false)}, ${range}) say${facts}? Measured numbers first, then your reading.`;
}

export function askLabel(t: AskTarget): string {
  if (t.kind === 'bar') return `Ask about the ${clock(t.from, false)} bar's order flow`;
  return `Ask about ${t.label}`;
}
