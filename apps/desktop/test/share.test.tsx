import type {
  AccountState,
  AgentSessionSummary,
  ConnectionState,
  HelloResult,
  Layout,
  ShareChartInput,
  ShareConversationInput,
  SharedConversation,
  ShareLink,
  ShareListOutput,
  ShareSetupInput,
  ToolName,
} from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySessions } from '../src/analyst/analystStore.ts';
import { SessionList } from '../src/areas/agents/SessionList.tsx';
import { SharesSection } from '../src/areas/settings/categories/Shares.tsx';
import { patch } from '../src/app/store.ts';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry } from '../src/commands/registry.ts';
import { registerBuiltinWindowCommands } from '../src/commands/windowCommands.ts';
import type * as Capture from '../src/feedback/capture.ts';
import { captureWindow } from '../src/feedback/capture.ts';
import { DARK_INK, inkOn, LIGHT_INK, markBox, stampMark, WORDMARK_VIEWBOX } from '../src/share/mark.ts';
import { canShare, CHART_CANVAS_ATTR, NOTHING_SHARED, sharedOnWords, shareRowWords } from '../src/share/model.ts';
import { ShareDialog } from '../src/share/ShareDialog.tsx';
import { quietWhileSharing, TRADING_STATE_ATTR } from '../src/share/quiet.ts';
import { shareCustomIndicator, shareIndicator, shareTemplate, shareWorkspace } from '../src/share/setup.ts';
import { closeShare, shareChart, shareConversation } from '../src/share/store.ts';
import {
  IN_THE_PICTURE,
  ITS_CODE,
  LEFT_OUT_OF_CONVERSATION,
  NOTHING_SHARED_YET,
  SETTINGS_ONLY,
  THEIR_CODE,
} from '../src/share/words.ts';
import { defaultChartState, layoutsStore } from '../src/state/layouts.ts';
import { answeringClient, CONNECTED, seedTools, TestRuntime, topicFeed } from './support/runtime.tsx';

vi.mock('../src/feedback/capture.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Capture>();
  return {
    ...real,
    captureWindow: vi.fn(() =>
      Promise.resolve({
        type: 'image/png',
        data: 'iVBORw0KGgo=',
        preview: 'data:image/png;base64,iVBORw0KGgo=',
        width: 1600,
        height: 900,
        bytes: 9,
      }),
    ),
  };
});

const LINK: ShareLink = {
  id: 'Ab3dE6gH9jK2',
  url: 'https://account.example.test/s/Ab3dE6gH9jK2',
  kind: 'chart',
  title: 'NQZ6.CME · 5m',
  createdAt: '2026-11-23T10:00:00.000Z',
};

const SIGNED_IN: AccountState = {
  phase: 'signed_in',
  user: { email: 'trader@example.test', name: null },
  access: 'full',
  entitlements: ['share'],
  verifiedAt: null,
  checking: false,
  offline: false,
  signingIn: false,
  problem: null,
};

const SIGNED_OUT: AccountState = { ...SIGNED_IN, phase: 'signed_out', user: null, entitlements: [] };

const TARGET = { layoutId: 'L', tileId: 'chart-1' };

const PAGE: SharedConversation = {
  v: 1,
  title: 'Where NQ found buyers',
  amounts: false,
  turns: [
    { role: 'user', text: 'Where did NQ find buyers this morning?', files: 2 },
    {
      role: 'analyst',
      work: [
        { ns: 'market', label: 'Read bars', meta: '1.2s', failed: false },
        { ns: 'portfolio', label: 'Read positions', meta: null, failed: true },
      ],
      workedMs: 12_000,
      answer: 'Buyers stepped in at **21,450.25**, up [amount] today.',
      blocks: [{ kind: 'measured', title: 'Volume', text: 'Heavy at the low', rows: [['Volume', '12,400']] }],
    },
  ],
};

function seedChart(): void {
  const layout: Layout = {
    id: 'L',
    name: 'Scalping desk',
    revision: 1,
    updatedAt: 0,
    activeChartId: 'chart-1',
    dock: null,
    charts: {
      'chart-1': {
        ...defaultChartState('chart-1', 'Chart', 'NQZ6.CME', '5m'),
        layers: [
          { id: 'rsi-1', kind: 'rsi', params: {}, visible: true, namespace: 'user', sessionId: null },
          {
            id: 'custom-1',
            kind: 'custom',
            params: { indicator: 'ci_1' },
            visible: true,
            namespace: 'user',
            sessionId: null,
          },
        ],
      },
    },
    trade: null,
  };
  patch(layoutsStore, { layouts: { L: layout } });
}

