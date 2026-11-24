import type { EngineTimers, GpuCanvasLike } from '../src/index.ts';

export interface GlCall {
  name: string;
  args: unknown[];
}

export function fakeGl(): { gl: WebGL2RenderingContext; calls: GlCall[]; count(name: string): number } {
  const calls: GlCall[] = [];
  const constants = new Map<string, number>();
  const lose = { loseContext: () => calls.push({ name: 'loseContext', args: [] }) };
  const target: Record<string, unknown> = {
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? lose : null),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    isContextLost: () => false,
  };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (/^[A-Z0-9_]+$/.test(prop)) {
        if (!constants.has(prop)) constants.set(prop, 0x1000 + constants.size);
        return constants.get(prop);
      }
      const own = t[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (typeof own === 'function') return (own as (...a: unknown[]) => unknown)(...args);
        if (prop.startsWith('create')) return { id: calls.length };
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls, count: (name) => calls.filter((c) => c.name === name).length };
}

export class FakeGpuCanvas implements GpuCanvasLike {
  width: number;
  height: number;
  readonly fake = fakeGl();
  private readonly listeners = new Map<string, Set<(e: { preventDefault(): void }) => void>>();
  prevented = 0;
  constructor(
    width: number,
    height: number,
    private readonly supports = true,
  ) {
    this.width = width;
    this.height = height;
  }

  getContext(): unknown {
    return this.supports ? this.fake.gl : null;
  }

  addEventListener(type: string, cb: (e: { preventDefault(): void }) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: { preventDefault(): void }) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  fire(type: 'webglcontextlost' | 'webglcontextrestored'): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) {
      cb({
        preventDefault: () => {
          this.prevented++;
        },
      });
    }
  }

  listening(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export class ManualTimers implements EngineTimers {
  time = 0;
  private seq = 0;
  private readonly queue = new Map<number, { at: number; cb: () => void }>();

  now(): number {
    return this.time;
  }

  set(cb: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.set(id, { at: this.time + Math.max(0, ms), cb });
    return id;
  }

  clear(handle: unknown): void {
    this.queue.delete(handle as number);
  }

  get pending(): number {
    return this.queue.size;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let next: [number, { at: number; cb: () => void }] | null = null;
      for (const e of this.queue) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.queue.delete(next[0]);
      this.time = next[1].at;
      next[1].cb();
    }
    this.time = end;
  }
}
