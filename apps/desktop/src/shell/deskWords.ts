import { ConnectionLost, RequestTimeout, ClientClosed, type ConnectionPhase } from '@tessera/protocol';
import { CHART_MAX_BARS, type LegendNotice } from '@tessera/chart';
import { formatInt } from '@tessera/ui';
import { failureText, toolCode } from '../app/tools.ts';
import type { HistoryEnd } from '../market/bars.ts';
import type { Loaded } from '../market/flow/hub.ts';
import { MAX_PRINT_BAR_SESSIONS } from '../market/intervals.ts';

const NO_ANSWER = 'No answer from the feed.';
const TAKEN_OVER = 'Another session of this login took over. Close it, then reconnect in Connections.';
const SESSION_ENDED = 'Session ended. Reconnect in Connections.';
export const FEED_FAILED = 'The feed did not send this. Try again in a moment.';

interface Rule {
  readonly re: RegExp;
  readonly words: string | ((said: RegExpExecArray) => string);
  readonly link?: true;
}

const NOT_ON_THIS_LOGIN: Rule = {
  re: /permission denied|no permission|not (?:entitled|permissioned)|\[13\]|\(code 13\)/i,
  words: 'Not available on this login. Ask your broker about access.',
};

export const OLDER_HISTORY_REFUSED = 'Older history isn’t available on this login';

export function loadedWords(l: Loaded | null): LegendNotice | null {
  if (!l || l.loaded.held >= l.loaded.sessions) return null;
  const { held, sessions } = l.loaded;
  if (l.filling)
    return {
      text: `Loading · ${String(held)} of ${String(sessions)} ${sessions === 1 ? 'session' : 'sessions'}`,
      short: `Loading ${String(held)}/${String(sessions)}`,
      least: 'Loading…',
    };
  return l.loaded.refused
    ? { text: OLDER_HISTORY_REFUSED, short: OLDER_HISTORY_REFUSED, least: OLDER_HISTORY_REFUSED }
    : null;
}

export type ViewShortfall =
  | { kind: 'bars'; asked: number; shown: number; end: HistoryEnd }
  | { kind: 'from'; asked: number; first: number; end: HistoryEnd }
  | { kind: 'after'; asked: number; last: number };

const HISTORY_END_WORDS: Record<HistoryEnd, string> = {
  start: 'no older history',
  refused: 'older history isn’t available on this login',
  cap: `a chart holds ${formatInt(CHART_MAX_BARS)} bars at most`,
  sessions: `these bars reach back ${String(MAX_PRINT_BAR_SESSIONS)} sessions`,
};

export function viewShortWords(short: ViewShortfall, zone: string): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: zone }).format(ms);
  switch (short.kind) {
    case 'bars':
      return `${formatInt(short.shown)} of ${formatInt(short.asked)} bars: ${HISTORY_END_WORDS[short.end]}`;
    case 'from':
      return `From ${day(short.first)}, not ${day(short.asked)}: ${HISTORY_END_WORDS[short.end]}`;
    case 'after':
      return `Nothing from ${day(short.asked)} yet: the last bar is ${day(short.last)}`;
  }
}

const RULES: readonly Rule[] = [
  { re: /another session of this .*login took over/i, words: TAKEN_OVER, link: true },
  { re: /forcedlogout|ended the session/i, words: SESSION_ENDED, link: true },
  { re: /(\w+) refused the login/i, words: (m) => `${m[1]!} refused the login. Check the user name and password.` },
  { re: /os error|\bio error\b|connection refused/i, words: 'Cannot reach the feed.', link: true },
  { re: /tools\.invoke|no response within \d+\s*ms/i, words: NO_ANSWER, link: true },
  {
    re: /^(.+?) refused the key \(401\)/,
    words: (m) => `${m[1]!} refused the key. Change it in Settings › Connections.`,
  },
  {
    re: /^(.+?) says this account is not entitled to it \(403\)/,
    words: (m) => `Your ${m[1]!} plan does not include this. Ask ${m[1]!} about access.`,
  },
  NOT_ON_THIS_LOGIN,
  {
    re: /unknown account|\[3\] unknown|\(code 3\)/i,
    words: 'Rithmic does not know this account. Check it in Connections.',
  },
  { re: /\bno data\b|\[7\]|\(code 7\)/i, words: 'No data for this time.' },
  {
    re: /rate limit|too many requests|throttl|\(429\)/i,
    words: 'Too many requests for now. Try again in a moment.',
  },
  { re: /^(.+?) had a problem \(5\d\d\)/, words: (m) => `${m[1]!} had a problem. Try again later.` },
];