type Answers = Parameters<typeof answeringClient>[0];

function signedClient(answers: Answers, account: AccountState) {
  const { client, calls } = answeringClient(answers);
  const conn: ConnectionState = {
    ...CONNECTED,
    server: { capabilities: { topics: ['account'] } } as unknown as HelloResult,
  };
  return {
    client: {
      ...client,
      state: { getSnapshot: () => conn, subscribe: () => () => undefined },
      subscribe: topicFeed({ account: [account] }).subscribe,
    },
    calls,
  };
}

function mount(answers: Answers = {}, account: AccountState = SIGNED_IN) {
  const { client, calls } = signedClient({ 'share.chart': () => LINK, ...answers }, account);
  seedTools([
    'share.chart',
    'share.list',
    'share.delete',
    'share.preview_conversation',
    'share.conversation',
    'share.setup',
  ]);
  render(
    <TestRuntime client={client}>
      <TooltipProvider>
        <ShareDialog />
      </TooltipProvider>
    </TestRuntime>,
  );
  const inputs = <T,>(name: ToolName) => calls.filter((c) => c.name === name).map((c) => c.input as T);
  return {
    shared: () => inputs<ShareChartInput>('share.chart'),
    previews: () => inputs<ShareConversationInput>('share.preview_conversation'),
    conversations: () => inputs<ShareConversationInput>('share.conversation'),
    setups: () => inputs<ShareSetupInput>('share.setup'),
  };
}

function canvas(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(CHART_CANVAS_ATTR, 'chart-1');
  document.body.appendChild(el);
  return el;
}

const dialog = () => document.querySelector('[data-share-flow]');

beforeEach(() => {
  closeShare();
  seedChart();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.querySelectorAll(`[${CHART_CANVAS_ATTR}]`).forEach((el) => el.remove());
});

describe('sharing a chart', () => {
  it('shows the picture with its mark first and makes a link only on Create link, then Done closes it', async () => {
    const el = canvas();
    const w = mount();
    await act(() => shareChart(TARGET));
    expect(await screen.findByText(NOTHING_SHARED_YET)).toBeTruthy();
    expect(screen.getByText(IN_THE_PICTURE)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Share chart' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'The picture of the chart that is shared' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Link' })).toBeNull();
    expect(w.shared()).toEqual([]);
    const call = vi.mocked(captureWindow).mock.lastCall;
    expect(call?.[1]).toBe(el);
    expect(call?.[2]).toEqual(expect.arrayContaining([`[${TRADING_STATE_ATTR}]`, '[role="toolbar"]']));
    expect(call?.[3]).toBe(stampMark);

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByDisplayValue(LINK.url)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(w.shared()).toEqual([
      {
        image: { type: 'image/png', data: 'iVBORw0KGgo=', width: 1600, height: 900 },
        instrument: 'NQZ6.CME',
        timeframe: '5m',
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(dialog()).toBeNull();
  });

  it('copies the picture as a PNG signed out, and offers no link', async () => {
    canvas();
    const w = mount({}, SIGNED_OUT);
    const written: ClipboardItem[][] = [];
    vi.spyOn(navigator.clipboard, 'write').mockImplementation((items) => {
      written.push([...items]);
      return Promise.resolve();
    });
    await act(() => shareChart(TARGET));
    expect(await screen.findByText(IN_THE_PICTURE)).toBeTruthy();
    expect(screen.queryByText(NOTHING_SHARED_YET)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy picture' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(written).toHaveLength(1);
    const [item] = written[0]!;
    expect(item?.types).toEqual(['image/png']);
    expect((await item!.getType('image/png')).type).toBe('image/png');
    expect(w.shared()).toEqual([]);
  });

  it('hides the chart’s orders, positions and countdown only while it is pictured', async () => {
    canvas();
    mount();
    const events: string[] = [];
    const off = quietWhileSharing(TARGET.tileId, () => {
      events.push('quiet');
      return () => events.push('restored');
    });
    vi.mocked(captureWindow).mockImplementationOnce(() => {
      events.push('pictured');
      return Promise.resolve({ type: 'image/png', data: 'iVBORw0KGgo=', preview: '', width: 10, height: 10, bytes: 9 });
    });
    await act(() => shareChart(TARGET));
    off();
    expect(events).toEqual(['quiet', 'pictured', 'restored']);
  });

  it('cancels before a link exists and sends nothing', async () => {
    canvas();
    const w = mount();
    await act(() => shareChart(TARGET));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    expect(w.shared()).toEqual([]);
  });

  it('says so in plain words when the chart is not on screen, and sends nothing', async () => {
    const w = mount();
    await act(() => shareChart(TARGET));
    expect(await screen.findByText('This chart isn’t on screen. Show it, then share again.')).toBeTruthy();
    expect(w.shared()).toEqual([]);
  });

  it('drops a share closed before its picture is taken', async () => {
    canvas();
    const w = mount();
    let taken: () => void = () => undefined;
    vi.mocked(captureWindow).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          taken = () =>
            resolve({ type: 'image/png', data: 'iVBORw0KGgo=', preview: '', width: 10, height: 10, bytes: 9 });
        }),
    );
    const running = shareChart(TARGET);
    act(() => closeShare());
    taken();
    await act(() => running);
    expect(w.shared()).toEqual([]);
    expect(dialog()).toBeNull();
  });
});

