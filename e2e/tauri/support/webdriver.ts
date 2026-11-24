import { vi } from 'vitest';
import { HANG_GUARD_MS } from '../../../vitest.hang-guards.ts';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export interface Element {
  [ELEMENT]: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class WebDriverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export class Session {
  private readonly base: string;
  readonly id: string;

  private constructor(base: string, id: string) {
    this.base = base;
    this.id = id;
  }

  static async create(base: string, capabilities: Record<string, unknown>): Promise<Session> {
    const value = await call<{ sessionId: string }>(base, 'POST', '/session', {
      capabilities: { alwaysMatch: capabilities },
    });
    return new Session(base, value.sessionId);
  }

  private send<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return call<T>(this.base, method, `/session/${this.id}${path}`, body);
  }

  handles(): Promise<string[]> {
    return this.send('GET', '/window/handles');
  }

  handle(): Promise<string> {
    return this.send('GET', '/window');
  }

  async switchTo(handle: string): Promise<void> {
    await this.send('POST', '/window', { handle });
  }

  title(): Promise<string> {
    return this.send('GET', '/title');
  }

  execute<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.send('POST', '/execute/sync', { script, args });
  }

  async settle(): Promise<void> {
    await this.send('POST', '/execute/async', {
      script: 'const done = arguments[0]; setTimeout(() => setTimeout(done, 0), 0);',
      args: [],
    });
  }

  async click(element: Element): Promise<void> {
    await this.send('POST', `/element/${element[ELEMENT]}/click`, {});
  }

  async hover(element: Element): Promise<void> {
    await this.send('POST', '/actions', {
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [{ type: 'pointerMove', origin: element, x: 0, y: 0 }],
        },
      ],
    });
  }

  async keys(element: Element, text: string): Promise<void> {
    await this.send('POST', `/element/${element[ELEMENT]}/value`, { text });
  }

  async press(...keys: string[]): Promise<void> {
    const down = keys.map((value) => ({ type: 'keyDown', value }));
    const up = [...keys].reverse().map((value) => ({ type: 'keyUp', value }));
    await this.send('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [...down, ...up] }] });
  }

  async closeWindow(): Promise<void> {
    await this.send('DELETE', '/window');
  }

  async end(): Promise<void> {
    await this.send('DELETE', '').catch(() => undefined);
  }
}

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { value: T | { error: string; message: string } };
  const value = json.value;
  if (!res.ok) {
    const failure = value as { error?: string; message?: string };
    throw new WebDriverError(failure.error ?? String(res.status), failure.message ?? res.statusText);
  }
  return value as T;
}

export function until<T>(what: string, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  return vi.waitFor(
    async () => {
      let value: T | null | undefined | false;
      try {
        value = await probe();
      } catch (error) {
        throw new Error(`waiting for ${what}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
      if (!value) throw new Error(`waiting for ${what}`);
      return value;
    },
    { timeout: HANG_GUARD_MS, interval: 100 },
  );
}

export async function untilSaying<T extends object>(what: string, probe: () => Promise<T | string>): Promise<T> {
  let why = '';
  try {
    return await until(what, async () => {
      const value = await probe();
      if (typeof value !== 'string') return value;
      why = value;
      return null;
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}: ${why}`, { cause: error });
  }
}
