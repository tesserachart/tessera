import type { Layout, ShareAddOutput, SharedItem, SetupKind } from '@tessera/protocol';
import { makeStore, patch, read, useStore } from '../app/store.ts';
import { attempt, refreshTools } from '../app/tools.ts';
import { noteOnChart } from '../chart/chartNotice.ts';
import { followTemplate, putTemplates } from '../chart/templates/store.ts';
import { isTextInput } from '../commands/registry.ts';
import { screenWords } from '../shell/deskWords.ts';
import { applyChartResult, layoutsStore, putLayout } from '../state/layouts.ts';
import { workspaceStore } from '../state/workspace.ts';
import { activeChartTarget, layoutSaved } from '../workspace/controller.ts';
import { deskToasts } from '../workspace/dock/deskToasts.ts';
import { switchWorkspace } from '../workspace/document.ts';
import type { ChartTarget } from './store.ts';

export type OpenFlow =
  | { step: 'closed' }
  | { step: 'asking'; text: string; why: string | null }
  | { step: 'reading'; url: string }
  | { step: 'shown'; item: SharedItem }
  | { step: 'adding'; item: SharedItem }
  | { step: 'failed'; why: string };

interface OpenState {
  flow: OpenFlow;
  run: number;
}

export interface AddPlan {
  label: string;
  line: string;
  blocked: string | null;
}

export type DeskWindow = 'desk' | 'popout';

const SHARE_PATH = /^\/s\/[A-Za-z0-9]{12}\/?$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const COLOUR = /^#[0-9a-f]{6}$/i;
const WORKSPACE_CHANNEL = 'tessera:shared-workspace';
const NOT_OPENED = 'This link couldn’t be opened. Check it, then try again.';
const NOT_ADDED = 'This couldn’t be added. Try again in a moment.';
export const NOT_A_LINK = 'Paste a link someone shared from Tessera.';

const openStore = makeStore<OpenState>({ flow: { step: 'closed' }, run: 0 });

export function useOpenFlow(): OpenFlow {
  return useStore(openStore, (s) => s.flow);
}

export function shareLinkIn(text: string): string | null {
  const link = text.trim();
  if (!link || /\s/.test(link)) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  return secure && SHARE_PATH.test(url.pathname) ? link : null;
}

export function isColour(value: string): boolean {
  return COLOUR.test(value);
}

function sharedTitle(kind: SetupKind): string {
  switch (kind) {
    case 'indicator':
      return 'Shared indicator';
    case 'template':
      return 'Shared template';
    case 'layout':
      return 'Shared workspace';
  }
}

export function openTitle(flow: Exclude<OpenFlow, { step: 'closed' }>): string {
  return flow.step === 'shown' || flow.step === 'adding' ? sharedTitle(flow.item.kind) : 'Open a shared link';
}

export function addPlan(kind: SetupKind, hasChart: boolean): AddPlan {
  switch (kind) {
    case 'indicator':
      return hasChart
        ? { label: 'Add to my charts', line: 'It goes on the chart you have open.', blocked: null }
        : { label: 'Add to my charts', line: 'Open a chart to add it to.', blocked: 'Open a chart first' };
    case 'template':
      return {
        label: 'Use this template',
        line: hasChart ? 'It’s saved to your templates and put on your chart.' : 'It’s saved to your templates.',
        blocked: null,
      };
    case 'layout':
      return { label: 'Use this workspace', line: 'It’s saved as a new workspace and opened.', blocked: null };
  }
}

export function addingWords(kind: SetupKind): string {
  switch (kind) {
    case 'indicator':
      return 'Adding it to your chart…';
    case 'template':
      return 'Saving the template…';
    case 'layout':
      return 'Saving the workspace…';
  }
}

export function closeOpen(): void {
  patch(openStore, (s): OpenState => ({ flow: { step: 'closed' }, run: s.run + 1 }));
}

function runner() {
  const run = read(openStore).run;
  return (flow: OpenFlow) => {
    if (read(openStore).run === run) patch(openStore, { flow });
  };
}

export function askForSharedLink(): void {
  patch(openStore, (s): OpenState => ({ flow: { step: 'asking', text: '', why: null }, run: s.run + 1 }));
}

export function setLinkText(text: string): void {
  const flow = read(openStore).flow;
  if (flow.step === 'asking') patch(openStore, { flow: { step: 'asking', text, why: null } });
}

export async function openSharedLink(url: string): Promise<void> {
  patch(openStore, (s): OpenState => ({ flow: { step: 'reading', url }, run: s.run + 1 }));
  const settle = runner();
  const r = await attempt('share.open', { url });
  settle(r.ok ? { step: 'shown', item: r.out } : { step: 'failed', why: screenWords(r.why, NOT_OPENED) });
}