describe('sharing a conversation', () => {
  it('previews the page read-only, re-previews with P/L, and shares what was previewed', async () => {
    const w = mount({
      'share.preview_conversation': (input) => ({ ...PAGE, amounts: input.showPnl }),
      'share.conversation': () => ({ ...LINK, kind: 'conversation', title: PAGE.title }),
    });
    await act(() => shareConversation('S15'));
    expect(await screen.findByText(PAGE.title)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Share conversation' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'The conversation as it is shared' })).toBeTruthy();
    expect(screen.getByText('Where did NQ find buyers this morning?')).toBeTruthy();
    expect(screen.getByText('2 attachments left out')).toBeTruthy();
    expect(screen.getByText('Worked for 12.0s · 2 steps')).toBeTruthy();
    expect(screen.getByText('Read bars')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('21,450.25')).toBeTruthy();
    expect(screen.getByText('Heavy at the low')).toBeTruthy();
    expect(screen.getByText(LEFT_OUT_OF_CONVERSATION)).toBeTruthy();
    expect(w.previews()).toEqual([{ sessionId: 'S15', showPnl: false }]);

    const pnl = screen.getByRole('switch', { name: 'Show P/L' });
    expect(pnl.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(pnl);
    await waitFor(() =>
      expect(w.previews()).toEqual([
        { sessionId: 'S15', showPnl: false },
        { sessionId: 'S15', showPnl: true },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create link' }).hasAttribute('disabled')).toBe(false),
    );
    expect(screen.getByRole('switch', { name: 'Show P/L' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByDisplayValue(LINK.url)).toBeTruthy();
    expect(w.conversations()).toEqual([{ sessionId: 'S15', showPnl: true }]);
    expect(screen.queryByRole('switch', { name: 'Show P/L' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(dialog()).toBeNull();
  });

  it('says a failure in plain words and keeps the runtime’s text in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mount({
      'share.preview_conversation': () => PAGE,
      'share.conversation': () => {
        throw new Error('internal: tessera_store::open failed');
      },
    });
    await act(() => shareConversation('S15'));
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('The conversation couldn’t be shared. Try again in a moment.')).toBeTruthy();
    expect(warn.mock.calls.flat().join('\n')).toContain('tessera_store::open failed');
  });
});

describe('sharing an indicator, a template or a workspace', () => {
  it('names the indicator, says only its settings go and that its code is on the page', async () => {
    const w = mount({ 'share.setup': () => ({ ...LINK, kind: 'indicator', title: 'My flow' }) });
    await act(() => shareIndicator(TARGET, { id: 'custom-1', kind: 'custom' }, 'My flow'));
    expect(await screen.findByRole('heading', { name: 'Share indicator' })).toBeTruthy();
    expect(screen.getByText('My flow')).toBeTruthy();
    expect(screen.getByText(SETTINGS_ONLY)).toBeTruthy();
    expect(screen.getByText(ITS_CODE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByDisplayValue(LINK.url)).toBeTruthy();
    expect(w.setups()).toEqual([{ kind: 'indicator', layoutId: 'L', tileId: 'chart-1', layerId: 'custom-1' }]);
  });

  it('shares a built-in indicator without a code line, and a custom one by its id', async () => {
    const w = mount({ 'share.setup': () => LINK });
    await act(() => shareIndicator(TARGET, { id: 'rsi-1', kind: 'rsi' }, 'RSI 14'));
    expect(await screen.findByText('RSI 14')).toBeTruthy();
    expect(screen.queryByText(ITS_CODE)).toBeNull();
    act(() => closeShare());
    await act(() =>
      shareCustomIndicator({ id: 'ci_1', spec: { title: 'My flow' } } as Parameters<typeof shareCustomIndicator>[0]),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    await screen.findByDisplayValue(LINK.url);
    expect(w.setups()).toEqual([{ kind: 'custom_indicator', id: 'ci_1' }]);
  });

  it('shares a template and a workspace by id, saying when their custom indicators’ code is on the page', async () => {
    const w = mount({ 'share.setup': () => LINK });
    await act(() =>
      shareTemplate({ id: 'scalp', name: 'Scalp', layers: [{ kind: 'ema', params: {}, visible: true }] }),
    );
    expect(await screen.findByRole('heading', { name: 'Share template' })).toBeTruthy();
    expect(screen.getByText('Scalp')).toBeTruthy();
    expect(screen.queryByText(THEIR_CODE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByDisplayValue(LINK.url);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await act(() => shareWorkspace('L', 'Scalping desk'));
    expect(await screen.findByRole('heading', { name: 'Share workspace' })).toBeTruthy();
    expect(screen.getByText(THEIR_CODE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByDisplayValue(LINK.url);
    expect(w.setups()).toEqual([
      { kind: 'template', id: 'scalp' },
      { kind: 'layout', layoutId: 'L' },
    ]);
  });
});

describe('Share conversation… in a session’s menu', () => {
  const SESSION: AgentSessionSummary = {
    id: 'S15',
    title: 'ORB plan',
    preset: 'Trader',
    provider: 'codex',
    model: 'gpt-5',
    mode: 'supervised',
    status: 'idle',
    origin: { kind: 'agent', sessionId: 'S15', provider: 'codex' },
    sourceLabel: null,
    createdAt: 0,
    updatedAt: 0,
  };

  function list(account: AccountState) {
    act(() => applySessions({ type: 'snapshot', sessions: [SESSION] }));
    const { client, calls } = signedClient({ 'share.preview_conversation': () => PAGE }, account);
    seedTools(['share.preview_conversation', 'share.conversation']);
    render(
      <TestRuntime client={client}>
        <TooltipProvider>
          <SessionList />
          <ShareDialog />
        </TooltipProvider>
      </TestRuntime>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'ORB plan: more' }), { key: 'Enter' });
    return calls;
  }

  it('opens the conversation’s preview when sharing is on', async () => {
    const calls = list(SIGNED_IN);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share conversation…' }));
    expect(await screen.findByText(PAGE.title)).toBeTruthy();
    expect(calls.filter((c) => c.name === 'share.preview_conversation').map((c) => c.input)).toEqual([
      { sessionId: 'S15', showPnl: false },
    ]);
  });

  it('is not there signed out', async () => {
    list(SIGNED_OUT);
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Share conversation…' })).toBeNull();
  });
});

describe('the share command', () => {
  it('is Share chart… on ⌘⇧S in the main window and in pop-outs', () => {
    const main = new CommandRegistry();
    const offMain = registerBuiltinCommands(main, { runtime: true, focusComposer: () => undefined });
    const popout = new CommandRegistry();
    const offPopout = registerBuiltinWindowCommands(popout);
    for (const registry of [main, popout]) {
      expect(registry.get('chart.share')?.title).toBe('Share chart…');
      expect(registry.get('chart.share')?.shortcut).toBe('mod+shift+s');
    }
    const shortcuts = main.all().flatMap((c) => (c.shortcut ? [c.shortcut] : []));
    expect(shortcuts.filter((s) => s === 'mod+shift+s')).toHaveLength(1);
    expect(main.get('share.openLink')?.title).toBe('Open a shared link…');
    offMain();
    offPopout();
  });
});

describe('who can share', () => {
  it('is a signed-in account with access on a Cloud that offers sharing', () => {
    expect(canShare(SIGNED_IN)).toBe(true);
    expect(canShare(null)).toBe(false);
    expect(canShare({ ...SIGNED_IN, entitlements: [] })).toBe(false);
    expect(canShare({ ...SIGNED_IN, access: 'pending' })).toBe(false);
    expect(canShare(SIGNED_OUT)).toBe(false);
  });
});

describe('when a link was shared', () => {
  it('reads in the display zone, with the year only when it is not this one', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    expect(sharedOnWords('2026-11-23T10:00:00.000Z', 'America/New_York', now)).toBe('Nov 23, 05:00');
    expect(sharedOnWords('2025-03-01T10:00:00.000Z', 'UTC', now)).toBe('Mar 1, 2025, 10:00');
    expect(sharedOnWords('not a date', 'UTC', now)).toBe('');
  });

  it('says what kind of thing each link is', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    expect(shareRowWords({ ...LINK, kind: 'conversation' }, 'UTC', now)).toBe('Conversation · Shared Nov 23, 10:00');
    expect(shareRowWords({ ...LINK, kind: 'layout' }, 'UTC', now)).toBe('Workspace · Shared Nov 23, 10:00');
    expect(shareRowWords({ ...LINK, kind: 'something new' }, 'UTC', now)).toBe('Shared Nov 23, 10:00');
  });
});

describe('Settings › App › Shares', () => {
  function shares(list: ShareListOutput) {
    const { client } = signedClient({ 'share.list': () => list }, SIGNED_IN);
    seedTools(['share.list', 'share.delete']);
    render(
      <TestRuntime client={client}>
        <TooltipProvider>
          <SharesSection />
        </TooltipProvider>
      </TestRuntime>,
    );
  }

  it('says each link’s kind', async () => {
    shares({
      available: true,
      shares: [
        { ...LINK, id: 'a', title: 'NQ · 5m' },
        { ...LINK, id: 'b', kind: 'conversation', title: 'Where NQ found buyers' },
        { ...LINK, id: 'c', kind: 'indicator', title: 'RSI 14' },
        { ...LINK, id: 'd', kind: 'template', title: 'Scalp' },
        { ...LINK, id: 'e', kind: 'layout', title: 'Scalping desk' },
      ],
    });
    await screen.findByText('Where NQ found buyers');
    const help = (id: string) => document.querySelector(`[data-share-id="${id}"]`)?.textContent ?? '';
    expect(help('a')).toContain('Chart · Shared');
    expect(help('b')).toContain('Conversation · Shared');
    expect(help('c')).toContain('Indicator · Shared');
    expect(help('d')).toContain('Template · Shared');
    expect(help('e')).toContain('Workspace · Shared');
  });

  it('says where to share from when nothing is shared yet', async () => {
    shares({ available: true, shares: [] });
    expect(await screen.findByText(NOTHING_SHARED)).toBeTruthy();
  });
});

describe('the Tessera mark on a picture', () => {
  it('matches the wordmark’s own proportions', () => {
    const svg = readFileSync(join(import.meta.dirname, '../../../packages/ui/brand/wordmark-text.svg'), 'utf8');
    expect(/viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)?.slice(1).map(Number)).toEqual([
      WORDMARK_VIEWBOX.width,
      WORDMARK_VIEWBOX.height,
    ]);
  });

  it('sits small in the bottom-right corner and scales with the picture', () => {
    const one = markBox(1600, 900, 1);
    expect(one.height).toBe(14);
    expect(one.x + one.width).toBe(1600 - one.height);
    expect(one.y + one.height).toBe(900 - one.height);
    const two = markBox(3200, 1800, 2);
    expect(two.height).toBe(28);
    expect(Math.abs(two.width - one.width * 2)).toBeLessThanOrEqual(1);
    expect(markBox(400, 300, 1).height).toBe(9);
  });

  it('is light on a dark chart and dark on a light one', () => {
    expect(inkOn([12, 30, 34, 255, 10, 28, 30, 255])).toBe(LIGHT_INK);
    expect(inkOn([250, 250, 248, 255, 240, 242, 240, 255])).toBe(DARK_INK);
  });
});
