import { type ToastAction, type ToastQueue } from '@tessera/ui';
import { deskToasts } from '../workspace/dock/deskToasts.ts';
import { displaySymbol } from '../market/instruments.ts';
import { screenWords } from '../shell/deskWords.ts';
import { noticeWords } from '../shell/noticeWords.ts';
import { watchOrderLate, type ActionResult } from '../shell/tradeActions.ts';
import { toolCode } from '../app/tools.ts';
import { addConnection, openConnections } from '../accounts/navigate.ts';

watchOrderLate((update) => {
  const words = noticeWords(update.result);
  deskToasts.push({
    key: update.key,
    tone: update.result.tone,
    title: words.title,
    detail: words.detail,
  });
});

export function chartToasts(_chart: { layoutId: string; tileId: string }): ToastQueue {
  return deskToasts;
}

export interface NoteOptions {
  account?: string | null;
  retry?: () => void;
}

export function noteOnChart(
  chart: { layoutId: string; tileId: string },
  r: ActionResult | string,
  opts: NoteOptions = {},
): void {
  const src: ActionResult = typeof r === 'string' ? { tone: 'ok', text: r } : r;
  const words = noticeWords(src, opts.account ?? null);
  const action: ToastAction | null =
    src.tone === 'err' && opts.retry
      ? { label: 'Retry', run: opts.retry }
      : src.approval
        ? { label: 'Show', run: () => void import('../analyst/review.ts').then((m) => m.revealApproval()) }
        : null;
  const detail = [opts.account, words.detail].filter(Boolean).join(' · ') || null;
  chartToasts(chart).push({ key: src.key ?? null, tone: src.tone, title: words.title, detail, action });
}

export interface LoadErrorAction {
  label: string;
  run: () => void;
}

export function loadErrorAction(err: Error, connected: boolean): LoadErrorAction | null {
  if (toolCode(err) !== 'not_found') return null;
  return connected
    ? { label: 'Connections', run: () => openConnections() }
    : { label: 'Connect Rithmic', run: () => addConnection() };
}

export function loadErrorWords(instrument: string, err: Error): string {
  const sym = displaySymbol(instrument);
  if (toolCode(err) === 'not_found') return `No connection serves ${sym} now`;
  const why = err.message
    .replace(/;\s*try [^(]*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const said = screenWords(why, LOAD_AGAIN);
  return said === why ? `${sym} did not load: ${why}` : `${sym} did not load. ${said}`;
}

const LOAD_AGAIN = 'Try again in a moment.';