export function submitLink(): Promise<void> {
  const flow = read(openStore).flow;
  if (flow.step !== 'asking') return Promise.resolve();
  const url = shareLinkIn(flow.text);
  if (url) return openSharedLink(url);
  patch(openStore, { flow: { ...flow, why: NOT_A_LINK } });
  return Promise.resolve();
}

function chartToAddTo(): ChartTarget | null {
  const ref = read(workspaceStore).activeChart;
  if (ref && read(layoutsStore).layouts[ref.layoutId]?.charts[ref.tileId])
    return { layoutId: ref.layoutId, tileId: ref.tileId };
  return activeChartTarget();
}

async function openWorkspaceHere(layout: Layout): Promise<void> {
  putLayout(layout);
  void refreshTools('layout.list');
  await switchWorkspace(layout.id);
}

function handToDesk(layout: Layout): Promise<void> {
  if (typeof BroadcastChannel === 'undefined') return openWorkspaceHere(layout);
  const channel = new BroadcastChannel(WORKSPACE_CHANNEL);
  channel.postMessage({ layout });
  channel.close();
  return Promise.resolve();
}

let showWorkspace: (layout: Layout) => Promise<void> = openWorkspaceHere;

function templateName(out: Extract<ShareAddOutput, { kind: 'template' }>, item: SharedItem): string {
  return out.templates.templates.find((t) => t.id === out.templateId)?.name ?? item.display.name;
}

async function applyAdded(out: ShareAddOutput, chart: ChartTarget | null, item: SharedItem): Promise<void> {
  switch (out.kind) {
    case 'indicator': {
      const { layoutId, revision, chart: after } = out.chart;
      applyChartResult(layoutId, revision, after);
      noteOnChart({ layoutId, tileId: after.tileId }, `Added ${item.display.name}`);
      return;
    }
    case 'template': {
      putTemplates(out.templates);
      const name = templateName(out, item);
      if (out.applied && chart) {
        applyChartResult(out.applied.layoutId, out.applied.revision, out.applied.chart);
        followTemplate(chart, out.templateId);
        noteOnChart(chart, `Using the template ${name}`);
      } else {
        deskToasts.push({ tone: 'ok', title: `Saved the template ${name}` });
      }
      return;
    }
    case 'layout':
      await showWorkspace(out.layout);
      return;
  }
}

export async function addShared(): Promise<void> {
  const flow = read(openStore).flow;
  if (flow.step !== 'shown') return;
  const { item } = flow;
  const chart = item.kind === 'layout' ? null : chartToAddTo();
  if (addPlan(item.kind, chart !== null).blocked) return;
  patch(openStore, { flow: { step: 'adding', item } });
  const settle = runner();
  if (chart) await layoutSaved();
  const r = await attempt('share.add', {
    url: item.url,
    layoutId: chart?.layoutId ?? null,
    tileId: chart?.tileId ?? null,
  });
  if (!r.ok) {
    settle({ step: 'failed', why: screenWords(r.why, NOT_ADDED) });
    return;
  }
  settle({ step: 'closed' });
  await applyAdded(r.out, chart, item).catch((error: unknown) => {
    console.warn(`[share] ${item.kind} added but not shown`, error);
  });
}

function pastedLink(e: ClipboardEvent, doc: Document): string | null {
  const target = e.target instanceof Element ? e.target : null;
  if (isTextInput(target) || isTextInput(doc.activeElement)) return null;
  return shareLinkIn(e.clipboardData?.getData('text/plain') ?? '');
}

function isHandedWorkspace(data: unknown): data is { layout: Layout } {
  const layout = (data as { layout?: Partial<Layout> } | null)?.layout;
  return typeof layout?.id === 'string' && typeof layout.revision === 'number';
}

function listenForHandedWorkspaces(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(WORKSPACE_CHANNEL);
  channel.onmessage = (e: MessageEvent<unknown>) => {
    if (isHandedWorkspace(e.data)) void openWorkspaceHere(e.data.layout);
  };
  return () => channel.close();
}

export function listenForSharedLinks(where: DeskWindow, doc: Document = document): () => void {
  showWorkspace = where === 'desk' ? openWorkspaceHere : handToDesk;
  const onPaste = (e: ClipboardEvent) => {
    const url = pastedLink(e, doc);
    if (!url) return;
    e.preventDefault();
    void openSharedLink(url);
  };
  doc.addEventListener('paste', onPaste);
  const stopHanded = where === 'desk' ? listenForHandedWorkspaces() : () => undefined;
  return () => {
    doc.removeEventListener('paste', onPaste);
    stopHanded();
  };
}
