import type { TradeOverlay, TradePlanStep } from '@tessera/chart';
import type { PathStep, TradeDetail } from '@tessera/protocol';
import { chartSteps } from './activity.ts';
import { nsToMs } from './format.ts';

export function tradeOverlayOf(d: TradeDetail, colors: TradeOverlay['colors']): TradeOverlay {
  const t = d.trade;
  const open = nsToMs(t.openedAt);
  const closed = t.status === 'closed' && t.closedAt !== null;
  const leg = (path: readonly PathStep[] | undefined, planned: number | null): TradePlanStep[] => {
    if (path?.some((s) => s.price !== null)) return chartSteps(path);
    return planned === null ? [] : [{ t: open, price: planned }];
  };
  return {
    long: t.side === 'buy',
    open,
    close: closed ? nsToMs(t.closedAt!) : null,
    entry: t.entryPrice,
    exit: closed ? t.exitPrice : null,
    stop: leg(d.activity?.stopPath, t.stopPrice),
    target: leg(d.activity?.targetPath, t.targetPrice),
    fills: d.executions.map((e) => ({ t: nsToMs(e.ts), price: e.price, side: e.side, qty: e.qty })),
    mae: t.maePrice,
    mfe: t.mfePrice,
    colors,
  };
}

export function tradeFrame(
  open: number,
  close: number | null,
  last: number,
  step: number,
): { from: number; to: number } {
  const end = close ?? last;
  const pad = Math.max(12 * step, (end - open) * 0.75);
  return { from: open - pad, to: Math.min(last, end + pad * 0.6) };
}
