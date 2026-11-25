import {
  keepPreviousData,
  queryOptions,
  useIsMutating,
  useMutation,
  useQuery,
  type Mutation,
  type Query,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  ContractError,
  Runtime,
  ToolDenied,
  ToolFailed,
  type ApprovalsResolveParams,
  type ApprovalsResolveResult,
  type CallOptions,
  type ToolDescriptor,
  type ToolError,
  type ToolMap,
  type ToolName,
} from '@tessera/protocol';
import { useLoadPending } from '@tessera/ui';
import { stableStringify } from '../workspace/layouts.ts';
import { everConnectedStore } from './connection.ts';
import { queryClient, TOOL_LIST, TOOL_READS, TOOL_WRITES } from './queries.ts';
import { appClient } from './services.ts';
import { useStore } from './store.ts';

export type ToolInput<N extends ToolName> = ToolMap[N]['input'];
export type ToolOutput<N extends ToolName> = ToolMap[N]['output'];

export type ToolResult<N extends ToolName> = UseQueryResult<ToolOutput<N>, ToolError>;

export interface ToolReadOptions {
  readonly keepFor?: number | undefined;
  readonly refreshEvery?: number | undefined;
}

export function toolKey<N extends ToolName>(name: N, input: ToolInput<N> | null) {
  return [TOOL_READS, name, input] as const;
}

function retryTransport(failures: number, error: ToolError): boolean {
  return failures < 1 && (error._tag === 'ConnectionLost' || error._tag === 'RequestTimeout');
}

export function toolQuery<N extends ToolName>(name: N, input: ToolInput<N>, options: ToolReadOptions = {}) {
  return queryOptions<ToolOutput<N>, ToolError>({
    queryKey: toolKey(name, input),
    queryFn: () => Runtime.invoke(appClient(), name, input),
    gcTime: options.keepFor ?? 30_000,
    ...(options.refreshEvery === undefined ? {} : { refetchInterval: options.refreshEvery }),
    retry: retryTransport,
    retryDelay: 1_000,
  });
}

export function peekTool<N extends ToolName>(name: N, input: ToolInput<N>): ToolOutput<N> | undefined {
  return queryClient.getQueryData<ToolOutput<N>>(toolKey(name, input));
}

export interface UseToolOptions extends ToolReadOptions {
  readonly keepPrevious?: boolean | undefined;
}

export function useTool<N extends ToolName>(
  name: N,
  input: ToolInput<N> | null,
  options: UseToolOptions = {},
): ToolResult<N> {
  const connected = useStore(everConnectedStore);
  const query = toolQuery(name, input!, options);
  const result = useQuery(
    {
      ...query,
      enabled: connected && input !== null,
      ...(options.keepPrevious ? { placeholderData: keepPreviousData } : {}),
    },
    queryClient,
  );
  useLoadPending(input !== null && result.isPending);
  return result;
}

export function useToolValue<N extends ToolName>(
  name: N,
  input: ToolInput<N> | null,
  options?: UseToolOptions,
): ToolOutput<N> | undefined {
  return useTool(name, input, options).data;
}

type ToolList = ReadonlyMap<string, ToolDescriptor>;

function sameToolList(a: ToolList, b: ToolList): boolean {
  if (a.size !== b.size) return false;
  for (const [name, tool] of a) {
    const other = b.get(name);
    if (!other || stableStringify(other) !== stableStringify(tool)) return false;
  }
  return true;
}

export const toolListQuery = queryOptions<ToolList, ToolError>({
  queryKey: [TOOL_LIST],
  queryFn: async () => new Map((await Runtime.listTools(appClient())).map((t) => [t.name, t])),
  gcTime: Infinity,
  structuralSharing: (old, next) =>
    old instanceof Map && next instanceof Map && sameToolList(old as ToolList, next as ToolList) ? old : next,
});

export function useTools(): ReadonlyMap<string, ToolDescriptor> | null {
  const connected = useStore(everConnectedStore);
  const tools = useQuery({ ...toolListQuery, enabled: connected }, queryClient);
  useLoadPending(tools.isPending);
  return tools.data ?? null;
}

export function useHasTool(name: string): boolean {
  return useTools()?.has(name) ?? false;
}

export function setTools(tools: ReadonlyMap<string, ToolDescriptor>): void {
  queryClient.setQueryData(toolListQuery.queryKey, tools);
}

export interface RunToolOptions extends Runtime.InvokeOptions {
  readonly refresh?: readonly string[] | undefined;
}

export async function runTool<N extends ToolName>(
  name: N,
  input: ToolInput<N>,
  options: RunToolOptions = {},
): Promise<ToolOutput<N>> {
  const { refresh, ...invokeOptions } = options;
  const output = await Runtime.invoke(appClient(), name, input, invokeOptions);
  if (refresh?.length) void refreshTools(...refresh);
  return output;
}

function sameFields(input: unknown, fields: object): boolean {
  if (!input || typeof input !== 'object') return false;
  const given = input as Record<string, unknown>;
  return Object.entries(fields).every(([key, value]) => given[key] === value);
}

export function useToolAction<N extends ToolName>(
  name: N,
  options: RunToolOptions = {},
  busyWith?: Partial<ToolInput<N>> | null,
) {
  const mutationKey = [TOOL_WRITES, name];
  const { mutateAsync } = useMutation<ToolOutput<N>, unknown, ToolInput<N>>(
    { mutationKey, mutationFn: (input) => runTool(name, input, options), networkMode: 'always' },
    queryClient,
  );
  const filters = { mutationKey, predicate: (m: Mutation) => sameFields(m.state.variables, busyWith ?? {}) };
  const running = useIsMutating(filters, queryClient);
  return { run: mutateAsync, pending: running > 0, running: () => queryClient.isMutating(filters) > 0 };
}

export async function runToolResult<N extends ToolName>(
  name: N,
  input: ToolInput<N>,
  options: RunToolOptions = {},
): Promise<Runtime.ToolCallResult<ToolOutput<N>>> {
  const { refresh, ...invokeOptions } = options;
  const result = await Runtime.invokeResult(appClient(), name, input, invokeOptions);
  if (refresh?.length) void refreshTools(...refresh);
  return result;
}

export function approve(params: ApprovalsResolveParams, options: CallOptions = {}): Promise<ApprovalsResolveResult> {
  return Runtime.resolveApproval(appClient(), params, { queue: false, ...options });
}

export function ranUnread(error: unknown): boolean {
  return error instanceof ContractError && error.ran === true;
}

function readOf(names: readonly string[]) {
  return (query: Query): boolean => {
    const [kind, tool] = query.queryKey;
    if (kind !== TOOL_READS || typeof tool !== 'string') return false;
    return names.some((n) => (n.endsWith('.*') ? tool.startsWith(n.slice(0, -1)) : tool === n));
  };
}

export function refreshTools(...names: string[]): Promise<void> {
  void queryClient.invalidateQueries({ predicate: readOf(names) });
  return Promise.resolve();
}

export function refreshUnread(name: ToolName): void {
  void queryClient.refetchQueries({ predicate: readOf([name]), type: 'inactive' });
}

export function toolCode(err: unknown): string | null {
  if (err instanceof ToolFailed || err instanceof ToolDenied) return err.code;
  return null;
}

export function toolDetails(err: unknown): unknown {
  return err instanceof ToolFailed ? err.details : null;
}

export function toolReason(err: unknown): string {
  if (err instanceof ToolFailed || err instanceof ToolDenied) return err.message;
  return failureText(err);
}

export function failureText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function valueOf<A, E>(result: UseQueryResult<A, E>): A | undefined {
  return result.data;
}
