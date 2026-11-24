import { z } from 'zod';
import type { ToolName, TopicName } from './maps.ts';
import type { CallOptions, RuntimeClient, SubscriptionEvent, TopicOptions } from './runtimeClient.ts';
import { ContractError, ToolAwaitingApproval, ToolDenied, ToolFailed, type ClientClosed } from './runtimeErrors.ts';
import * as S from './schemas.gen.ts';
import type {
  ApprovalsResolveParams,
  ApprovalsResolveResult,
  InvokeSurface,
  ToolDescriptor,
  ToolMap,
  ToolResult,
  ToolsListParams,
  TopicMap,
} from './gen/index.ts';

export interface InvokeOptions extends CallOptions {
  readonly idempotencyKey?: string | undefined;
  readonly surface?: InvokeSurface | undefined;
  readonly deadline?: number | undefined;
}

export type ToolCallResult<O> = Omit<ToolResult, 'output'> & { output: O | null };

export function decode<A>(schema: z.ZodType<A>, source: string, value: unknown, ran?: boolean): A {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ContractError({
    source,
    message: z.prettifyError(result.error),
    ...(ran === undefined ? {} : { ran }),
  });
}

export const asSent = (value: unknown): unknown => {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map((v: unknown) => (v === undefined ? null : asSent(v)));
  if (value === null || typeof value !== 'object') return value;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = asSent(v);
  return out;
};

export async function invokeResult<N extends ToolName>(
  client: RuntimeClient,
  name: N,
  input: ToolMap[N]['input'],
  options: InvokeOptions = {},
): Promise<ToolCallResult<ToolMap[N]['output']>> {
  const params = {
    name,
    input: asSent(input),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.surface === undefined ? {} : { surface: options.surface }),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  };
  const raw = await client.request('tools.invoke', params, {
    timeoutMs: options.timeoutMs,
    queue: options.queue,
    onLate: options.onLate,
  });
  const result = decode(S.ToolResult, 'tools.invoke', raw);
  const schema = S.ToolOutputs[name] as z.ZodType<ToolMap[N]['output']>;
  const output = result.status === 'ok' ? decode(schema, `tool ${name}`, result.output, true) : null;
  return { ...result, output };
}

export async function invoke<N extends ToolName>(
  client: RuntimeClient,
  name: N,
  input: ToolMap[N]['input'],
  options?: InvokeOptions,
): Promise<ToolMap[N]['output']> {
  const r = await invokeResult(client, name, input, options);
  switch (r.status) {
    case 'ok':
      return r.output!;
    case 'pending_approval':
      throw new ToolAwaitingApproval({
        tool: name,
        approvalId: r.approval?.approvalId ?? '',
        draftId: r.approval?.draftId ?? null,
        callId: r.callId,
      });
    case 'denied':
      throw new ToolDenied({
        tool: name,
        code: r.error?.code ?? 'denied',
        message: r.error?.message ?? `${name}: denied`,
        callId: r.callId,
      });
    case 'error':
      throw new ToolFailed({
        tool: name,
        code: r.error?.code ?? 'error',
        message: r.error?.message ?? `${name}: failed`,
        details: r.error?.details ?? null,
        callId: r.callId,
      });
  }
}

export interface TopicReadOptions extends TopicOptions {
  readonly invalid?: 'fail' | 'log' | undefined;
}

export type TopicSignal<A> =
  SubscriptionEvent<A> | { readonly _tag: 'Ended'; readonly error: ClientClosed | ContractError };

export function topic<T extends TopicName>(
  client: RuntimeClient,
  name: T,
  params: TopicMap[T]['params'],
  sink: (signal: TopicSignal<TopicMap[T]['data']>) => void,
  options: TopicReadOptions = {},
): () => void {
  const schema = S.TopicEvents[name] as z.ZodType<TopicMap[T]['data']>;
  const { invalid = 'fail', ...subscribeOptions } = options;
  let ended = false;
  const stop = client.subscribe(
    name,
    asSent(params),
    (signal) => {
      if (ended) return;
      if (signal._tag === 'Closed') {
        ended = true;
        sink({ _tag: 'Ended', error: signal.error });
        return;
      }
      if (signal._tag !== 'Event') {
        sink(signal);
        return;
      }
      let data: TopicMap[T]['data'];
      try {
        data = decode(schema, `topic ${name}`, signal.data);
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        if (invalid === 'log') {
          console.error(error.message);
          return;
        }
        ended = true;
        stop();
        sink({ _tag: 'Ended', error });
        return;
      }
      sink({ ...signal, data });
    },
    subscribeOptions,
  );
  return () => {
    ended = true;
    stop();
  };
}

export async function listTools(
  client: RuntimeClient,
  params?: ToolsListParams,
  options?: CallOptions,
): Promise<ToolDescriptor[]> {
  const raw = await client.request('tools.list', params, options);
  return decode(z.array(S.ToolDescriptor), 'tools.list', raw);
}

export async function resolveApproval(
  client: RuntimeClient,
  params: ApprovalsResolveParams,
  options?: CallOptions,
): Promise<ApprovalsResolveResult> {
  const raw = await client.request('approvals.resolve', asSent(params), options);
  return decode(S.ApprovalsResolveResult, 'approvals.resolve', raw, true);
}
