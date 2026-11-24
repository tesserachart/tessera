import { Orientation, type DockviewApi, type DockviewGroupPanel, type SerializedGridObject } from 'dockview-react';
import { putOnDesk } from '../workspace/deskPlace.ts';
import { DEFAULT_DOM_PARAMS, readDomParams } from './dom/ladderModel.ts';
import { DEFAULT_TAPE_PARAMS, readTapeParams } from './tape/tapeModel.ts';

export const COLUMN_WIDTH = 264;
export const TAPE_SHARE = 0.38;

type GridNode = SerializedGridObject<{ id: string }>;

export function levelWidths(widths: readonly number[], take: number): number[] {
  const desc = [...widths].sort((a, b) => b - a);
  let level = desc[0] ?? 0;
  let freed = 0;
  for (let i = 0; i < desc.length; i++) {
    const next = desc[i + 1] ?? 0;
    const room = (level - next) * (i + 1);
    if (freed + room >= take) {
      level -= (take - freed) / (i + 1);
      break;
    }
    freed += room;
    level = next;
  }
  return widths.map((w) => Math.round(Math.min(w, level)));
}

function rowHolding(node: GridNode, horizontal: boolean, groupId: string): string[] | null {
  if (node.type === 'leaf') return null;
  const kids = node.data as GridNode[];
  const leafId = (k: GridNode) => (k.type === 'leaf' ? (k.data as { id: string }).id : null);
  if (horizontal && kids.some((k) => leafId(k) === groupId)) return kids.map(leafId).filter((id) => id !== null);
  for (const k of kids) {
    const row = rowHolding(k, !horizontal, groupId);
    if (row) return row;
  }
  return null;
}

function chartWidths(api: DockviewApi): Map<string, number> {
  const widths = new Map<string, number>();
  for (const g of api.groups) if (g.activePanel?.api.component === 'chart') widths.set(g.id, g.api.width);
  return widths;
}

interface Column {
  id: string;
  component: 'dom' | 'tape';
  title: string;
  params: Record<string, unknown>;
  initialWidth: number;
}

function addBesideItsChart(api: DockviewApi, add: Column, chart: string | null): void {
  const before = chartWidths(api);
  putOnDesk(api, add, { at: 'beside', panel: chart, side: 'right' });
  const column = api.getPanel(add.id);
  if (!chart || !column) return;
  const { root, orientation } = api.toJSON().grid;
  const row = rowHolding(root, orientation === Orientation.HORIZONTAL, column.group.id);
  if (!row) return;
  const groups = row.map((id) => api.getGroup(id)).filter((g) => g !== undefined);
  const charts = groups.filter((g) => before.has(g.id));
  const take = column.group.api.width;
  const after = levelWidths(
    charts.map((g) => before.get(g.id)!),
    take,
  );
  for (const g of groups) {
    const i = charts.indexOf(g);
    if (i >= 0) g.api.setSize({ width: after[i]! });
    else if (g === column.group) g.api.setSize({ width: take });
  }
}

export function freePanelId(
  api: Pick<DockviewApi, 'getPanel'>,
  kind: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  let id = kind;
  for (let i = 2; api.getPanel(id) || taken.has(id); i++) id = `${kind}-${String(i)}`;
  return id;
}

export interface FlowAdd {
  beside: string | null;
  into?: DockviewGroupPanel | null;
  taken?: ReadonlySet<string>;
  params?: Readonly<Record<string, unknown>>;
}

export function addDomTile(api: DockviewApi, opts: FlowAdd): string | null {
  const chart = opts.beside && api.getPanel(opts.beside) ? opts.beside : null;
  const id = freePanelId(api, 'dom', opts.taken);
  const params = { ...readDomParams({ ...DEFAULT_DOM_PARAMS, ...opts.params }) };
  if (opts.into) putOnDesk(api, { id, component: 'dom', title: 'DOM', params }, { at: 'tabs', group: opts.into });
  else addBesideItsChart(api, { id, component: 'dom', title: 'DOM', params, initialWidth: COLUMN_WIDTH }, chart);
  return id;
}

export function addTapeTile(api: DockviewApi, opts: FlowAdd): string | null {
  const params = readTapeParams({ ...DEFAULT_TAPE_PARAMS, ...opts.params });
  if (opts.into) {
    const id = freePanelId(api, 'tape', opts.taken);
    putOnDesk(
      api,
      { id, component: 'tape', title: 'Time & Sales', params: { ...params } },
      { at: 'tabs', group: opts.into },
    );
    return id;
  }
  const doms = api.panels.filter((p) => p.api.component === 'dom');
  const same = (p: (typeof doms)[number]) => {
    const d = readDomParams(p.params);
    return d.link === params.link && d.instrument === params.instrument;
  };
  const dom = doms.find(same) ?? doms[0] ?? null;
  const id = freePanelId(api, 'tape', opts.taken);
  if (dom) {
    putOnDesk(
      api,
      {
        id,
        component: 'tape',
        title: 'Time & Sales',
        params: { ...params },
        initialHeight: Math.round(dom.api.height * TAPE_SHARE),
      },
      { at: 'beside', panel: dom.id, side: 'below' },
    );
    return id;
  }
  const chart = opts.beside && api.getPanel(opts.beside) ? opts.beside : null;
  addBesideItsChart(
    api,
    { id, component: 'tape', title: 'Time & Sales', params: { ...params }, initialWidth: COLUMN_WIDTH },
    chart,
  );
  return id;
}
