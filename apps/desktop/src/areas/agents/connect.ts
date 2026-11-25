import type { AgentProviderInfo, JsonValue } from '@tessera/protocol';
import { ago } from '../journal/model/dashboard.ts';
import { INSTALL_PAGES, INSTALLS_HERE, installPage, type ProviderView } from './models.ts';

export const PROVIDER_CLI: Readonly<Record<string, { bin: string; homeVar: string; home: string }>> = {
  'claude-code': { bin: 'claude', homeVar: 'CLAUDE_CONFIG_DIR', home: '~/.claude' },
  codex: { bin: 'codex', homeVar: 'CODEX_HOME', home: '~/.codex' },
};

export type ConnectState =
  | { kind: 'off' }
  | { kind: 'checking' }
  | { kind: 'ready'; account: string | null }
  | { kind: 'missing'; installs: boolean; page: string | null }
  | { kind: 'signed-out' }
  | { kind: 'failing'; why: string };

export function connectState(p: ProviderView): ConnectState {
  if (!p.enabled) return { kind: 'off' };
  if (p.ready) return { kind: 'ready', account: p.message };
  if (p.status === 'unknown') return { kind: 'checking' };
  if (installPage(p.id, p.status, p.message) || (p.status === 'down' && /not installed/i.test(p.message ?? '')))
    return { kind: 'missing', installs: INSTALLS_HERE.has(p.id), page: INSTALL_PAGES[p.id] ?? null };
  if (p.status === 'disconnected') return { kind: 'signed-out' };
  return { kind: 'failing', why: p.message ?? 'It did not run.' };
}

export function connectWord(s: ConnectState): string {
  switch (s.kind) {
    case 'off':
      return 'Off';
    case 'checking':
      return 'Checking…';
    case 'ready':
      return 'Ready';
    case 'missing':
      return 'Not installed';
    case 'signed-out':
      return 'Not signed in';
    case 'failing':
      return s.why;
  }
}

export function providerLine(p: ProviderView, version: string | null): string {
  const s = connectState(p);
  switch (s.kind) {
    case 'ready':
      return [s.account, version ? `v${version}` : null].filter(Boolean).join(' · ') || 'Ready';
    case 'missing':
      return s.installs ? 'Not installed.' : 'Not installed. Download it, then Check again.';
    case 'signed-out':
      return 'Not signed in.';
    default:
      return connectWord(s);
  }
}

export interface ProviderChoices {
  enabled: boolean;
  binaryPath: string;
  configDir: string;
  args: readonly string[];
}

const NO_CHOICES: ProviderChoices = { enabled: false, binaryPath: '', configDir: '', args: [] };

export function readProviderChoices(value: unknown, id: string): ProviderChoices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NO_CHOICES;
  const e = (value as Record<string, unknown>)[id];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return NO_CHOICES;
  const o = e as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    binaryPath: typeof o.binaryPath === 'string' ? o.binaryPath : '',
    configDir: typeof o.configDir === 'string' ? o.configDir : '',
    args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : [],
  };
}

export function enabledIds(value: unknown): ReadonlySet<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Set();
  return new Set(Object.keys(value).filter((id) => readProviderChoices(value, id).enabled));
}

export function providerChange(
  id: string,
  change: Partial<{ enabled: boolean; binaryPath: string; configDir: string; args: readonly string[] }>,
): { [id: string]: { [field: string]: JsonValue } } {
  const out: { [field: string]: JsonValue } = {};
  if (change.enabled !== undefined) out.enabled = change.enabled;
  for (const k of ['binaryPath', 'configDir'] as const) {
    const v = change[k];
    if (v !== undefined) out[k] = v.trim() === '' ? null : v.trim();
  }
  if (change.args !== undefined) out.args = change.args.length === 0 ? null : [...change.args];
  return { [id]: out };
}

type ProviderPatch = ReturnType<typeof providerChange>;

function fieldsOf(value: unknown): { [field: string]: JsonValue } {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as { [field: string]: JsonValue }) : {};
}

export function withProviderChange(stored: unknown, patch: ProviderPatch): JsonValue {
  const providers = fieldsOf(stored);
  const out: { [id: string]: JsonValue } = { ...providers };
  for (const [id, fields] of Object.entries(patch)) out[id] = { ...fieldsOf(providers[id]), ...fields };
  return out;
}

export function parseArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

export function formatArgs(args: readonly string[]): string {
  return args.map((a) => (a === '' || /[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a)).join(' ');
}

export function checkedWords(infos: readonly AgentProviderInfo[] | undefined, nowMs: number): string | null {
  const last = Math.max(...(infos ?? []).filter((p) => p.enabled).map((p) => p.checkedAt ?? -Infinity));
  return Number.isFinite(last) ? `Checked ${ago(last, nowMs)}` : null;
}
