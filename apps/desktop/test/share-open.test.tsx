import type { ChartState, Layout, ShareAddInput, ShareAddOutput, SharedItem, SetupKind } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import { templatesStore } from '../src/chart/templates/store.ts';
import {
  askForSharedLink,
  closeOpen,
  listenForSharedLinks,
  NOT_A_LINK,
  openSharedLink,
  shareLinkIn,
} from '../src/share/open.ts';
import { SharedLinkDialog } from '../src/share/SharedLinkDialog.tsx';
import { defaultChartState, layoutsStore } from '../src/state/layouts.ts';
import { setWorkspace, uiStore } from '../src/state/ui.ts';
import { setActiveChartRef } from '../src/state/workspace.ts';
import { answeringClient, seedTools, TestRuntime } from './support/runtime.tsx';

const URL_OF = 'https://account.example.test/s/Ab3dE6gH9jK0';

const CHART: ChartState = defaultChartState('chart-1', 'Chart', 'NQZ6.CME', '5m');

const RSI = { id: 'rsi-9', kind: 'rsi', params: {}, visible: true, namespace: 'user' as const, sessionId: null };

function item(kind: SetupKind, code = false): SharedItem {
  return {
    id: 'Ab3dE6gH9jK0',
    url: URL_OF,
    kind,
    title: 'RSI',
    display: {
      name: kind === 'layout' ? 'Scalping desk' : kind === 'template' ? 'Scalp' : 'RSI',
      about: kind === 'indicator' ? 'Indicator' : 'Chart template · 1 indicator',
      lines: [
        { label: 'Length', value: '14' },
        { label: 'Colour', value: '#8ed1fc' },
      ],
      parts: kind === 'template' ? [{ name: 'VWAP', lines: [{ label: 'Bands', value: 'On' }] }] : [],
      code: code ? [{ name: 'My flow', code: 'export default function run() {}' }] : [],
    },
  };
}

function layout(id: string, name: string, revision: number, chart: ChartState = CHART): Layout {
  return {
    id,
    name,
    revision,
    updatedAt: 0,
    activeChartId: chart.tileId,
    dock: null,
    charts: { [chart.tileId]: chart },
    trade: null,
  };
}

function mount(shared: SharedItem, added: ShareAddOutput | null = null) {
  const { client, calls } = answeringClient({
    'share.open': () => shared,
    ...(added ? { 'share.add': () => added } : {}),
  });
  seedTools(['share.open', 'share.add']);
  render(
    <TestRuntime client={client}>
      <TooltipProvider>
        <SharedLinkDialog />
      </TooltipProvider>
    </TestRuntime>,
  );
  return {
    opened: () => calls.filter((c) => c.name === 'share.open').map((c) => c.input),
    adds: () => calls.filter((c) => c.name === 'share.add').map((c) => c.input as ShareAddInput),
  };
}

function paste(target: EventTarget, text: string): void {
  act(() => {
    target.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') } as unknown as DataTransfer,
      }),
    );
  });
}

const dialog = () => document.querySelector('[data-open-flow]');

let stop: () => void = () => undefined;

beforeEach(() => {
  closeOpen();
  patch(layoutsStore, { layouts: { L: layout('L', 'Desk', 1) } });
  setActiveChartRef({ layoutId: 'L', tileId: 'chart-1', source: null });
  patch(templatesStore, { templates: [], followed: {} });
  setWorkspace('L');
  stop = listenForSharedLinks('desk');
});

afterEach(() => {
  stop();
  cleanup();
  document.querySelectorAll('input').forEach((el) => el.remove());
});

describe('what counts as a shared link', () => {
  it('is a /s/ link of twelve letters and digits on a secure origin', () => {
    expect(shareLinkIn(URL_OF)).toBe(URL_OF);
    expect(shareLinkIn(`  ${URL_OF}/ \n`)).toBe(`${URL_OF}/`);
    expect(shareLinkIn('https://share.other.example/s/zzzzzzzzzzzz')).toBe(
      'https://share.other.example/s/zzzzzzzzzzzz',
    );
    expect(shareLinkIn('http://127.0.0.1:8787/s/Ab3dE6gH9jK0')).toBe('http://127.0.0.1:8787/s/Ab3dE6gH9jK0');
    expect(shareLinkIn('http://account.example.test/s/Ab3dE6gH9jK0')).toBeNull();
    expect(shareLinkIn('https://account.example.test/s/Ab3dE6gH9jK')).toBeNull();
    expect(shareLinkIn('https://account.example.test/s/Ab3dE6gH9jK0/image')).toBeNull();
    expect(shareLinkIn(`look ${URL_OF}`)).toBeNull();
    expect(shareLinkIn('NQZ6')).toBeNull();
  });
});

