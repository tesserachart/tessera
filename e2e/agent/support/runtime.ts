import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RuntimeInfo {
  origin: string;
  token: string;
  ticket: string | null;
}

export function runtimeInfoPath(port: number | string): string {
  return join(tmpdir(), `tessera-e2e-agent-${String(port)}.json`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs && !existsSync(path); waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return existsSync(path);
}

export async function readRuntimeInfo(baseUrl: string | undefined): Promise<RuntimeInfo> {
  if (!baseUrl) throw new Error('the target declares no app.url (see e2e.config.ts)');
  const path = runtimeInfoPath(new URL(baseUrl).port);
  if (!(await waitForFile(path, 5_000))) {
    throw new Error(
      `no runtime connection info at ${path}: the app command (e2e/agent/support/serve.ts) is not running`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as RuntimeInfo;
}

interface RpcResponse {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  ok: boolean;
  status: string;
  output: unknown;
  error: { code: string; message: string } | null;
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface Hello {
  defaultLayoutId: string;
}

export interface LayoutModel {
  id: string;
  revision: number;
  unsaved?: boolean;
  dock: unknown;
  charts: Record<
    string,
    {
      instrument: string;
      timeframe: string;
      layers: { kind: string; visible: boolean }[];
      drawings?: { id: string; kind: string; style: { color: string } }[];
    }
  >;
}

export class RuntimeRpc {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, Waiter>();
  #next = 1;
  #hello: Hello | null = null;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as RpcResponse;
      if (msg.id === undefined) return;
      const waiter = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) waiter?.reject(new Error(`runtime: ${msg.error.message} (${String(msg.error.code)})`));
      else waiter?.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const waiter of this.#pending.values()) waiter.reject(new Error('runtime connection closed'));
      this.#pending.clear();
    });
  }

  static async open(info: RuntimeInfo): Promise<RuntimeRpc> {
    const rpc = new RuntimeRpc(new WebSocket(`${info.origin.replace(/^http/, 'ws')}/ws`));
    await new Promise<void>((resolve, reject) => {
      rpc.#ws.addEventListener('open', () => resolve(), { once: true });
      rpc.#ws.addEventListener('error', () => reject(new Error(`could not connect to the runtime at ${info.origin}`)), {
        once: true,
      });
    });
    rpc.#hello = await rpc.call<Hello>('session.hello', {
      client: { name: 'tessera-e2e-agent', version: '0', platform: 'node' },
      protocolVersion: 1,
      token: info.token,
    });
    return rpc;
  }

  get hello(): Hello {
    if (!this.#hello) throw new Error('RuntimeRpc.open() has not finished');
    return this.#hello;
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.#ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async tool<T>(name: string, input: unknown): Promise<T> {
    const result = await this.call<ToolResult>('tools.invoke', { name, input });
    if (!result.ok || result.status !== 'ok') {
      throw new Error(`${name}: ${result.error ? `${result.error.code}: ${result.error.message}` : result.status}`);
    }
    return result.output as T;
  }

  layout(layoutId: string): Promise<LayoutModel> {
    return this.tool<LayoutModel>('layout.get', { layoutId });
  }

  close(): void {
    this.#ws.close();
  }
}
