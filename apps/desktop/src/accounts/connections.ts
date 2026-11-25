import type { ComboboxOption } from '@tessera/ui';
import type {
  ConnectionInfo,
  HealthStatus,
  LevelSourceInfo,
  ProviderHealth,
  RithmicLoginInput,
  SourceDraft,
  TradingAccount,
} from '@tessera/protocol';
import { endSentence } from '../areas/settings/sentence.ts';
import { connectionWords, screenWords } from '../shell/deskWords.ts';

export interface ConnectionRow {
  id: string;
  name: string;
  grants: string[];
  rule: string | null;
  status: HealthStatus;
  health: string;
  latencyMs: number | null;
  login: 'rithmic' | null;
  system: string | null;
  action: RowAction | null;
  enabled: boolean | null;
  paper: boolean;
}

export type RowAction = { kind: 'reconnect' | 'login'; label: string };

const AGENT_KINDS = new Set<ProviderHealth['kind']>(['agent', 'mcp', 'runtime']);

function isRithmic(p: Pick<ProviderHealth, 'providerId'>): boolean {
  return /rithmic/i.test(p.providerId);
}

export function systemOf(displayName: string): string {
  const first = displayName.split(' · ')[0]?.trim();
  return first === undefined || first === '' ? displayName : first;
}

const STATE: Record<HealthStatus, string> = {
  ok: 'Connected',
  degraded: 'Data is late',
  down: 'Down',
  disconnected: 'Off',
  unknown: 'Connecting',
  disabled: 'Off',
};

type HealthFacts = Pick<ProviderHealth, 'status' | 'latencyMs' | 'message' | 'connection' | 'accounts'>;

function ownWords(p: HealthFacts, latency: boolean): string {
  const phase = p.connection;
  if (phase && phase.state !== 'live') return connectionWords(phase);
  const msg = p.message?.trim();
  if (p.status === 'ok' || (phase && !msg))
    return latency && p.latencyMs !== null ? `${String(Math.round(p.latencyMs))} ms` : STATE.ok;
  if (!msg) return STATE[p.status];
  const said = screenWords(msg, STATE[p.status]);
  return said !== msg ? said : endSentence(msg);
}

export function healthWords(p: HealthFacts | null): string {
  if (!p) return 'Not connected';
  if (!p.accounts) return ownWords(p, true);
  return `${endSentence(ownWords(p, false))} Accounts: ${connectionWords(p.accounts)}`;
}

function marketGrants(info: ConnectionInfo | undefined, rithmic: boolean): string[] {
  const m = info?.market;
  if (!m) return rithmic ? ['Prices'] : [];
  const out = ['Prices'];
  if (m.depthLevels !== null || rithmic) out.push(rithmic ? 'Depth by order' : 'Depth');
  return out;
}

export function brokerRule(b: ConnectionInfo['broker']): string | null {
  if (!b) return null;
  if (b.readOnly || b.orderTypes.length === 0) return 'Read only';
  if (b.environments.length > 0 && b.environments.every((e) => e === 'paper' || e === 'sim'))
    return 'Orders: paper only';
  return null;
}

export function rowAction(p: ProviderHealth | null, info: ConnectionInfo | undefined): RowAction | null {
  if (!p) return null;
  if (info?.market === null) {
    if (info.credential === 'unreadable') return { kind: 'reconnect', label: 'Try again' };
    if (p.status === 'unknown') return null;
    return { kind: 'login', label: 'Log in again' };
  }
  if (p.status === 'down' || p.status === 'disconnected') return { kind: 'reconnect', label: 'Reconnect' };
  return null;
}

