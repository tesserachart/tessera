import { describe, expect, it, vi } from 'vitest';
import { chartToasts, noteOnChart } from '../src/chart/chartNotice.ts';
import { noticeLine, noticeWords, withoutAccount } from '../src/shell/noticeWords.ts';

const review = vi.hoisted(() => ({ loaded: false, revealApproval: vi.fn() }));
vi.mock('../src/analyst/review.ts', () => {
  review.loaded = true;
  return { revealApproval: review.revealApproval };
});

describe('an outcome in a toast’s words', () => {
  it('leads with what happened, the order under it', () => {
    expect(
      noticeWords({
        tone: 'ok',
        text: 'Buy 2 NQ Z6 limit 20,630.75 · SL 20,625.25 · TP 20,641.75: working',
        what: 'Buy 2 NQ Z6 limit 20,630.75 · SL 20,625.25 · TP 20,641.75',
      }),
    ).toEqual({ title: 'Working', detail: 'Buy 2 NQ Z6 limit 20,630.75 · SL 20,625.25 · TP 20,641.75' });
    expect(
      noticeWords({ tone: 'ok', text: 'Buy 1 NQ Z6 at market: filled at 20,639.25', what: 'Buy 1 NQ Z6 at market' }),
    ).toEqual({ title: 'Filled at 20,639.25', detail: 'Buy 1 NQ Z6 at market' });
    expect(
      noticeWords({
        tone: 'info',
        text: 'Sell 1 NQ Z6 limit 20,700.00: drafted, approve it on the card',
        what: 'Sell 1 NQ Z6 limit 20,700.00',
      }),
    ).toEqual({ title: 'Drafted, approve it on the card', detail: 'Sell 1 NQ Z6 limit 20,700.00' });
  });

  it('says a refusal as Not sent over why, without the account in play', () => {
    const refusal = { tone: 'err' as const, text: 'Paper (Tessera Paper): QQQ is closed. Opens 04:00. Nothing sent.' };
    expect(noticeWords(refusal, 'Paper')).toEqual({ title: 'Not sent', detail: 'QQQ is closed. Opens 04:00' });
    expect(noticeWords(refusal, 'Eval 50K').detail).toBe('Paper (Tessera Paper): QQQ is closed. Opens 04:00');
    expect(noticeWords(refusal)).toEqual({
      title: 'Not sent',
      detail: 'Paper (Tessera Paper): QQQ is closed. Opens 04:00',
    });
    expect(
      noticeWords({
        tone: 'err',
        text: 'Buy 1 NQ Z6 at market: stop above the entry. Nothing sent.',
        what: 'Buy 1 NQ Z6 at market',
      }),
    ).toEqual({ title: 'Not sent', detail: 'Stop above the entry' });
    expect(noticeWords({ tone: 'err', text: 'Nothing sent.' })).toEqual({ title: 'Not sent', detail: null });
  });

  it('says any other failure as it is, without the account', () => {
    expect(noticeWords({ tone: 'err', text: 'Eval 50K (Tessera Paper): Flatten failed' }, 'Eval 50K')).toEqual({
      title: 'Flatten failed',
      detail: null,
    });
    expect(
      noticeWords({ tone: 'err', text: 'Buy 1 NQ Z6 at market: rejected', what: 'Buy 1 NQ Z6 at market' }),
    ).toEqual({ title: 'Rejected', detail: 'Buy 1 NQ Z6 at market' });
  });

  it('says a lost entry first, then why its send was refused', () => {
    expect(
      noticeWords(
        {
          tone: 'err',
          text: 'Paper (Tessera Paper): QQQ is closed. Opens 04:00. Nothing sent.',
          what: 'Stop 486.00 on QQQ',
          head: 'The entry was cancelled: send it again',
        },
        'Paper',
      ),
    ).toEqual({ title: 'The entry was cancelled: send it again', detail: 'QQQ is closed. Opens 04:00' });
    expect(
      noticeWords({
        tone: 'err',
        text: 'Stop 486.00 on QQQ: rejected',
        what: 'Stop 486.00 on QQQ',
        head: 'The entry was cancelled: send it again',
      }).detail,
    ).toBe('Rejected: Stop 486.00 on QQQ');
  });

  it('splits what stays from what happened, and keeps a short outcome whole', () => {
    expect(noticeWords({ tone: 'ok', text: 'Cancelled 2 NQ Z6; the position’s stop and target stay' })).toEqual({
      title: 'Cancelled 2 NQ Z6',
      detail: 'The position’s stop and target stay',
    });
    expect(noticeWords({ tone: 'ok', text: 'Flat NQ Z6' })).toEqual({ title: 'Flat NQ Z6', detail: null });
    expect(noticeWords({ tone: 'ok', text: 'Saved the template My NQ flow' })).toEqual({
      title: 'Saved the template My NQ flow',
      detail: null,
    });
  });

  it('puts both on one line for a strip', () => {
    const refusal = { tone: 'err' as const, text: 'Paper (Tessera Paper): QQQ is closed. Opens 04:00. Nothing sent.' };
    expect(noticeLine(refusal, 'Paper')).toBe('Not sent: QQQ is closed. Opens 04:00');
    expect(noticeLine({ tone: 'err', text: 'Cancel failed' }, 'Paper')).toBe('Cancel failed');
  });
});

