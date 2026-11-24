import type { Approval, McpClientInfo, OrderPreview } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalystPanel } from '../src/analyst/AnalystPanel.tsx';
import { analystStore, applyApprovals, EMPTY_ANALYST, setProviders } from '../src/analyst/analystStore.ts';
import { queryClient } from '../src/app/queries.ts';
import { write } from '../src/app/store.ts';
import { ApprovalCard } from '../src/shell/ApprovalCard.tsx';
import { type OcoConfig } from '../src/shell/oco.ts';
import { BRACKET_ON } from './support/oco.ts';
import { tradeSettingsStore } from '../src/state/tradeSettings.ts';
import { DEFAULT_UI, uiStore } from '../src/state/ui.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';

const preview: OrderPreview = {
  request: {
    accountId: 'paper-main',
    instrument: 'NQZ6.CME',
    side: 'buy',
    qty: 1,
    orderType: 'limit',
    limitPrice: 29_600,
    stopPrice: null,
    tif: 'day',
    bracket: null,
    clientOrderId: null,
    reduceOnly: false,
  },
  environment: 'paper',
  restatement: 'BUY 1 NQZ6 LMT 29600 DAY',
  referencePrice: 29_743.25,
  estPrice: 29_600,
  estValue: null,
  estFees: null,
  riskToStop: null,
  buyingPowerAfter: null,
  positionAfter: 1,
  checks: [],
  createdAt: 0,
};

const draft = (over: Partial<Approval> = {}): Approval => ({
  id: 'a_1',
  kind: 'financial',
  status: 'pending',
  origin: { kind: 'external', clientId: 'other' },
  sessionId: null,
  callId: 'c_1',
  tool: 'orders.submit',
  risk: 'financial',
  input: {},
  preview,
  previewHash: 'h1',
  draftId: 'd_1',
  environment: 'paper',
  instrument: 'NQZ6.CME',
  createdAt: Date.now(),
  staleAt: Date.now() + 60_000,
  maxTicks: null,
  ticksSeen: 0,
  resolution: null,
  replacedBy: null,
  replaces: null,
  ...over,
});

const client = (name: string): McpClientInfo => ({
  id: 'other',
  name,
  kind: 'other',
  policy: 'supervised',
  createdAt: 0,
  lastUsedAt: null,
});

function runtime(clients: McpClientInfo[] | null = null) {
  const sent: { method: string; params: unknown }[] = [];
  const fake: FakeClient = {
    request: (method: string, params?: { name?: string }) => {
      sent.push({ method, params });
      if (method === 'tools.invoke' && params?.name === 'mcp.list_clients' && clients)
        return Promise.resolve({ ok: true, status: 'ok', output: { clients } });
      return new Promise(() => undefined);
    },
  };
  return { fake, sent };
}

afterEach(() => {
  cleanup();
  write(analystStore, EMPTY_ANALYST);
  write(uiStore, DEFAULT_UI);
  applyApprovals({ type: 'snapshot', pending: [] });
  queryClient.clear();
  write(tradeSettingsStore, { ...tradeSettingsStore.getState(), lastOco: {} });
});

describe('an agent’s draft that expires', () => {
  const LAID_OUT = { offsetHeight: 600, scrollHeight: 2000 };
  beforeEach(() => {
    for (const [key, px] of Object.entries(LAID_OUT))
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => px });
  });
  afterEach(() => {
    for (const key of Object.keys(LAID_OUT)) Reflect.deleteProperty(HTMLElement.prototype, key);
  });

  it('stays in the analyst saying it expired and was not sent, until the trader dismisses it', () => {
    const { fake, sent } = runtime();
    render(
      <TestRuntime client={fake}>
        <TooltipProvider>
          <AnalystPanel />
        </TooltipProvider>
      </TestRuntime>,
    );
    act(() => applyApprovals({ type: 'snapshot', pending: [draft()] }));
    expect(screen.getByRole('group', { name: 'Draft' }).textContent).toContain('Buy 1 NQ');

    act(() => applyApprovals({ type: 'stale', approval: draft({ status: 'stale' }) }));
    const card = screen.getByRole('group', { name: 'Draft' });
    expect(card.textContent).toContain('Buy 1 NQ');
    expect(card.textContent).toContain('Expired');
    expect(card.textContent).toContain('Not sent');
    expect(within(card).queryByRole('button', { name: /^Approve/ })).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('group', { name: 'Draft' })).toBeNull();
    expect(sent.filter((s) => s.method === 'approvals.resolve')).toEqual([]);
  });

  it('reads expired as soon as the runtime says so, though its clock time is not up', () => {
    const { fake } = runtime();
    render(
      <TestRuntime client={fake}>
        <ApprovalCard
          approval={draft({ status: 'stale', staleAt: Date.now() + 30_000 })}
          more={0}
          sessionTitle={null}
        />
      </TestRuntime>,
    );
    const card = screen.getByRole('group', { name: 'Draft' });
    expect(card.textContent).toContain('Expired');
    expect(card.textContent).not.toContain('left');
  });
});

