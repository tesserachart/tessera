import { createToastQueue } from '@tessera/ui';
import { describe, expect, it } from 'vitest';
import type { Feeds } from '../src/shell/freshness.ts';
import { showStaleNotices, staleNotices, type StaleNotice } from '../src/shell/staleNotices.ts';
import { providerHealth } from './support/providers.ts';

const live: Feeds = { link: { status: 'open', everConnected: true }, behindMs: 0, pricesDown: [] };

const APEX = providerHealth({
  providerId: 'rithmic-apex',
  displayName: 'Apex · Rithmic',
  latencyMs: 4,
  lastMessageAt: 1,
  checkedAt: 1,
});

const down: Feeds = { ...live, pricesDown: ['rithmic-apex'] };

describe('the toast while prices are stale', () => {
  it('says a connection that lost its prices dropped and is reconnecting', () => {
    const reconnecting = {
      ...APEX,
      status: 'degraded',
      message: 'Connection lost (eof). Reconnecting, attempt 3.',
    } as const;
    expect(staleNotices(down, [reconnecting])).toEqual([
      {
        key: 'stale:prices:rithmic-apex',
        title: 'Apex · Rithmic dropped',
        detail: 'Reconnecting. New market orders wait for live prices',
      },
    ]);
  });

  it('says what the status line says when the connection is not reconnecting by itself', () => {
    const message = 'ForcedLogout: Rithmic ended the session. Reconnect to continue.';
    expect(staleNotices(down, [{ ...APEX, status: 'down', message }])).toEqual([
      {
        key: 'stale:prices:rithmic-apex',
        title: 'Apex · Rithmic dropped',
        detail: 'Session ended. Reconnect in Connections.',
      },
    ]);
  });

  it('stays quiet for a connection turned off or still connecting: nothing dropped', () => {
    expect(staleNotices(down, [{ ...APEX, status: 'disconnected' }])).toEqual([]);
    expect(staleNotices(down, [{ ...APEX, status: 'unknown', message: 'Connecting' }])).toEqual([]);
  });

  it('stays quiet in a quiet market: a connection that has heard no trade for ten minutes is still live', () => {
    expect(staleNotices(live, [{ ...APEX, lastMessageAt: 1, checkedAt: 600_000_000_001 }])).toEqual([]);
  });

  it('says the runtime dropped and is reconnecting, in place of what it can no longer tell', () => {
    const dropped: Feeds = { ...down, link: { status: 'reconnecting', everConnected: true } };
    expect(staleNotices(dropped, [{ ...APEX, status: 'degraded' }])).toEqual([
      { key: 'stale:runtime', title: 'Runtime dropped', detail: 'Reconnecting' },
    ]);
    expect(staleNotices({ ...live, link: { status: 'connecting', everConnected: false } }, [])).toEqual([]);
    expect(staleNotices({ ...live, link: { status: 'closed', everConnected: true } }, [])).toEqual([]);
  });
});

describe('showing the stale toasts', () => {
  const lost: StaleNotice = { key: 'stale:prices:mock', title: 'Mock market dropped', detail: 'Reconnecting' };
  const open = (q: ReturnType<typeof createToastQueue>) =>
    q
      .getSnapshot()
      .filter((t) => t.state === 'open')
      .map((t) => ({ key: t.key, title: t.title, ms: t.ms }));

  it('shows one that stays until the prices are back, then takes it away', () => {
    const q = createToastQueue();
    const shown = new Map<string, string>();
    showStaleNotices(q, shown, [lost]);
    showStaleNotices(q, shown, [lost]);
    expect(open(q)).toEqual([{ key: 'stale:prices:mock', title: 'Mock market dropped', ms: null }]);
    expect(q.getSnapshot()).toHaveLength(1);
    showStaleNotices(q, shown, []);
    expect(open(q)).toEqual([]);
  });

  it('leaves one the trader dismissed dismissed while nothing changes, and shows the next outage', () => {
    const q = createToastQueue();
    const shown = new Map<string, string>();
    showStaleNotices(q, shown, [lost]);
    q.dismiss(lost.key);
    showStaleNotices(q, shown, [lost]);
    expect(open(q)).toEqual([]);
    showStaleNotices(q, shown, []);
    showStaleNotices(q, shown, [lost]);
    expect(open(q)).toHaveLength(1);
  });

  it('says it again when what it says changes', () => {
    const q = createToastQueue();
    const shown = new Map<string, string>();
    showStaleNotices(q, shown, [lost]);
    showStaleNotices(q, shown, [{ ...lost, detail: 'ForcedLogout' }]);
    expect(open(q)).toHaveLength(1);
    expect(q.getSnapshot().find((t) => t.state === 'open')?.detail).toBe('ForcedLogout');
  });
});
