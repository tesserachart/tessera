import type { TradingSessionReport, TradingSessionStatus } from '@tessera/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { TradingSessionCard } from '../src/analyst/cards/TradingSessionCard.tsx';
import { issueWords, sessionMeta, sessionTitle, tradeWords } from '../src/analyst/cards/session.ts';
import {
  canStartNow,
  readRunnerSetting,
  repoProblem,
  runnerValue,
  standingWords,
} from '../src/analyst/tradingSessions.ts';

afterEach(() => {
  cleanup();
  putRuntimeSettings({ 'display.timeZone': null }, false);
});

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-10-26T11:00:00-04:00');

const status = (over: Partial<TradingSessionStatus> = {}): TradingSessionStatus => ({
  setting: { enabled: true, accountId: 'eval-50k', provider: 'codex' },
  instructionsPath: '/home/me/.config/tessera/analyst-instructions.md',
  instructionsChars: 412,
  missing: [],
  day: null,
  nextStart: NOW,
  ...over,
});

const report: TradingSessionReport = {
  date: '2026-10-26',
  accountId: 'eval-50k',
  accountName: 'Eval 50K',
  environment: 'eval',
  startedAt: at('2026-10-26T09:30:00-04:00'),
  endedAt: at('2026-10-26T15:51:00-04:00'),
  trades: [
    {
      id: 't1',
      symbol: 'MNQ',
      side: 'buy',
      qty: 2,
      entryPrice: 21000.25,
      exitPrice: 21010,
      priceDecimals: 2,
      netPnl: 37.5,
      rMultiple: 0.94,
      openedAt: at('2026-10-26T10:02:00-04:00'),
      closedAt: at('2026-10-26T10:40:00-04:00'),
    },
  ],
  netPnl: 37.5,
  log: 'Long the reclaim of the overnight high.',
  issues: [
    {
      title: 'orders.cancel: no order no-such-order',
      detail: '',
      from: 'tessera',
      url: 'https://github.com/owner/repo/issues/7',
      notFiled: null,
    },
    { title: 'Quotes slow', detail: '', from: 'analyst', url: null, notFiled: 'gh is not signed in' },
  ],
};

describe('the trading sessions setting', () => {
  it('reads what is stored and writes it back without blanks', () => {
    expect(readRunnerSetting(null)).toEqual({ enabled: false });
    const s = readRunnerSetting({ enabled: true, accountId: 'eval-50k', model: 3 });
    expect(s.enabled).toBe(true);
    expect(s.model).toBeUndefined();
    expect(runnerValue(s, { provider: 'codex', model: ' gpt ', issuesRepo: '  ' })).toEqual({
      enabled: true,
      accountId: 'eval-50k',
      provider: 'codex',
      model: 'gpt',
    });
    expect(repoProblem('owner/repo')).toBeNull();
    expect(repoProblem('')).toBeNull();
    expect(repoProblem('owner')).not.toBeNull();
  });

  it('says where the sessions stand and when Start now applies', () => {
    expect(standingWords(status({ setting: { enabled: false } }), NOW)).toBe('Off');
    expect(standingWords(status({ missing: ['Set a daily loss limit'] }), NOW)).toBe(
      'Not ready: Set a daily loss limit',
    );
    const reopen = at('2026-10-25T18:00:00-04:00');
    const saturday = at('2026-10-24T12:00:00-04:00');
    expect(standingWords(status({ nextStart: reopen }), saturday)).toBe('Next session Sun 25 Oct at 18:00');
    expect(canStartNow(status(), NOW)).toBe(true);
    expect(canStartNow(status({ nextStart: reopen }), saturday)).toBe(false);
  });

  it('follows a session across midnight to the market’s break', () => {
    const sunday = at('2026-10-25T23:30:00-04:00');
    const trading = status({
      nextStart: sunday,
      day: {
        date: '2026-10-26',
        opensAt: at('2026-10-25T18:00:00-04:00'),
        closesAt: at('2026-10-26T17:00:00-04:00'),
        phase: 'trading',
        sessionId: 's1',
        accountId: 'eval-50k',
        startedAt: at('2026-10-25T18:00:00-04:00'),
        note: null,
        studyId: null,
      },
    });
    expect(standingWords(trading, sunday)).toBe('Trading since 18:00 · the market breaks at 17:00');
    expect(canStartNow(trading, sunday)).toBe(false);
    const skipped = status({
      nextStart: sunday,
      day: { ...trading.day!, phase: 'skipped', sessionId: null, startedAt: null, note: 'Codex is not ready' },
    });
    expect(standingWords(skipped, sunday)).toBe('This session did not start: Codex is not ready');
    expect(canStartNow(skipped, sunday)).toBe(true);
    const done = status({ day: { ...trading.day!, phase: 'done' }, nextStart: at('2026-10-26T18:00:00-04:00') });
    expect(standingWords(done, at('2026-10-26T16:58:00-04:00'))).toBe(
      'This session is over: its report is in its conversation and the journal',
    );
    expect(standingWords(done, at('2026-10-26T17:10:00-04:00'))).toBe('Next session Mon 26 Oct at 18:00');
  });

  it('writes its clocks in the trader’s time zone', () => {
    putRuntimeSettings({ 'display.timeZone': 'Europe/London' }, false);
    const saturday = at('2026-10-24T12:00:00-04:00');
    expect(standingWords(status({ nextStart: at('2026-10-25T18:00:00-04:00') }), saturday)).toBe(
      'Next session Sun 25 Oct at 22:00',
    );
    putRuntimeSettings({ 'display.timeZone': 'Asia/Tokyo' }, false);
    expect(standingWords(status({ nextStart: at('2026-10-25T18:00:00-04:00') }), saturday)).toBe(
      'Next session Mon 26 Oct at 07:00',
    );
    expect(sessionMeta(report)).toBe('22:30–04:51 · 1 trade · +$37.50');
    expect(sessionTitle(report)).toBe('Eval 50K · Mon 26 Oct');
  });
});

describe('the trading session card', () => {
  it('words the session, its trades and its issues', () => {
    expect(sessionMeta(report)).toBe('09:30–15:51 · 1 trade · +$37.50');
    expect(tradeWords(report.trades[0]!)).toBe('10:02 · 21,000.25 → 21,010.00 · +$37.50 · 0.94R');
    expect(issueWords(report.issues[0]!)).toBe('Filed');
    expect(issueWords(report.issues[1]!)).toBe('Not filed: gh is not signed in');
  });

  it('shows the trades, the issues and the log', () => {
    render(<TradingSessionCard body={report} actions={null} />);
    expect(screen.getByText('Eval 50K · Mon 26 Oct')).toBeTruthy();
    expect(screen.getByText('Long 2 MNQ')).toBeTruthy();
    expect(screen.getByText('orders.cancel: no order no-such-order')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filed' })).toBeTruthy();
    expect(screen.getByText('Its log')).toBeTruthy();
    expect(screen.getByText('Long the reclaim of the overnight high.')).toBeTruthy();
  });
});
