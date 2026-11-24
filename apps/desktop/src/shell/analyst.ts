import type { AgentSessionSummary, Approval, ChartLayer, Level, ProviderHealth } from '@tessera/protocol';
import { layerFactory } from '../chart/layers/index.ts';
import { levelsForLayer, levelsParams } from '../chart/levels.ts';

const LEVEL_GROUP: Record<string, string> = {
  pd: 'Prior day',
  on: 'Overnight',
  or: 'Opening range',
  ib: 'Initial balance',
  va: 'Value area',
};

export function layerWords(layers: readonly ChartLayer[], levels: readonly Level[]): string[] {
  const words: string[] = [];
  const add = (w: string) => {
    if (!words.includes(w)) words.push(w);
  };
  for (const l of layers) {
    if (!l.visible) continue;
    if (l.kind === 'levels') {
      if (levelsForLayer(l, levels).length === 0) continue;
      const { vendor, group } = levelsParams(l);
      if (vendor) add(vendor);
      else add((group && LEVEL_GROUP[group]) ?? 'Levels');
    } else if (l.kind === 'volume') add('Volume');
    else add(layerFactory(l.kind)?.label(l) ?? l.kind.toUpperCase());
  }
  return words;
}

export function seesLine(chartLabel: string | null, words: readonly string[], account: string | null): string | null {
  const parts = [chartLabel, ...(chartLabel ? words : []), account].filter((s): s is string => !!s);
  return parts.length > 0 ? `Sees ${parts.join(' · ')}` : null;
}

export function agentProvider(
  providers: readonly ProviderHealth[],
  session: AgentSessionSummary | null,
): ProviderHealth | null {
  const agents = providers.filter((p) => p.kind === 'agent');
  return (
    (session ? agents.find((p) => p.providerId === session.provider) : undefined) ??
    agents.find((p) => p.status === 'ok') ??
    agents[0] ??
    null
  );
}

export function pickApproval(pending: readonly Approval[], session: AgentSessionSummary | null): Approval[] {
  const mine = session ? pending.filter((a) => a.sessionId === session.id) : [];
  return mine.length > 0 ? mine : pending.filter((a) => a.sessionId === null);
}

export function emptyAction(
  providers: readonly ProviderHealth[],
  session: AgentSessionSummary | null,
  canStart: boolean,
): { kind: 'start'; providers: ProviderHealth[] } | { kind: 'connect' } | null {
  if (session) return null;
  const ready = canStart ? providers.filter((p) => p.kind === 'agent' && p.status === 'ok') : [];
  return ready.length > 0 ? { kind: 'start', providers: ready } : { kind: 'connect' };
}

export const NO_PROVIDER = 'No model is on yet. Turn one on, then ask again: your question waits here.';

export type SendPlan =
  { kind: 'send'; sessionId: string } | { kind: 'start'; providerId: string } | { kind: 'blocked'; text: string };

export function sendPlan(opts: {
  provider: ProviderHealth | null;
  canSend: boolean;
  session: AgentSessionSummary | null;
  empty: ReturnType<typeof emptyAction>;
}): SendPlan {
  const connected = opts.provider ? opts.provider.status === 'ok' : opts.session !== null;
  if (!connected) return { kind: 'blocked', text: NO_PROVIDER };
  if (!opts.canSend) return { kind: 'blocked', text: 'Sending to the analyst is not in this build yet.' };
  if (opts.session) return { kind: 'send', sessionId: opts.session.id };
  const first = opts.empty?.kind === 'start' ? opts.empty.providers[0] : undefined;
  if (first) return { kind: 'start', providerId: first.providerId };
  return { kind: 'blocked', text: 'This build cannot start an analyst session.' };
}
