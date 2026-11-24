import type {
  AgentModel,
  AgentProviderInfo,
  AgentSessionSummary,
  HealthStatus,
  ProviderHealth,
} from '@tessera/protocol';
import type { IconName } from '@tessera/ui';

export interface ProviderView {
  id: string;
  name: string;
  enabled: boolean;
  status: HealthStatus;
  message: string | null;
  models: readonly AgentModel[];
  defaultModel: string | null;
  ready: boolean;
  readsPdfs: boolean;
}

export interface ModelPick {
  provider: string;
  model: string | null;
  effort: string | null;
}

export function providerViews(
  info: readonly AgentProviderInfo[] | undefined,
  health: readonly ProviderHealth[],
  on?: ReadonlySet<string>,
): ProviderView[] {
  if (!info)
    return health
      .filter((h) => h.kind === 'agent')
      .map((h) => ({
        id: h.providerId,
        name: h.displayName,
        enabled: true,
        status: h.status,
        message: h.message ?? null,
        models: [],
        defaultModel: null,
        ready: h.status === 'ok',
        readsPdfs: false,
      }));
  return info.map((p) => {
    const enabled = on ? on.has(p.id) : p.enabled;
    const live = enabled ? health.find((h) => h.kind === 'agent' && h.providerId === p.id) : undefined;
    const listed = enabled && !p.enabled ? 'unknown' : p.status;
    const status = !enabled ? 'disabled' : live && live.status !== 'unknown' ? live.status : listed;
    const message = !enabled ? null : ((live && live.status !== 'unknown' ? live.message : p.message) ?? null);
    return {
      id: p.id,
      name: p.name,
      enabled,
      status,
      message,
      models: enabled && p.enabled ? p.models : [],
      defaultModel: enabled && p.enabled ? (p.defaultModel ?? p.models[0]?.id ?? null) : null,
      ready: enabled && status === 'ok',
      readsPdfs: p.readsPdfs,
    };
  });
}

export function anyEnabled(providers: readonly ProviderView[]): boolean {
  return providers.some((p) => p.enabled);
}

export function findModel(providers: readonly ProviderView[], pick: ModelPick | null): AgentModel | null {
  if (!pick) return null;
  const p = providers.find((x) => x.id === pick.provider);
  return p?.models.find((m) => m.id === (pick.model ?? p.defaultModel)) ?? null;
}

export function resolvePick(
  providers: readonly ProviderView[],
  session: AgentSessionSummary | null,
  last: ModelPick | null,
): ModelPick | null {
  if (session) {
    const p = providers.find((x) => x.id === session.provider);
    return {
      provider: session.provider,
      model: session.model ?? p?.defaultModel ?? null,
      effort: session.effort ?? null,
    };
  }
  if (last) {
    const p = providers.find((x) => x.id === last.provider);
    if (p?.ready && (last.model === null || p.models.some((m) => m.id === last.model))) return last;
  }
  const first = providers.find((p) => p.ready);
  return first ? { provider: first.id, model: first.defaultModel, effort: null } : null;
}

export function effortOf(model: AgentModel | null, effort: string | null): string | null {
  if (!model || model.efforts.length === 0) return null;
  if (effort && model.efforts.some((e) => e.id === effort)) return effort;
  return model.defaultEffort ?? null;
}

export const INSTALL_PAGES: Readonly<Record<string, string>> = {
  'claude-code': 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex/releases/latest',
};

export const INSTALLS_HERE: ReadonlySet<string> = new Set(['claude-code']);

export function installPage(
  providerId: string,
  status: HealthStatus,
  message: string | null | undefined,
): string | null {
  if (status !== 'down' || !/not installed/i.test(message ?? '')) return null;
  return INSTALL_PAGES[providerId] ?? null;
}

export const OFF_WHY = 'Off: Tessera runs nothing of it until you turn it on, here or in Settings › Analyst.';

export function unavailableWhy(p: ProviderView): string | null {
  if (p.ready) return null;
  if (!p.enabled) return OFF_WHY;
  if (p.status === 'disconnected') return 'Not signed in. Sign in in Settings › Analyst.';
  if (p.status === 'unknown') return 'Checking…';
  if (installPage(p.id, p.status, p.message))
    return 'Not installed. Install it and sign in; it connects here by itself.';
  return p.message ?? 'Not available.';
}

export function pickLabel(providers: readonly ProviderView[], pick: ModelPick | null): string {
  if (!pick) return 'Turn on a model';
  const model = findModel(providers, pick);
  if (model) return model.label;
  return pick.model ?? providers.find((p) => p.id === pick.provider)?.name ?? pick.provider;
}

export function shortModelLabel(label: string, providerName: string): string {
  const word = providerName.trim().split(/\s+/)[0] ?? '';
  if (!word || label.length <= word.length || label.slice(0, word.length).toLowerCase() !== word.toLowerCase())
    return label;
  const rest = label.slice(word.length);
  return /^\s/.test(rest) && rest.trim() ? rest.trim() : label;
}

export function pickWords(providers: readonly ProviderView[], pick: ModelPick | null): { short: string; full: string } {
  const full = pickLabel(providers, pick);
  const model = findModel(providers, pick);
  const provider = pick ? providers.find((p) => p.id === pick.provider) : undefined;
  return { short: model && provider ? shortModelLabel(model.label, provider.name) : full, full };
}

export function effortRank(model: AgentModel | null, effort: string | null): { rank: number; of: number } | null {
  if (!model || !effort) return null;
  const rank = model.efforts.findIndex((e) => e.id === effort);
  return rank < 0 ? null : { rank, of: model.efforts.length };
}

export function searchModels(
  providers: readonly ProviderView[],
  query: string,
): { provider: ProviderView; model: AgentModel }[] {
  const q = query.trim().toLowerCase();
  const out: { provider: ProviderView; model: AgentModel }[] = [];
  for (const p of providers)
    for (const m of p.models)
      if (!q || `${m.label} ${m.id} ${p.name}`.toLowerCase().includes(q)) out.push({ provider: p, model: m });
  return out;
}

export function providerIcon(id: string): IconName {
  if (id === 'claude-code') return 'claude';
  if (id === 'codex') return 'codex';
  return 'analyst';
}
