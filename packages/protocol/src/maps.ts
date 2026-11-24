import type {
  ApprovalsResolveParams,
  ApprovalsResolveResult,
  HelloParams,
  HelloResult,
  SubscribeParams,
  SubscribeResult,
  ToolDescriptor,
  ToolMap,
  ToolResult,
  ToolsInvokeParams,
  ToolsListParams,
  TopicMap,
  UnsubscribeParams,
  UnsubscribeResult,
} from './gen/index.ts';

export type { ToolMap, TopicMap } from './gen/index.ts';

export const PROTOCOL_VERSION = 1;

export const ORDER_FRESH_MS = 20_000;

export const LATE_ORDER = 'Too late. The runtime did not take it in time. Nothing sent.';

export function orderDeadlineNs(nowMs = Date.now(), freshMs = ORDER_FRESH_MS): number {
  return (nowMs + freshMs) * 1_000_000;
}

export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  unauthorized: -32001,
  forbidden: -32002,
  unknownTopic: -32003,
  notFound: -32004,
  previewHashMismatch: -32010,
  stale: -32011,
  alreadyResolved: -32012,
  conflict: -32013,
  unsupported: -32014,
  unavailable: -32015,
  shuttingDown: -32020,
} as const;

export interface RpcMethods {
  'session.hello': { params: HelloParams; result: HelloResult };
  'tools.list': { params: ToolsListParams | undefined; result: ToolDescriptor[] };
  'tools.invoke': { params: ToolsInvokeParams; result: ToolResult };
  subscribe: { params: SubscribeParams; result: SubscribeResult };
  unsubscribe: { params: UnsubscribeParams; result: UnsubscribeResult };
  'approvals.resolve': { params: ApprovalsResolveParams; result: ApprovalsResolveResult };
}

export type RpcMethodName = keyof RpcMethods;

export type TopicName = keyof TopicMap;

export type ToolName = keyof ToolMap;
