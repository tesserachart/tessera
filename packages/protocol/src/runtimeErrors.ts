export class EndpointUnavailable extends Error {
  readonly _tag = 'EndpointUnavailable';
  readonly code: string | null;
  constructor(args: { message: string; code: string | null }) {
    super(args.message);
    this.name = 'EndpointUnavailable';
    this.code = args.code;
  }
}

export class RemoteError extends Error {
  readonly _tag = 'RemoteError';
  readonly method: string;
  readonly code: number;
  readonly data: unknown;
  constructor(args: { method: string; code: number; message: string; data: unknown }) {
    super(args.message);
    this.name = 'RemoteError';
    this.method = args.method;
    this.code = args.code;
    this.data = args.data;
  }
}

export class RequestTimeout extends Error {
  readonly _tag = 'RequestTimeout';
  readonly method: string;
  readonly timeoutMs: number;
  constructor(args: { method: string; timeoutMs: number }) {
    super(`${args.method}: no response within ${String(args.timeoutMs)}ms`);
    this.name = 'RequestTimeout';
    this.method = args.method;
    this.timeoutMs = args.timeoutMs;
  }
}

export class ConnectionLost extends Error {
  readonly _tag = 'ConnectionLost';
  readonly method: string;
  readonly reason: string;
  constructor(args: { method: string; reason: string }) {
    super(`${args.method}: connection lost (${args.reason})`);
    this.name = 'ConnectionLost';
    this.method = args.method;
    this.reason = args.reason;
  }
}

export class NotConnected extends Error {
  readonly _tag = 'NotConnected';
  readonly method: string;
  constructor(args: { method: string }) {
    super(`${args.method}: not connected`);
    this.name = 'NotConnected';
    this.method = args.method;
  }
}

export class ClientClosed extends Error {
  readonly _tag = 'ClientClosed';
  readonly method: string;
  constructor(args: { method: string }) {
    super(`${args.method}: client closed`);
    this.name = 'ClientClosed';
    this.method = args.method;
  }
}

export class ContractError extends Error {
  readonly _tag = 'ContractError';
  readonly source: string;
  declare readonly ran?: boolean;
  constructor(args: { source: string; message: string; ran?: boolean }) {
    super(args.message);
    this.name = 'ContractError';
    this.source = args.source;
    if (args.ran !== undefined) (this as { ran?: boolean }).ran = args.ran;
  }
}

export type RequestError = RemoteError | RequestTimeout | ConnectionLost | ClientClosed | NotConnected;

export class ToolFailed extends Error {
  readonly _tag = 'ToolFailed';
  readonly tool: string;
  readonly code: string;
  readonly details: unknown;
  readonly callId: string;
  constructor(args: { tool: string; code: string; message: string; details: unknown; callId: string }) {
    super(args.message);
    this.name = 'ToolFailed';
    this.tool = args.tool;
    this.code = args.code;
    this.details = args.details;
    this.callId = args.callId;
  }
}

export class ToolDenied extends Error {
  readonly _tag = 'ToolDenied';
  readonly tool: string;
  readonly code: string;
  readonly callId: string;
  constructor(args: { tool: string; code: string; message: string; callId: string }) {
    super(args.message);
    this.name = 'ToolDenied';
    this.tool = args.tool;
    this.code = args.code;
    this.callId = args.callId;
  }
}

export class ToolAwaitingApproval extends Error {
  readonly _tag = 'ToolAwaitingApproval';
  readonly tool: string;
  readonly approvalId: string;
  readonly draftId: string | null;
  readonly callId: string;
  constructor(args: { tool: string; approvalId: string; draftId: string | null; callId: string }) {
    super(`${args.tool}: waiting for approval`);
    this.name = 'ToolAwaitingApproval';
    this.tool = args.tool;
    this.approvalId = args.approvalId;
    this.draftId = args.draftId;
    this.callId = args.callId;
  }
}

export type ToolError = ToolFailed | ToolDenied | ToolAwaitingApproval | ContractError | RequestError;