describe('pasting a shared link', () => {
  it('outside a field opens what it holds', async () => {
    const w = mount(item('indicator', true));
    paste(document.body, URL_OF);
    expect(await screen.findByRole('heading', { name: 'Shared indicator' })).toBeTruthy();
    expect(w.opened()).toEqual([{ url: URL_OF }]);
    expect(screen.getByText('RSI')).toBeTruthy();
    expect(screen.getByText('Length')).toBeTruthy();
    expect(screen.getByText('#8ed1fc').querySelector('.sh-swatch')).toBeTruthy();
    expect(screen.getByText('14').querySelector('.sh-swatch')).toBeNull();
    expect(screen.getByText('Brings its own code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to my charts' })).toBeTruthy();
  });

  it('inside a field stays text, and other text is left alone', () => {
    const w = mount(item('indicator'));
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    paste(field, URL_OF);
    paste(document.body, 'NQZ6 looks heavy');
    expect(w.opened()).toEqual([]);
    expect(dialog()).toBeNull();
  });
});

describe('opening a link from the palette', () => {
  it('asks for the link, says plainly when it is not one, and opens one that is', async () => {
    const w = mount(item('template'));
    act(() => askForSharedLink());
    expect(screen.getByRole('heading', { name: 'Open a shared link' })).toBeTruthy();
    const field = screen.getByRole('textbox', { name: 'Link' });
    fireEvent.change(field, { target: { value: 'not a link' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText(NOT_A_LINK)).toBeTruthy();
    expect(w.opened()).toEqual([]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Link' }), { target: { value: URL_OF } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: 'Shared template' })).toBeTruthy();
    expect(w.opened()).toEqual([{ url: URL_OF }]);
  });
});

describe('adding what a link holds', () => {
  it('Add to my charts puts the indicator on the active chart', async () => {
    const after = { ...CHART, layers: [RSI] };
    const w = mount(item('indicator'), { kind: 'indicator', chart: { layoutId: 'L', revision: 2, chart: after } });
    await act(() => openSharedLink(URL_OF));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my charts' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(w.adds()).toEqual([{ url: URL_OF, layoutId: 'L', tileId: 'chart-1' }]);
    expect(read(layoutsStore).layouts.L?.charts['chart-1']?.layers).toEqual([RSI]);
    expect(read(layoutsStore).layouts.L?.revision).toBe(2);
  });

  it('says plainly that an indicator needs a chart when none is open', async () => {
    setActiveChartRef(null);
    patch(layoutsStore, { layouts: {} });
    const w = mount(item('indicator'));
    await act(() => openSharedLink(URL_OF));
    expect(await screen.findByText('Open a chart to add it to.')).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add to my charts' });
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.click(add);
    expect(w.adds()).toEqual([]);
  });

  it('Use this template saves it and puts it on the active chart', async () => {
    const after = { ...CHART, layers: [RSI] };
    const saved = { id: 'scalp-2', name: 'Scalp (2)', layers: [{ kind: 'rsi', params: {}, visible: true }] };
    const w = mount(item('template'), {
      kind: 'template',
      templates: { templates: [saved] },
      templateId: 'scalp-2',
      applied: { layoutId: 'L', revision: 3, chart: after },
    });
    await act(() => openSharedLink(URL_OF));
    fireEvent.click(await screen.findByRole('button', { name: 'Use this template' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(w.adds()).toEqual([{ url: URL_OF, layoutId: 'L', tileId: 'chart-1' }]);
    expect(read(templatesStore).templates).toEqual([saved]);
    expect(read(templatesStore).followed['L/chart-1']).toBe('scalp-2');
    expect(read(layoutsStore).layouts.L?.charts['chart-1']?.layers).toEqual([RSI]);
  });

  it('Use this template only saves it when no chart is open', async () => {
    setActiveChartRef(null);
    patch(layoutsStore, { layouts: {} });
    const saved = { id: 'scalp', name: 'Scalp', layers: [] };
    const w = mount(item('template'), {
      kind: 'template',
      templates: { templates: [saved] },
      templateId: 'scalp',
      applied: null,
    });
    await act(() => openSharedLink(URL_OF));
    expect(await screen.findByText('It’s saved to your templates.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this template' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(w.adds()).toEqual([{ url: URL_OF, layoutId: null, tileId: null }]);
    expect(read(templatesStore).templates).toEqual([saved]);
  });

  it('Use this workspace saves it and switches to it', async () => {
    const fresh = layout('ws-shared', 'Scalping desk', 1);
    const w = mount(item('layout'), { kind: 'layout', layout: fresh });
    await act(() => openSharedLink(URL_OF));
    expect(await screen.findByRole('heading', { name: 'Shared workspace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this workspace' }));
    await waitFor(() => expect(read(uiStore).workspace).toBe('ws-shared'));
    expect(read(layoutsStore).layouts['ws-shared']?.name).toBe('Scalping desk');
    expect(dialog()).toBeNull();
    expect(w.adds()).toEqual([{ url: URL_OF, layoutId: null, tileId: null }]);
  });
});