export function connectionRows(
  providers: readonly ProviderHealth[],
  infos: readonly ConnectionInfo[],
  accounts: readonly TradingAccount[] = [],
): ConnectionRow[] {
  const byId = new Map<string, { health: ProviderHealth | null; info: ConnectionInfo | undefined }>();
  for (const p of providers) {
    if (AGENT_KINDS.has(p.kind)) continue;
    byId.set(p.providerId, { health: p, info: infos.find((i) => i.id === p.providerId) });
  }
  for (const i of infos) if (!byId.has(i.id) && !AGENT_KINDS.has(i.kind)) byId.set(i.id, { health: i.health, info: i });

  const own: ConnectionRow[] = [];
  let paper: ConnectionRow | null = null;
  for (const [id, { health, info }] of byId) {
    if (id === 'paper') {
      paper = {
        id,
        name: 'Paper trading',
        grants: ['Accounts', 'Orders', 'Fills'],
        rule: null,
        status: health?.status ?? 'unknown',
        health: healthWords(health),
        latencyMs: null,
        login: null,
        system: null,
        action: null,
        enabled: null,
        paper: true,
      };
      continue;
    }
    const rithmic = health ? isRithmic(health) : /rithmic/i.test(id);
    const levelsOnly = (info?.intel ?? null) !== null || health?.kind === 'intelligence';
    if (levelsOnly && !info?.market && !info?.broker) continue;
    const name = info?.displayName ?? health?.displayName ?? id;
    const grants = [...marketGrants(info, rithmic)];
    const servesAccounts = (info?.broker ?? null) !== null || accounts.some((a) => a.connectionId === id);
    if (servesAccounts) grants.push('Accounts', 'Fills');
    const enabled = info?.enabled ?? null;
    own.push({
      id,
      name,
      grants,
      rule: brokerRule(info?.broker ?? null),
      status: enabled === false ? 'disconnected' : (health?.status ?? 'unknown'),
      health: enabled === false ? 'Off' : healthWords(health),
      latencyMs: enabled === false || health?.status !== 'ok' ? null : (health.latencyMs ?? null),
      login: rithmic ? 'rithmic' : null,
      system: rithmic ? systemOf(name) : null,
      action: rithmic && enabled !== false ? rowAction(health, info) : null,
      enabled,
      paper: false,
    });
  }
  own.sort((a, b) => Number(b.login !== null) - Number(a.login !== null));
  const rows = [...own];
  if (paper) rows.push(paper);
  return rows;
}

const LOGGED_IN: ReadonlySet<HealthStatus> = new Set(['ok', 'degraded']);

export function rithmicLive(rows: readonly ConnectionRow[]): boolean {
  return rows.some((r) => r.login === 'rithmic' && LOGGED_IN.has(r.status));
}

export type Listed =
  | { kind: 'login'; row: ConnectionRow }
  | { kind: 'levels'; info: LevelSourceInfo; health: ProviderHealth }
  | { kind: 'draft'; draft: SourceDraft };

const DRAFT = 'draft:';

export function listedConnections(
  rows: readonly ConnectionRow[],
  levels: readonly LevelSourceInfo[],
  providers: readonly ProviderHealth[],
  drafts: readonly SourceDraft[],
): Listed[] {
  const login = (row: ConnectionRow): Listed => ({ kind: 'login', row });
  return [
    ...rows.filter((r) => !r.paper).map(login),
    ...levels.map((info): Listed => ({
      kind: 'levels',
      info,
      health: providers.find((p) => p.providerId === info.providerId) ?? info.health,
    })),
    ...drafts.map((draft): Listed => ({ kind: 'draft', draft })),
    ...rows.filter((r) => r.paper).map(login),
  ];
}

type ConnectionEnd = 'disconnect' | 'connect' | 'remove' | 'discard' | null;

