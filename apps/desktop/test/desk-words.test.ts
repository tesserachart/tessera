import { ClientClosed, ConnectionLost, RequestTimeout, ToolFailed, type ProviderHealth } from '@tessera/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { healthWords } from '../src/accounts/connections.ts';
import { loadErrorWords } from '../src/chart/chartNotice.ts';
import { feedState } from '../src/orderflow/dom/ladderModel.ts';
import {
  connectionWords,
  deskErrorWords,
  FEED_FAILED,
  feedErrorWords,
  keepLocalChartChange,
  loadedWords,
  OLDER_HISTORY_REFUSED,
  refusedByFeed,
  retryFeedError,
} from '../src/shell/deskWords.ts';
import { noticeLine } from '../src/shell/noticeWords.ts';
import { providerHealth } from './support/providers.ts';

const RAW_ON_SCREEN =
  /\[\d+\]|\bcode \d+|\(\d{3}\)|request rejected|rp_code|os error|tools\.invoke|market\.get_candles|::|wss?:\/\/|\w+_\w+/i;

const PROVIDER_TEXT = [
  'request rejected: [13] permission denied',
  'Rithmic refused the tick replay: permission denied (code 13)',
  'Rithmic refused the depth snapshot: no permission',
  'Rithmic refused the login: permission denied (code 13)',
  'Rithmic refused the request: unknown account (code 3)',
  'request rejected: [7] no data',
  'request rejected: [42] some new reason',
  'Rithmic refused the tick replay: market closed (code 5)',
  'Acme refused the key (401): bad token. Change it in Settings › Connections.',
  'Acme says this account is not entitled to it (403).',
  'Acme is rate limiting the requests (429).',
  'Acme had a problem (502): upstream.',
  'Acme answered 418.',
  'market.get_candles: rp_code missing in response',
  'protocol error: unexpected template_id 0x13 at wss://gateway.example:443',
  'thread panicked at tessera_rithmic::feeds',
  'tools.invoke: no response within 20000ms',
  'Cannot reach Rithmic: connection failed: IO error: Connection refused (os error 111)',
];

function failed(message: string, code = 'unsupported'): ToolFailed {
  return new ToolFailed({ tool: 'market.get_candles', code, message, details: null, callId: 'c1' });
}

describe('desk wording', () => {
  it('turns feed and session failures into trader words', () => {
    expect(deskErrorWords('tools.invoke: no response within 20000ms')).toBe('No answer from the feed.');
    expect(deskErrorWords('Cannot reach Rithmic: connection failed: IO error: Connection refused (os error 111)')).toBe(
      'Cannot reach the feed.',
    );
    expect(deskErrorWords('ForcedLogout: Rithmic ended the session. Reconnect to continue.')).toBe(
      'Session ended. Reconnect in Connections.',
    );
    expect(deskErrorWords('Price has not passed your entry')).toBeNull();
  });

  it('says plainly when another session of the login took over, and that Tessera waits', () => {
    const takenOver = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../fixtures/connections/taken-over.json'), 'utf8'),
    ) as { rithmic: string; desk: string };
    expect(deskErrorWords(takenOver.rithmic)).toBe(takenOver.desk);
    expect(connectionWords({ state: 'taken_over' })).toBe(takenOver.desk);
    expect(healthWords(providerHealth({ status: 'down', connection: { state: 'taken_over' } }))).toBe(takenOver.desk);
    expect(deskErrorWords('Connection lost (logged out by Rithmic). Reconnecting, attempt 1.')).toBeNull();
  });

  it('says every connection phase in plain words, with no message', () => {
    const said = (connection: ProviderHealth['connection'], status: ProviderHealth['status']) =>
      healthWords(providerHealth({ status, connection, message: null, latencyMs: null }));
    expect([
      said({ state: 'stopped' }, 'disconnected'),
      said({ state: 'connecting' }, 'unknown'),
      said({ state: 'live' }, 'ok'),
      said({ state: 'reconnecting', attempt: 1, reason: 'logged out by Rithmic' }, 'degraded'),
      said({ state: 'reconnecting', attempt: 2, reason: 'heartbeat timeout' }, 'degraded'),
      said({ state: 'reconnecting', attempt: 3, reason: 'IO error: Connection refused (os error 111)' }, 'degraded'),
      said({ state: 'waiting' }, 'degraded'),
      said({ state: 'logged_out' }, 'down'),
      said({ state: 'refused', reason: 'permission denied (code 13)' }, 'down'),
      said({ state: 'unreachable', reason: 'IO error: Connection refused (os error 111)' }, 'down'),
    ]).toEqual([
      'Off',
      'Connecting',
      'Connected',
      'Connection lost. Reconnecting.',
      'Connection lost. Reconnecting, 2nd try.',
      'Connection lost. Reconnecting, 3rd try.',
      'Logged out. Logging in again.',
      'Session ended. Reconnect in Connections.',
      'Login refused. Check the user name and password.',
      'Cannot connect. Check the network, then reconnect.',
    ]);
  });

  it('keeps raw codes out of panel copy', () => {
    const timeout = new RequestTimeout({ method: 'tools.invoke', timeoutMs: 20_000 });
    expect(feedErrorWords(timeout)).toBe('No answer from the feed.');
    expect(feedErrorWords(timeout)).not.toMatch(/tools\.invoke|20000ms/);
    expect(feedErrorWords('Rithmic dropped')).toBe('Rithmic dropped');
  });

  it('retries a stalled feed read and keeps a local chart change', () => {
    const timeout = new RequestTimeout({ method: 'tools.invoke', timeoutMs: 20_000 });
    const lost = new ConnectionLost({ method: 'tools.invoke', reason: 'socket closed' });
    const closed = new ClientClosed({ method: 'tools.invoke' });
    const down = new ToolFailed({
      tool: 'market.get_candles',
      code: 'unavailable',
      message: 'rithmic-apex is reconnecting',
      details: null,
      callId: 'c1',
    });
    const unknown = new ToolFailed({
      tool: 'market.get_candles',
      code: 'not_found',
      message: 'unknown instrument ES',
      details: null,
      callId: 'c2',
    });
    expect(retryFeedError(timeout)).toBe(true);
    expect(retryFeedError(lost)).toBe(false);
    expect(retryFeedError(closed)).toBe(false);
    expect(retryFeedError(down)).toBe(true);
    expect(keepLocalChartChange(timeout)).toBe(true);
    expect(keepLocalChartChange(lost)).toBe(true);
    expect(keepLocalChartChange(closed)).toBe(true);
    expect(keepLocalChartChange(down)).toBe(true);
    expect(keepLocalChartChange(unknown)).toBe(false);
  });
});

