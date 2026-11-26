import type { SharedConversation, ShareChartInput, ShareLink, ShareSetupInput } from '@tessera/protocol';
import { accountListStore } from '../app/portfolio.ts';
import { makeStore, patch, read, useStore } from '../app/store.ts';
import { attempt, failureText, type Attempt } from '../app/tools.ts';
import { captureWindow, privateWordsOf } from '../feedback/capture.ts';
import { screenWords } from '../shell/deskWords.ts';
import { layoutsStore } from '../state/layouts.ts';
import { layoutSaved } from '../workspace/controller.ts';
import { stampMark } from './mark.ts';
import { CHART_CANVAS_ATTR } from './model.ts';
import { quietChart, TRADING_STATE_ATTR } from './quiet.ts';
import { failedWords, NOT_ON_SCREEN } from './words.ts';

export interface ChartTarget {
  layoutId: string;
  tileId: string;
}

interface Picture {
  preview: string;
  input: ShareChartInput;
}

export type Share =
  | { subject: 'chart'; target: ChartTarget; picture: Picture | null }
  | { subject: 'conversation'; sessionId: string; showPnl: boolean; page: SharedConversation | null }
  | { subject: 'setup'; setup: ShareSetupInput; name: string; code: boolean };

export type ShareFlow =
  | { step: 'closed' }
  | { step: 'preparing'; share: Share }
  | { step: 'ready'; share: Share }
  | { step: 'sending'; share: Share }
  | { step: 'shared'; share: Share; link: ShareLink }
  | { step: 'failed'; share: Share; why: string };

interface ShareState {
  flow: ShareFlow;
  run: number;
}

export const SHARE_LIST = 'share.list';
const LEFT_OUT = [
  `[${TRADING_STATE_ATTR}]`,
  '[role="toolbar"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
];

const shareStore = makeStore<ShareState>({ flow: { step: 'closed' }, run: 0 });

export function useShareFlow(): ShareFlow {
  return useStore(shareStore, (s) => s.flow);
}

export function closeShare(): void {
  patch(shareStore, (s): ShareState => ({ flow: { step: 'closed' }, run: s.run + 1 }));
}

function chartCanvas(tileId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${CHART_CANVAS_ATTR}="${CSS.escape(tileId)}"]`);
}

async function pictureOf(target: ChartTarget): Promise<Picture> {
  const root = chartCanvas(target.tileId);
  const chart = read(layoutsStore).layouts[target.layoutId]?.charts[target.tileId];
  if (!root || !chart) throw new Error(NOT_ON_SCREEN);
  const words = privateWordsOf(read(accountListStore) ?? [], { paper: true });
  const unquiet = quietChart(target.tileId);
  const shot = await captureWindow(words, root, LEFT_OUT, stampMark).finally(unquiet);
  return {
    preview: shot.preview,
    input: {
      image: { type: shot.type, data: shot.data, width: shot.width, height: shot.height },
      instrument: chart.instrument,
      timeframe: chart.printBars ? null : chart.timeframe,
    },
  };
}

async function prepare(share: Share): Promise<Attempt<Share>> {
  switch (share.subject) {
    case 'chart':
      return pictureOf(share.target).then(
        (picture): Attempt<Share> => ({ ok: true, out: { ...share, picture } }),
        (error: unknown): Attempt<Share> => ({ ok: false, drafted: false, why: failureText(error) }),
      );
    case 'conversation': {
      const r = await attempt('share.preview_conversation', { sessionId: share.sessionId, showPnl: share.showPnl });
      return r.ok ? { ok: true, out: { ...share, page: r.out } } : r;
    }
    case 'setup':
      return { ok: true, out: share };
  }
}

async function create(share: Share): Promise<Attempt<ShareLink>> {
  const refresh = { refresh: [SHARE_LIST] };
  switch (share.subject) {
    case 'chart':
      if (!share.picture) return { ok: false, drafted: false, why: NOT_ON_SCREEN };
      return attempt('share.chart', share.picture.input, refresh);
    case 'conversation':
      return attempt('share.conversation', { sessionId: share.sessionId, showPnl: share.showPnl }, refresh);
    case 'setup':
      await layoutSaved();
      return attempt('share.setup', share.setup, refresh);
  }
}

function runner() {
  const run = read(shareStore).run;
  return (flow: ShareFlow) => {
    if (read(shareStore).run === run) patch(shareStore, { flow });
  };
}

function begin(share: Share): void {
  patch(shareStore, (s): ShareState => ({ flow: { step: 'preparing', share }, run: s.run + 1 }));
}

async function prepareNow(share: Share): Promise<void> {
  const settle = runner();
  const r = await prepare(share);
  settle(
    r.ok ? { step: 'ready', share: r.out } : { step: 'failed', share, why: screenWords(r.why, failedWords(share)) },
  );
}

function openShare(share: Share): Promise<void> {
  begin(share);
  return prepareNow(share);
}

export function shareChart(target: ChartTarget): Promise<void> {
  return openShare({ subject: 'chart', target, picture: null });
}

export function shareConversation(sessionId: string): Promise<void> {
  return openShare({ subject: 'conversation', sessionId, showPnl: false, page: null });
}

export function shareSetup(setup: ShareSetupInput, name: string, code: boolean): Promise<void> {
  return openShare({ subject: 'setup', setup, name, code });
}

export function showPnl(on: boolean): Promise<void> {
  const flow = read(shareStore).flow;
  if (flow.step !== 'ready' && flow.step !== 'preparing') return Promise.resolve();
  if (flow.share.subject !== 'conversation' || flow.share.showPnl === on) return Promise.resolve();
  return openShare({ ...flow.share, showPnl: on });
}

export async function createLink(): Promise<void> {
  const flow = read(shareStore).flow;
  if (flow.step !== 'ready') return;
  const { share } = flow;
  patch(shareStore, { flow: { step: 'sending', share } });
  const settle = runner();
  const r = await create(share);
  settle(
    r.ok
      ? { step: 'shared', share, link: r.out }
      : { step: 'failed', share, why: screenWords(r.why, failedWords(share)) },
  );
}