describe('who drafted it', () => {
  const mount = (clients: McpClientInfo[] | null) => {
    const { fake } = runtime(clients);
    render(
      <TestRuntime client={fake}>
        <ApprovalCard approval={draft()} more={0} sessionTitle={null} />
      </TestRuntime>,
    );
  };

  it('names an MCP client by the name the trader knows it by', async () => {
    mount([client('Scalp bot')]);
    expect(await screen.findByText(/^Drafted by Scalp bot/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bother\b/);
  });

  it('says an MCP client drafted it, never its internal id, while its name is unknown', () => {
    mount(null);
    expect(screen.getByText(/^Drafted by an MCP client/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bother\b/);
  });

  it('says the analyst drafted it, without the provider’s id', () => {
    const { fake } = runtime();
    render(
      <TestRuntime client={fake}>
        <ApprovalCard
          approval={draft({ origin: { kind: 'agent', sessionId: 's_1', provider: 'claude-code' }, sessionId: 's_1' })}
          more={0}
          sessionTitle={null}
        />
      </TestRuntime>,
    );
    expect(screen.getByText(/^Drafted by the analyst/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('claude-code');
  });
});

describe('the analyst’s composer', () => {
  const panel = () => {
    const { fake } = runtime();
    return render(
      <TestRuntime client={fake}>
        <TooltipProvider>
          <AnalystPanel />
        </TooltipProvider>
      </TestRuntime>,
    );
  };

  it('offers typed orders only when a model can take them', () => {
    panel();
    const box = screen.getByRole('textbox', { name: 'Ask the analyst' });
    expect(box.getAttribute('placeholder')).not.toMatch(/order/i);
    act(() =>
      setProviders([
        {
          providerId: 'codex',
          kind: 'agent',
          displayName: 'Codex',
          status: 'ok',
          latencyMs: null,
          lastMessageAt: null,
          message: null,
          checkedAt: 0,
        },
      ]),
    );
    expect(box.getAttribute('placeholder')).toBe('Ask, or type an order');
  });
});

describe('approving an agent’s entry', () => {
  const input = {
    accountId: 'paper-main',
    instrument: 'NQ',
    side: 'buy',
    qty: 1,
    orderType: 'limit',
    limitPrice: 29_600,
  };
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'performance',
        'Date',
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  let n = 0;
  const approveWith = (drafted: Approval, oco: OcoConfig = BRACKET_ON) => {
    const a = { ...drafted, id: `a_entry_${String(++n)}` };
    write(tradeSettingsStore, { ...tradeSettingsStore.getState(), lastOco: { 'paper-main|NQ': oco } });
    const { fake, sent } = runtime();
    const { container } = render(
      <TestRuntime client={fake}>
        <ApprovalCard approval={a} more={0} sessionTitle={null} />
      </TestRuntime>,
    );
    const card = container.textContent;
    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(screen.getByRole('button', { name: 'Approve on paper' }));
    const resolved = sent.filter((x) => x.method === 'approvals.resolve').map((x) => x.params);
    return { card, by: container.querySelector('.by')?.textContent, resolved };
  };

  it('carries the ticket’s bracket: the card shows its stop and target, and Approve sends them', () => {
    const { card, by, resolved } = approveWith(draft({ input }));
    expect(card).toContain('Stop29,590.00−$200');
    expect(card).toContain('Target29,620.00');
    expect(by).toBe('Drafted by an MCP client · stop and target from your bracket');
    expect(resolved).toMatchObject([
      {
        decision: 'approve',
        previewHash: 'h1',
        input: { ...input, bracket: { stopLoss: 29_590, takeProfit: 29_620 } },
      },
    ]);
  });

  it('carries a market entry’s stop and target as ticks from its fill, as the ticket’s Buy market sends them', () => {
    const { limitPrice: _limit, ...atMarket } = input;
    const market = { ...atMarket, orderType: 'market' };
    const { card, resolved } = approveWith(
      draft({
        input: market,
        preview: { ...preview, request: { ...preview.request, orderType: 'market', limitPrice: null } },
      }),
    );
    expect(card).toContain('Stop40 ticks from the fill−$200');
    expect(card).toContain('Target80 ticks from the fill');
    expect(resolved).toMatchObject([
      { input: { orderType: 'market', bracket: { stopLoss: null, takeProfit: null, stopTicks: 40, targetTicks: 80 } } },
    ]);
  });

  it('carries the ticket’s breakeven and trailing with its stop', () => {
    const oco: OcoConfig = {
      ...BRACKET_ON,
      breakeven: { on: true, trigger: 20, offset: 1 },
      trail: { on: true, ticks: 12, trigger: 24, step: 2 },
    };
    const { resolved } = approveWith(draft({ input }), oco);
    expect(resolved).toMatchObject([
      {
        input: {
          bracket: {
            stopLoss: 29_590,
            takeProfit: 29_620,
            breakeven: { triggerTicks: 20, offsetTicks: 1 },
            trail: { distanceTicks: 12, triggerTicks: 24, stepTicks: 2 },
          },
        },
      },
    ]);
  });

  it('says plainly there is no stop and no target when the ticket’s bracket is off, and sends the draft as is', () => {
    const { card, by, resolved } = approveWith(draft({ input }), { ...BRACKET_ON, on: false });
    expect(card).toContain('StopNoneTargetNone');
    expect(by).toBe('Drafted by an MCP client');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).not.toHaveProperty('input');
  });

  it('names the leg it lacks when the ticket’s bracket has only a stop', () => {
    const { card, resolved } = approveWith(draft({ input }), {
      ...BRACKET_ON,
      target: { ...BRACKET_ON.target, on: false },
    });
    expect(card).toContain('Stop29,590.00−$200');
    expect(card).toContain('TargetNone');
    expect(resolved).toMatchObject([{ input: { bracket: { stopLoss: 29_590, takeProfit: null } } }]);
  });

  it('keeps the agent’s own stop and target, and fills only the leg it left out', () => {
    const own = (bracket: OrderPreview['request']['bracket']) =>
      draft({ input: { ...input, bracket }, preview: { ...preview, request: { ...preview.request, bracket } } });
    const both = approveWith(own({ stopLoss: 29_580, takeProfit: 29_650 }));
    expect(both.card).toContain('Stop29,580.00');
    expect(both.card).toContain('Target29,650.00');
    expect(both.by).toBe('Drafted by an MCP client');
    expect(both.resolved[0]).not.toHaveProperty('input');
    cleanup();

    const stopOnly = approveWith(own({ stopLoss: 29_580, takeProfit: null }));
    expect(stopOnly.by).toBe('Drafted by an MCP client · target from your bracket');
    expect(stopOnly.resolved).toMatchObject([{ input: { bracket: { stopLoss: 29_580, takeProfit: 29_620 } } }]);
  });

  it('adds nothing to a draft that closes the position', () => {
    const exit = draft({
      input: { ...input, side: 'sell' },
      preview: { ...preview, request: { ...preview.request, side: 'sell' }, positionAfter: 0 },
    });
    const { card, resolved } = approveWith(exit);
    expect(card).not.toContain('Stop');
    expect(card).not.toContain('None');
    expect(resolved[0]).not.toHaveProperty('input');
  });
});
