import type { ConnectionInfo, Instrument, ProviderHealth } from '@tessera/protocol';
import { runTool, useTools, useToolValue } from '../app/tools.ts';
import { openMarket } from '../markets/actions.ts';
import { useShellData } from '../shell/shellData.ts';

const servesPrices = (c: Pick<ProviderHealth | ConnectionInfo, 'kind'>) => c.kind === 'market_data';

export function needsOnboarding(
  providers: readonly ProviderHealth[],
  infos: readonly ConnectionInfo[] | null,
): boolean | null {
  if (providers.length === 0 || infos === null) return null;
  return !providers.some(servesPrices) && !infos.some(servesPrices);
}

export function useNeedsOnboarding(): boolean | null {
  const { providers } = useShellData();
  const tools = useTools();
  const has = tools?.has('connections.list') ?? false;
  const list = useToolValue('connections.list', has ? {} : null, { keepFor: 5_000 });
  return needsOnboarding(providers, tools === null ? null : has ? (list?.connections ?? null) : []);
}

export function firstContract(instruments: readonly Instrument[]): string | null {
  return (instruments.find((i) => i.isFront) ?? instruments[0])?.id ?? null;
}

const FIRST_PRODUCTS = 4;

export async function chartFirstContract(connection: string): Promise<void> {
  const out = await runTool('market.list_instruments', {
    connection,
    assetClass: 'future',
    limit: FIRST_PRODUCTS,
  }).catch(() => null);
  const contract = firstContract(out?.connections.find((c) => c.id === connection)?.instruments ?? []);
  if (contract && !(await openMarket(contract, 'chart'))) await openMarket(contract, 'tab');
}