describe('how much of its days a study holds', () => {
  const loaded = (held: number, sessions: number, filling: boolean, refused = false) => ({
    loaded: { sessions, held, refused },
    filling,
  });

  it('says how far a study has loaded while it fills, and nothing once it holds every session', () => {
    expect(loadedWords(loaded(1, 2, true))).toEqual({
      text: 'Loading · 1 of 2 sessions',
      short: 'Loading 1/2',
      least: 'Loading…',
    });
    expect(loadedWords(loaded(0, 1, true))?.text).toBe('Loading · 0 of 1 session');
    expect(loadedWords(loaded(2, 2, false))).toBeNull();
    expect(loadedWords(loaded(2, 2, true))).toBeNull();
    expect(loadedWords(null)).toBeNull();
  });

  it('says so in plain words when the login refuses the rest, and stays quiet when nothing more is coming', () => {
    expect(loadedWords(loaded(1, 2, false, true))?.text).toBe(OLDER_HISTORY_REFUSED);
    expect(loadedWords(loaded(1, 2, false, false))).toBeNull();
    expect(OLDER_HISTORY_REFUSED).not.toMatch(RAW_ON_SCREEN);
  });
});

describe('errors a trader sees', () => {
  it('says what a known Rithmic refusal means and what to do', () => {
    expect(feedErrorWords(failed('request rejected: [13] permission denied'))).toBe(
      'Not available on this login. Ask your broker about access.',
    );
    expect(loadErrorWords('ESZ6.CME', failed('request rejected: [13] permission denied'))).toBe(
      'ES Z6 did not load. Not available on this login. Ask your broker about access.',
    );
    expect(deskErrorWords('Rithmic refused the login: permission denied (code 13)')).toBe(
      'Rithmic refused the login. Check the user name and password.',
    );
    expect(deskErrorWords('Rithmic refused the request: unknown account (code 3)')).toBe(
      'Rithmic does not know this account. Check it in Connections.',
    );
    expect(deskErrorWords('request rejected: [7] no data')).toBe('No data for this time.');
    expect(deskErrorWords('Acme refused the key (401): bad token. Change it in Settings › Connections.')).toBe(
      'Acme refused the key. Change it in Settings › Connections.',
    );
  });

  it('shows plain words for an unknown provider code and keeps the raw text in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(feedErrorWords(failed('request rejected: [42] some new reason'))).toBe(FEED_FAILED);
    expect(loadErrorWords('NQZ6.CME', failed('internal: tessera_store::open failed'))).toBe(
      'NQ Z6 did not load. Try again in a moment.',
    );
    expect(warn.mock.calls.flat().join('\n')).toContain('request rejected: [42] some new reason');
    warn.mockRestore();
  });

  it('keeps a plain runtime sentence as it is', () => {
    expect(feedErrorWords(failed('No connection serves NQ now'))).toBe('No connection serves NQ now');
    expect(noticeLine({ tone: 'err', text: 'Price has not passed your entry. Nothing sent.' })).toBe(
      'Not sent: Price has not passed your entry',
    );
  });

  it('knows a refusal of this login apart from a feed that is down, and never asks again for one', () => {
    for (const raw of [
      'request rejected: [13] permission denied',
      'Rithmic refused the bar replay: permission denied (code 13)',
    ]) {
      expect(refusedByFeed(failed(raw)), raw).toBe(true);
      expect(retryFeedError(failed(raw, 'unavailable')), raw).toBe(false);
    }
    expect(refusedByFeed(failed('Rithmic refused the login: permission denied (code 13)'))).toBe(false);
    expect(refusedByFeed(failed('rithmic-apex is reconnecting', 'unavailable'))).toBe(false);
    expect(refusedByFeed(failed('request rejected: [7] no data'))).toBe(false);
    expect(OLDER_HISTORY_REFUSED).not.toMatch(RAW_ON_SCREEN);
  });

  it('a refusal by the provider is not a reason to keep a local chart change', () => {
    expect(keepLocalChartChange(failed('request rejected: [13] permission denied'))).toBe(false);
  });

  it('puts no provider code or internal text on any trader-facing surface', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const book = { seq: null, gapPending: false, heard: 0 };
    for (const raw of PROVIDER_TEXT) {
      const shown = [
        feedErrorWords(failed(raw)),
        loadErrorWords('NQZ6.CME', failed(raw)),
        healthWords(providerHealth({ status: 'down', message: raw })),
        noticeLine({ tone: 'err', text: raw }),
        noticeLine({ tone: 'err', text: `${raw}. Nothing sent.` }),
      ];
      const ladder = feedState(book, 0, { error: raw, dropped: null });
      if (ladder.kind === 'dropped') shown.push(ladder.words);
      for (const words of shown) expect(words, raw).not.toMatch(RAW_ON_SCREEN);
    }
    vi.restoreAllMocks();
  });
});
