export interface PnlBar {
  t: number;
  c: number;
}

export interface PnlFill {
  t: number;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
}

export interface PnlPoint {
  t: number;
  pnl: number;
  pos: number;
}

interface Book {
  pos: number;
  avg: number;
  realized: number;
}

function apply(b: Book, f: PnlFill): Book {
  const signed = f.side === 'buy' ? f.qty : -f.qty;
  if (b.pos === 0 || Math.sign(b.pos) === Math.sign(signed)) {
    const pos = b.pos + signed;
    const avg = (b.avg * Math.abs(b.pos) + f.price * Math.abs(signed)) / Math.abs(pos);
    return { pos, avg, realized: b.realized };
  }
  const closing = Math.min(Math.abs(b.pos), Math.abs(signed));
  const realized = b.realized + (f.price - b.avg) * closing * Math.sign(b.pos);
  const pos = b.pos + signed;
  if (pos === 0) return { pos: 0, avg: 0, realized };
  if (Math.sign(pos) === Math.sign(b.pos)) return { pos, avg: b.avg, realized };
  return { pos, avg: f.price, realized };
}

export function runningPnl(
  bars: readonly PnlBar[],
  fills: readonly PnlFill[],
  pointValue: number,
  stepMs: number,
): PnlPoint[] {
  if (!bars.length || !fills.length) return [];
  const sorted = [...fills].sort((a, b) => a.t - b.t);
  const first = sorted[0]!.t;
  const last = sorted[sorted.length - 1]!.t;
  let book: Book = { pos: 0, avg: 0, realized: 0 };
  let next = 0;
  const out: PnlPoint[] = [];
  for (const bar of bars) {
    const end = bar.t + stepMs;
    if (end <= first) continue;
    while (next < sorted.length && sorted[next]!.t < end) book = apply(book, sorted[next++]!);
    const open = book.pos === 0 ? 0 : (bar.c - book.avg) * book.pos;
    out.push({ t: bar.t, pnl: round2((book.realized + open) * pointValue), pos: book.pos });
    if (book.pos === 0 && last < end) break;
  }
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface PnlMarker {
  index: number;
  label: string;
}

const FILL_WORD: Record<'entry' | 'scale_in' | 'scale_out' | 'exit', string> = {
  entry: 'Entry',
  scale_in: 'Add',
  scale_out: 'Scale out',
  exit: 'Exit',
};

export function fillMarkers(
  fills: readonly { tMs: number; kind: keyof typeof FILL_WORD }[],
  series: readonly PnlPoint[],
  stepMs: number,
): PnlMarker[] {
  return fills.flatMap((f) => {
    const index = series.findIndex((p) => f.tMs >= p.t && f.tMs < p.t + stepMs);
    return index < 0 ? [] : [{ index, label: FILL_WORD[f.kind] }];
  });
}

export function pnlRange(series: readonly PnlPoint[]): { best: number; worst: number; last: number | null } {
  return {
    best: series.reduce((m, p) => Math.max(m, p.pnl), 0),
    worst: series.reduce((m, p) => Math.min(m, p.pnl), 0),
    last: series[series.length - 1]?.pnl ?? null,
  };
}
