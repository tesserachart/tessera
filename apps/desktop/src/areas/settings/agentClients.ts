import type { McpClientInfo, McpClientKind, McpClientPolicy } from '@tessera/protocol';

export const CLIENT_KINDS: readonly { kind: McpClientKind; label: string }[] = [
  { kind: 'claude-desktop', label: 'Claude Desktop' },
  { kind: 'claude-code', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'other', label: 'Another MCP client' },
];

export const CLIENT_POLICIES: readonly { value: McpClientPolicy; label: string; hint: string }[] = [
  { value: 'supervised', label: 'Supervised', hint: 'Asks before changes' },
  { value: 'read_only', label: 'Read only', hint: 'Changes nothing' },
];

export function kindLabel(kind: McpClientKind): string {
  return kind === 'other' ? 'MCP client' : (CLIENT_KINDS.find((k) => k.kind === kind)?.label ?? kind);
}

export function ago(ns: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ns / 1e6) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${String(Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))}h ago`;
  return `${String(Math.floor(s / 86_400))}d ago`;
}

export function clientHelp(client: McpClientInfo, all: readonly McpClientInfo[], nowMs: number): string {
  const words: string[] = [];
  if (client.name !== kindLabel(client.kind)) words.push(kindLabel(client.kind));
  if (all.some((c) => c.id !== client.id && c.name === client.name)) words.push(client.id);
  words.push(client.lastUsedAt === null ? 'Not used yet' : `Last used ${ago(client.lastUsedAt, nowMs)}`);
  return words.join(' · ');
}

export function addedWords(path: string, backup: string | null): string {
  return backup
    ? `Added to ${path}, the old file kept beside it. Restart Claude Desktop to use it.`
    : `Added to ${path}. Restart Claude Desktop to use it.`;
}
