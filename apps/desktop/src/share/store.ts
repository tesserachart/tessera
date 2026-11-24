import type { ShareChartInput, ShareLink } from '@tessera/protocol';
import { accountListStore } from '../app/portfolio.ts';
import { makeStore, patch, read, useStore } from '../app/store.ts';
import { failureText, runTool } from '../app/tools.ts';
import { captureWindow, privateWordsOf } from '../feedback/capture.ts';
import { screenWords } from '../shell/deskWords.ts';
import { layoutsStore } from '../state/layouts.ts';
import { CHART_CANVAS_ATTR } from './model.ts';
import { quietChart, TRADING_STATE_ATTR } from './quiet.ts';

export type ShareFlow =
  | { kind: 'closed' }
  | { kind: 'taking' }
  | { kind: 'ready'; preview: string; input: ShareChartInput }
  | { kind: 'sending'; preview: string; input: ShareChartInput }
  | { kind: 'shared'; preview: string; link: ShareLink }
  | { kind: 'failed'; why: string };

interface ShareState {
  flow: ShareFlow;
  run: number;
}

interface ChartTarget {
  layoutId: string;
  tileId: string;
}

const SHARE_FAILED = 'The chart couldn’t be shared. Try again in a moment.';
const NOT_ON_SCREEN = 'This chart isn’t on screen. Show it, then share again.';
export const SHARE_LIST = 'share.list';
const LEFT_OUT = [
  `[${TRADING_STATE_ATTR}]`,
  '[role="toolbar"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
];

const shareStore = makeStore<ShareState>({ flow: { kind: 'closed' }, run: 0 });

export function useShareFlow(): ShareFlow {
  return useStore(shareStore, (s) => s.flow);
}

export function closeShare(): void {
  patch(shareStore, (s): ShareState => ({ flow: { kind: 'closed' }, run: s.run + 1 }));
}

function chartCanvas(tileId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${CHART_CANVAS_ATTR}="${CSS.escape(tileId)}"]`);
}

function runner() {
  const run = read(shareStore).run;
  return (flow: ShareFlow) => {
    if (read(shareStore).run === run) patch(shareStore, { flow });
  };
}

export async function shareChart(target: ChartTarget): Promise<void> {
  patch(shareStore, (s): ShareState => ({ flow: { kind: 'taking' }, run: s.run + 1 }));
  const settle = runner();
  const root = chartCanvas(target.tileId);
  const chart = read(layoutsStore).layouts[target.layoutId]?.charts[target.tileId];
  if (!root || !chart) return settle({ kind: 'failed', why: NOT_ON_SCREEN });
  try {
    const words = privateWordsOf(read(accountListStore) ?? [], { paper: true });
    const unquiet = quietChart(target.tileId);
    const shot = await captureWindow(words, root, LEFT_OUT).finally(unquiet);
    settle({
      kind: 'ready',
      preview: shot.preview,
      input: {
        image: { type: shot.type, data: shot.data, width: shot.width, height: shot.height },
        instrument: chart.instrument,
        timeframe: chart.printBars ? null : chart.timeframe,
      },
    });
  } catch (error) {
    settle({ kind: 'failed', why: screenWords(failureText(error), SHARE_FAILED) });
  }
}

export async function createLink(): Promise<void> {
  const flow = read(shareStore).flow;
  if (flow.kind !== 'ready') return;
  patch(shareStore, { flow: { kind: 'sending', preview: flow.preview, input: flow.input } });
  const settle = runner();
  try {
    const link = await runTool('share.chart', flow.input, { refresh: [SHARE_LIST] });
    settle({ kind: 'shared', preview: flow.preview, link });
  } catch (error) {
    settle({ kind: 'failed', why: screenWords(failureText(error), SHARE_FAILED) });
  }
}