const TECHNICAL: readonly RegExp[] = [
  /\[\d+\]/,
  /\bcode\s*[:=]?\s*-?\d+/i,
  /\(\d{3}\)/,
  /\banswered \d{3}\b/,
  /request rejected/i,
  /\bos error\b/i,
  /\bpanicked\b/i,
  /\w::\w/,
  /[{}]/,
  /\b(?:wss?|https?):\/\//i,
  /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/,
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/,
  /\b[a-z]+\.[a-z_]+\b/,
  /\b0x[0-9a-f]+\b/i,
];

function readsPlain(text: string): boolean {
  return !TECHNICAL.some((re) => re.test(text));
}

function ruleFor(raw: string): { rule: Rule; said: RegExpExecArray } | null {
  const text = raw.trim();
  if (!text) return null;
  for (const rule of RULES) {
    const said = rule.re.exec(text);
    if (said) return { rule, said };
  }
  return null;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${String(n)}${suffix}`;
}

function reconnectingWords(attempt: number): string {
  return attempt > 1 ? `Connection lost. Reconnecting, ${ordinal(attempt)} try.` : 'Connection lost. Reconnecting.';
}

export function connectionWords(phase: ConnectionPhase): string {
  switch (phase.state) {
    case 'stopped':
      return 'Off';
    case 'connecting':
      return 'Connecting';
    case 'live':
      return 'Connected';
    case 'reconnecting':
      return reconnectingWords(phase.attempt);
    case 'waiting':
      return 'Logged out. Logging in again.';
    case 'logged_out':
      return SESSION_ENDED;
    case 'taken_over':
      return TAKEN_OVER;
    case 'refused':
      return 'Login refused. Check the user name and password.';
    case 'unreachable':
      return 'Cannot connect. Check the network, then reconnect.';
  }
}

export function deskErrorWords(raw: string): string | null {
  const hit = ruleFor(raw);
  if (!hit) return null;
  const { words } = hit.rule;
  return typeof words === 'string' ? words : words(hit.said);
}

function linkWords(raw: string): boolean {
  return ruleFor(raw)?.rule.link === true;
}

const logged = new Set<string>();

function logHidden(raw: string): void {
  if (logged.has(raw)) return;
  logged.add(raw);
  console.warn(`[desk] shown in plain words: ${raw}`);
}

export function screenWords(raw: string, fallback: string): string {
  const text = raw.trim();
  if (!text) return fallback;
  const said = deskErrorWords(text);
  if (said === null && readsPlain(text)) return text;
  logHidden(text);
  return said ?? fallback;
}

export function feedErrorWords(error: unknown): string {
  return screenWords(failureText(error), FEED_FAILED);
}

export function refusedByFeed(error: unknown): boolean {
  return ruleFor(failureText(error))?.rule === NOT_ON_THIS_LOGIN;
}

export function retryFeedError(error: unknown): boolean {
  if (error instanceof ConnectionLost || error instanceof ClientClosed) return false;
  if (refusedByFeed(error)) return false;
  const code = toolCode(error);
  if (code === 'unavailable' || code === 'timeout') return true;
  if (error instanceof RequestTimeout) return true;
  return deskErrorWords(failureText(error)) === NO_ANSWER;
}

export function keepLocalChartChange(error: unknown): boolean {
  const code = toolCode(error);
  if (code === 'not_found') return false;
  if (error instanceof ConnectionLost || error instanceof ClientClosed) return true;
  return retryFeedError(error) || linkWords(failureText(error));
}