describe('the account the runtime names first', () => {
  it('goes when it is the account in play, and only that one', () => {
    expect(withoutAccount('Eval 50K (Tessera Paper): Refused by risk: $4,600 at the stop', 'Eval 50K')).toBe(
      'Refused by risk: $4,600 at the stop',
    );
    expect(withoutAccount('Eval 50K: no such order', 'Eval 50K')).toBe('no such order');
    expect(withoutAccount('Eval 50K (Tessera Paper): x', 'Other')).toBe('Eval 50K (Tessera Paper): x');
    expect(withoutAccount('Eval 50K (Tessera Paper): x', null)).toBe('Eval 50K (Tessera Paper): x');
    expect(withoutAccount('TEST-1 (Apex · Rithmic) has no MNQ Dec 2026', 'TEST-1')).toBe(
      'This account has no MNQ Dec 2026',
    );
    expect(withoutAccount('A.B (x): y', 'A.B')).toBe('y');
    expect(withoutAccount('AxB (x): y', 'A.B')).toBe('AxB (x): y');
  });
});

describe('a chart’s toasts', () => {
  const chart = { layoutId: 'L', tileId: 'chart-1' };
  const standing = () =>
    chartToasts(chart)
      .getSnapshot()
      .filter((t) => t.state === 'open');

  it('shares outcomes across charts in the shell lane, with Retry on a refused exit', () => {
    noteOnChart(chart, {
      tone: 'ok',
      text: 'Buy 1 NQ Z6 at market: filled at 20,639.25',
      what: 'Buy 1 NQ Z6 at market',
    });
    expect(standing().map((t) => [t.tone, t.title, t.detail])).toEqual([
      ['ok', 'Filled at 20,639.25', 'Buy 1 NQ Z6 at market'],
    ]);
    expect(chartToasts({ layoutId: 'L', tileId: 'chart-2' })).toBe(chartToasts(chart));
    const retry = vi.fn();
    noteOnChart(
      chart,
      { tone: 'err', text: 'Eval 50K (Tessera Paper): Flatten failed' },
      { account: 'Eval 50K', retry },
    );
    const err = standing().at(-1)!;
    expect([err.title, err.action?.label, err.ms]).toEqual(['Flatten failed', 'Retry', null]);
    expect(err.detail).toContain('Eval 50K');
    chartToasts(chart).act(err.id);
    expect(retry).toHaveBeenCalledTimes(1);
    noteOnChart(chart, 'Saved the template My NQ flow');
    expect(standing().at(-1)?.title).toBe('Saved the template My NQ flow');
    noteOnChart(chart, { tone: 'ok', text: 'Flat NQ Z6' }, { retry });
    expect(standing().at(-1)?.action).toBeNull();
    noteOnChart(chart, { tone: 'info', text: 'Move drafted, approve it on the card', approval: true });
    expect(standing().at(-1)?.action?.label).toBe('Show');
    chartToasts(chart).clear();
  });

  it('loads the analyst only when Show is pressed', async () => {
    noteOnChart(chart, { tone: 'info', text: 'Move drafted, approve it on the card', approval: true });
    expect(review.loaded).toBe(false);
    chartToasts(chart).act(standing().at(-1)!.id);
    await vi.waitFor(() => expect(review.revealApproval).toHaveBeenCalledTimes(1));
    expect(review.loaded).toBe(true);
    chartToasts(chart).clear();
  });
});
