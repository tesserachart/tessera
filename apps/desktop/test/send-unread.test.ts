import type { OrderInput } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { cancelOrder, submitOrder } from '../src/shell/tradeActions.ts';
import { wireOrder } from './support/orders.ts';
import { setTestServices } from './support/runtime.tsx';

const input: OrderInput = {
  accountId: 'paper-main',
  instrument: 'NQZ6.CME',
  side: 'buy',
  qty: 1,
  orderType: 'market',
};

function runtime(answer: { output?: unknown; error?: { code: string; message: string } }) {
  const request = vi
    .fn()
    .mockResolvedValue(
      answer.error
        ? { callId: 'c1', status: 'error', ok: false, error: { ...answer.error, details: null, retryable: false } }
        : { callId: 'c1', status: 'ok', ok: true, output: answer.output },
    );
  setTestServices({ request });
}

describe('an order whose answer cannot be read', () => {
  it('is said as sent, never as failed: it went, and sending it again would double it', async () => {
    runtime({ output: { order: { status: 'filled' }, bracket: [] } });
    const r = await submitOrder('paper', input, 'Buy 1 NQ Z6 at market', 2);
    expect(r.tone).toBe('info');
    expect(r.text).toBe('Buy 1 NQ Z6 at market: sent, but its answer could not be read. Orders shows it.');
  });

  it('a refusal is still a failure in the runtime’s words, and a readable answer says what happened', async () => {
    runtime({ error: { code: 'rejected', message: 'orders.submit: the account is closed' } });
    expect(await submitOrder('paper', input, 'Buy 1 NQ Z6 at market', 2)).toMatchObject({
      tone: 'err',
      text: 'orders.submit: the account is closed',
      what: 'Buy 1 NQ Z6 at market',
    });
    const order = wireOrder({ status: 'filled', avgFillPrice: 20_630.25 });
    runtime({ output: { order, bracket: [] } });
    expect(await submitOrder('paper', input, 'Buy 1 NQ Z6 at market', 2)).toMatchObject({
      tone: 'ok',
      text: 'Buy 1 NQ Z6 at market: filled at 20,630.25',
    });
  });

  it('holds for every send, an exit as much as an entry', async () => {
    runtime({ output: { order: {} } });
    const r = await cancelOrder(wireOrder());
    expect(r.tone).toBe('info');
    expect(r.text).toContain('sent, but its answer could not be read');
  });
});
