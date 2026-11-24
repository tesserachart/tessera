import { useQuery } from '@tanstack/react-query';
import { Runtime, type ContractForOutput, type ContractSpec, type ToolName } from '@tessera/protocol';
import { everConnectedStore } from '../app/connection.ts';
import { queryClient } from '../app/queries.ts';
import { appClient } from '../app/services.ts';
import { useStore } from '../app/store.ts';
import { failureText, toolKey, useHasTool, type ToolInput } from '../app/tools.ts';
import { screenWords } from '../shell/deskWords.ts';

export interface Traded {
  instrument: string | null;
  spec: ContractSpec | null;
  meant: string | null;
  refused: string | null;
  pending: boolean;
}

const TOOL = 'orders.contract_for' satisfies ToolName;

export const CONTRACT_ANSWERS: string = TOOL;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function contractWords(c: ContractForOutput['wanted']): string | null {
  if (!c) return null;
  const [y, m] = (c.expiry ?? '').split('-');
  const month = MONTHS[Number(m) - 1];
  return c.expiry && month ? `${c.root} ${month} ${y!}` : c.root;
}

const CONTRACT_UNKNOWN = 'The broker did not name this contract. It asks again shortly.';

export function tradedContract(answer: ContractForOutput | null | undefined): Traded {
  if (!answer) return { instrument: null, spec: null, meant: null, refused: null, pending: answer === undefined };
  return {
    instrument: answer.instrument?.id ?? null,
    spec: answer.spec,
    meant: contractWords(answer.wanted),
    refused: answer.instrument
      ? null
      : answer.refused
        ? screenWords(answer.refused, CONTRACT_UNKNOWN)
        : `${answer.account} has no such contract`,
    pending: false,
  };
}

type Outcome = { ok: true; answer: ContractForOutput } | { ok: false; error: unknown };

const ASK_AGAIN_MS = 5_000;

export function useAccountContract(
  accountId: string | null,
  instrument: string | null,
  root: string | null = null,
  enabled = true,
): Traded {
  const has = useHasTool('orders.contract_for');
  const connected = useStore(everConnectedStore);
  const ask = has && enabled && accountId !== null && instrument !== null && instrument !== '';
  const input: ToolInput<typeof TOOL> | null = ask ? { accountId, instrument, ...(root ? { root } : {}) } : null;
  const last = useQuery(
    {
      queryKey: [...toolKey(TOOL, input), 'outcome'],
      queryFn: () => askContract(input!),
      enabled: connected && input !== null,
      gcTime: 5_000,
      retry: false,
      refetchInterval: (query) => (named(query.state.data) ? false : ASK_AGAIN_MS),
      refetchIntervalInBackground: true,
    },
    queryClient,
  ).data;
  if (!ask) return tradedContract(null);
  if (last === undefined) return tradedContract(undefined);
  if (last.ok) return tradedContract(last.answer);
  return { ...tradedContract(null), refused: screenWords(failureText(last.error), CONTRACT_UNKNOWN) };
}

function askContract(input: ToolInput<typeof TOOL>): Promise<Outcome> {
  return Runtime.invoke(appClient(), TOOL, input).then(
    (answer): Outcome => ({ ok: true, answer }),
    (error: unknown): Outcome => ({ ok: false, error }),
  );
}

function named(outcome: Outcome | undefined): boolean {
  return outcome?.ok === true && outcome.answer.instrument !== null;
}
