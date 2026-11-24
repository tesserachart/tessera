import type { ChartState, JsonValue, Layout, Timeframe } from '@tessera/protocol';
import { withOrderFlow } from '../chart/templates/orderFlow.ts';
import { EDGE_SPEC } from './dock/edges.ts';
import {
  DEFAULT_VIEW,
  defaultChartState,
  DOCK_VERSION,
  DOCK_VIEW_KEY,
  type ChartSetup,
  type LayoutPreset,
  type StageView,
  type StoryId,
} from '../state/layouts.ts';

export const PRESETS: readonly { id: LayoutPreset; count: number; label: string }[] = [
  { id: '1', count: 1, label: '1 chart' },
  { id: '2h', count: 2, label: '2 side by side' },
  { id: '2v', count: 2, label: '2 stacked' },
  { id: '3', count: 3, label: '3: one beside two' },
  { id: '4', count: 4, label: '4: 2 × 2' },
  { id: '6', count: 6, label: '6: 3 × 2' },
];

export function presetCount(preset: LayoutPreset): number {
  return PRESETS.find((p) => p.id === preset)?.count ?? 1;
}

const COLUMNS: Record<LayoutPreset, number[][]> = {
  '1': [[0]],
  '2h': [[0], [1]],
  '2v': [[0, 1]],
  '3': [[0], [1, 2]],
  '4': [
    [0, 2],
    [1, 3],
  ],
  '6': [
    [0, 3],
    [1, 4],
    [2, 5],
  ],
};

export function presetColumns(preset: LayoutPreset): number[][] {
  return COLUMNS[preset];
}

export function presetFor(count: number): LayoutPreset {
  return count <= 1 ? '1' : count === 2 ? '2h' : count === 3 ? '3' : count <= 4 ? '4' : '6';
}

export function nextChartId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`chart-${String(n)}`)) return `chart-${String(n)}`;
}

interface StoryTile {
  kinds: readonly string[];
  at: 'right' | 'below';
  size?: number;
  params?: Readonly<Record<string, unknown>>;
}

export interface StoryPreset {
  id: StoryId;
  label: string;
  brief: string;
  charts: readonly { timeframe: Timeframe; orderFlow?: boolean }[];
  arrange: LayoutPreset;
  trade: boolean;
  analyst: number;
  bottom: number | null;
  tiles: readonly StoryTile[];
}

export const STORY_PRESETS: readonly StoryPreset[] = [
  {
    id: 'trade',
    label: 'Trade',
    brief: 'One chart, Trade beside it',
    charts: [{ timeframe: '5m' }],
    arrange: '1',
    trade: true,
    analyst: 392,
    bottom: 192,
    tiles: [],
  },
  {
    id: 'scalp',
    label: 'Scalp',
    brief: '1m order flow, Trade, DOM and time & sales',
    charts: [{ timeframe: '1m', orderFlow: true }],
    arrange: '1',
    trade: true,
    analyst: 344,
    bottom: 120,
    tiles: [
      { kinds: ['dom'], at: 'right', params: { link: '1' } },
      { kinds: ['tape'], at: 'right', params: { link: '1' } },
    ],
  },
  {
    id: 'analyse',
    label: 'Analyse',
    brief: '1h and 5m side by side, linked',
    charts: [{ timeframe: '1h' }, { timeframe: '5m' }],
    arrange: '2h',
    trade: false,
    analyst: 480,
    bottom: null,
    tiles: [],
  },
  {
    id: 'review',
    label: 'Review',
    brief: 'The chart over the session’s record',
    charts: [{ timeframe: '5m' }],
    arrange: '1',
    trade: false,
    analyst: 392,
    bottom: 360,
    tiles: [{ kinds: ['journal'], at: 'below' }],
  },
];

export function storyPreset(id: StoryId | null | undefined): StoryPreset {
  return STORY_PRESETS.find((s) => s.id === id) ?? STORY_PRESETS[0]!;
}

export function storyName(story: StoryPreset, names: readonly string[]): string {
  const taken = new Set(names);
  if (!taken.has(story.label)) return story.label;
  for (let n = 2; ; n++) {
    const name = `${story.label} ${String(n)}`;
    if (!taken.has(name)) return name;
  }
}

const STORY_NARROW_W = 1280;

export function storyAnalystWidth(story: StoryPreset, windowWidth: number): number {
  const column = story.tiles.some((t) => t.at === 'right');
  return column && windowWidth > 0 && windowWidth < STORY_NARROW_W
    ? Math.min(story.analyst, EDGE_SPEC.right.min)
    : story.analyst;
}

export function storyCollapsed(story: StoryPreset): Partial<Record<'left' | 'right' | 'bottom', boolean>> {
  return { right: false, ...(story.bottom === null ? { bottom: true } : {}) };
}

export function storyLayout(
  story: StoryPreset,
  opts: {
    layoutId: string;
    name: string;
    nowNs: number;
    instrument: string | null;
    setup: ChartSetup | null;
  },
): Layout {
  const charts: Record<string, ChartState> = {};
  const instrument = opts.instrument?.trim() ?? '';
  if (instrument)
    story.charts.forEach((c, i) => {
      const tileId = `chart-${String(i + 1)}`;
      const chart = defaultChartState(tileId, `Chart ${String(i + 1)}`, instrument, c.timeframe, opts.setup);
      charts[tileId] = c.orderFlow ? { ...chart, layers: withOrderFlow(chart.layers) } : chart;
    });
  const view: StageView = {
    ...DEFAULT_VIEW,
    v: DOCK_VERSION,
    preset: story.arrange,
    collapsed: storyCollapsed(story),
    story: story.id,
  };
  return {
    id: opts.layoutId,
    name: opts.name,
    revision: 0,
    updatedAt: opts.nowNs,
    activeChartId: charts['chart-1'] ? 'chart-1' : null,
    dock: { [DOCK_VIEW_KEY]: view as unknown as JsonValue },
    trade: null,
    charts,
  };
}