export interface ConnectionItem {
  id: string;
  name: string;
  short: string;
  status: HealthStatus;
  state: string;
  latencyMs: number | null;
  provides: string;
  serves: string | null;
  fix: RowAction | null;
  test: boolean;
  edit: boolean;
  end: ConnectionEnd;
  shownInChrome: boolean;
}

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`;
}

function providesWords(row: Pick<ConnectionRow, 'grants' | 'rule'>): string {
  const what = listWords(row.grants.map((g, i) => (i === 0 ? g : g.toLowerCase())));
  return row.rule ? `${what} · ${row.rule}` : what;
}

function loginItem(row: ConnectionRow, accounts: readonly TradingAccount[]): ConnectionItem {
  const served = accounts.filter((a) => a.connectionId === row.id).map((a) => a.displayName);
  const off = row.enabled === false;
  return {
    id: row.id,
    name: row.name,
    short: row.system ?? row.name,
    status: row.status,
    state: row.health,
    latencyMs: row.latencyMs,
    provides: row.paper ? 'Accounts and orders, filled at your market data’s prices' : providesWords(row),
    serves: served.length > 0 ? served.join(', ') : null,
    fix: row.action,
    test: row.login !== null,
    edit: row.login !== null,
    end: row.login === null ? null : off ? 'connect' : 'disconnect',
    shownInChrome: !row.paper,
  };
}

export function connectionItem(l: Listed, accounts: readonly TradingAccount[]): ConnectionItem {
  switch (l.kind) {
    case 'login':
      return loginItem(l.row, accounts);
    case 'levels': {
      const facts = [l.info.instruments.length > 0 ? `Levels for ${l.info.instruments.join(', ')}` : 'Levels'];
      return {
        id: l.info.providerId,
        name: l.info.displayName,
        short: l.info.displayName,
        status: l.health.status,
        state: healthWords(l.health),
        latencyMs: l.health.status === 'ok' ? l.health.latencyMs : null,
        provides: facts.join(' · '),
        serves: null,
        fix: null,
        test: true,
        edit: true,
        end: 'remove',
        shownInChrome: true,
      };
    }
    case 'draft':
      return {
        id: `${DRAFT}${l.draft.id}`,
        name: l.draft.spec.name,
        short: l.draft.spec.name,
        status: 'unknown',
        state: 'Draft',
        latencyMs: null,
        provides: 'Levels, once you try it with your key and save it',
        serves: null,
        fix: null,
        test: false,
        edit: true,
        end: 'discard',
        shownInChrome: false,
      };
  }
}

export function connectionOf(rows: readonly ConnectionRow[], connectionId: string): ConnectionRow | null {
  return rows.find((r) => r.id === connectionId) ?? null;
}

export const EMPTY_LOGIN: RithmicLoginInput = { system: '', gateway: '', user: '', password: '' };

export function loginProblem(l: RithmicLoginInput): string | null {
  if (!l.system.trim() || !l.gateway.trim() || !l.user.trim() || !l.password) return 'Fill in all four fields';
  return gatewayProblem(l.gateway);
}

const isAddress = (gateway: string) => gateway.includes('://');

export function gatewayProblem(gateway: string): string | null {
  const g = gateway.trim();
  return !g || !isAddress(g) || gatewayIsSafe(g) ? null : 'The gateway is a wss:// address';
}

function gatewayIsSafe(url: string): boolean {
  if (url.startsWith('wss://')) return true;
  if (!url.startsWith('ws://')) return false;
  const authority = url.slice('ws://'.length).split(/[/?#]/)[0] ?? '';
  const host = authority.startsWith('[')
    ? (authority.slice(1).split(']')[0] ?? '')
    : authority.includes(':')
      ? authority.slice(0, authority.lastIndexOf(':'))
      : authority;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

export const KNOWN_SYSTEMS: readonly string[] = [
  '4PropTrader',
  'Apex',
  'BluSky',
  'Bulenox',
  'DayTraders.com',
  'Earn2Trade',
  'FundedFuturesNetwork',
  'GoatFundedFutures',
  'HOLAPRIME',
  'LucidTrading',
  'PropShopTrader',
  'Rithmic 01',
  'Rithmic Paper Trading',
  'TheTradingPit',
  'TopstepTrader',
  'TradeFundrr',
  'Tradeify',
].sort(byName);

export function systemOptions(listed: readonly string[]): ComboboxOption[] {
  const names = listed.length > 0 ? [...new Set(listed)].sort(byName) : KNOWN_SYSTEMS;
  return names.map((s) => ({ value: s, label: s }));
}

export const typedSystem = (q: string): ComboboxOption => ({ value: q, label: `Use “${q}”` });

export function defaultGateway(gateways: readonly string[]): string | null {
  return gateways.find((g) => /chicago/i.test(g)) ?? gateways[0] ?? null;
}

export interface Heard {
  readonly said: { readonly ok: boolean; readonly text: string } | null;
  readonly under: string;
}

export function answerNow(heard: Heard | null, status: string): Heard['said'] {
  return heard?.under === status ? heard.said : null;
}
