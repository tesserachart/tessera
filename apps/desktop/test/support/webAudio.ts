import { vi } from 'vitest';

export type Wake = 'running' | 'suspended' | 'stalled' | 'stuck';

const FIRST_RENDER_S = 0.012;

const refused = (why: string) => Promise.reject(new DOMException(why, 'InvalidStateError'));

const param = () => ({
  value: 0,
  setValueAtTime: () => undefined,
  linearRampToValueAtTime: () => undefined,
  exponentialRampToValueAtTime: () => undefined,
});

class FakeNode {
  connected = false;
  readonly gain = param();

  constructor(readonly ctx: FakeContext) {
    ctx.nodes.push(this);
  }

  connect<T>(to: T): T {
    this.connected = true;
    return to;
  }

  disconnect(): void {
    this.connected = false;
  }
}

class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  type = 'sine';
  readonly frequency = param();
  buffer: { url: string; duration: number } | null = null;
  private at: number | null = null;
  private until = Infinity;
  private sounded = false;
  private ended = false;

  constructor(ctx: FakeContext) {
    super(ctx);
    ctx.sources.push(this);
  }

  start(when = 0): void {
    this.at = Math.max(when, this.ctx.currentTime);
    if (this.buffer) this.until = this.at + this.buffer.duration;
  }

  stop(when = 0): void {
    this.until = Math.max(when, this.ctx.currentTime);
  }

  rendered(now: number): boolean {
    if (this.at === null || this.ended) return false;
    if (!this.sounded && now >= this.at) {
      this.sounded = true;
      if (this.ctx.audible) this.ctx.world.heard.push(this.buffer ? `clip ${this.buffer.url}` : 'tone');
    }
    if (now < this.until) return false;
    this.ended = true;
    this.onended?.();
    return true;
  }
}

export class FakeContext {
  state: AudioContextState = 'suspended';
  readonly destination = {};
  readonly nodes: FakeNode[] = [];
  readonly sources: FakeSource[] = [];
  clock = 0;
  stalled = false;
  audible = true;
  held = false;
  private warmingMs = 0;
  private warmed = false;
  private readonly neverStarts: boolean;
  private allowed: boolean;
  private waiting: (() => void)[] = [];
  private starting = false;

  constructor(readonly world: WebKitAudio) {
    this.allowed = world.autoplay;
    this.neverStarts = world.brokenStarts > 0;
    if (this.neverStarts) world.brokenStarts--;
    if (world.bornInterrupted) {
      this.state = 'interrupted';
      this.held = true;
    }
    world.made.push(this);
  }

  get currentTime(): number {
    return this.clock;
  }

  resume(): Promise<void> {
    if (this.state === 'closed') return refused('closed');
    if (this.held) {
      this.state = 'interrupted';
      return refused('interrupted');
    }
    if (this.state === 'running') return Promise.resolve();
    if (this.world.inGesture) this.allowed = true;
    if (!this.allowed) return Promise.reject(new DOMException('needs a gesture', 'NotAllowedError'));
    if (this.neverStarts) return new Promise(() => undefined);
    const done = new Promise<void>((resolve) => this.waiting.push(resolve));
    if (!this.starting) {
      this.starting = true;
      setTimeout(() => {
        this.starting = false;
        if (this.state === 'closed' || this.held) return;
        this.state = 'running';
        for (const resolve of this.waiting.splice(0)) resolve();
      }, this.world.startMs);
    }
    return done;
  }

  close(): Promise<void> {
    if (this.state === 'closed') return refused('closed');
    this.state = 'closed';
    this.waiting = [];
    return Promise.resolve();
  }

  createGain = (): FakeNode => new FakeNode(this);
  createOscillator = (): FakeSource => new FakeSource(this);
  createBufferSource = (): FakeSource => new FakeSource(this);

  decodeAudioData(bytes: ArrayBuffer): Promise<{ url: string; duration: number }> {
    return Promise.resolve({ url: new TextDecoder().decode(bytes), duration: this.world.clipSeconds });
  }

  render(ms: number): void {
    if (this.state !== 'running' || this.stalled) return;
    if (!this.warmed) {
      this.warmed = true;
      this.warmingMs = this.world.warmupMs;
    }
    if (this.warmingMs > 0) {
      this.clock = Math.max(this.clock, FIRST_RENDER_S);
      this.warmingMs -= ms;
      return;
    }
    this.clock += ms / 1000;
    const playing = this.sources.filter((s) => !s.rendered(this.clock));
    this.sources.splice(0, this.sources.length, ...playing);
  }
}

const GESTURES: ReadonlySet<string> = new Set(['pointerdown', 'keydown']);

export class WebKitAudio {
  readonly made: FakeContext[] = [];
  readonly heard: string[] = [];
  autoplay = true;
  startMs = 40;
  clipSeconds = 0.9;
  warmupMs = 0;
  inGesture = false;
  brokenStarts = 0;
  bornInterrupted = false;
  readonly userActivation = { hasBeenActive: false, isActive: false };
  private readonly gestureListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private undo: (() => void)[] = [];

  install(): void {
    const g = globalThis as { AudioContext?: unknown; fetch: typeof fetch };
    const had = { AudioContext: g.AudioContext, fetch: g.fetch };
    const make = (): FakeContext => new FakeContext(this);
    g.AudioContext = function AudioContext() {
      return make();
    };
    g.fetch = ((url: string) => Promise.resolve(new Response(url))) as typeof fetch;
    Object.defineProperty(navigator, 'userActivation', { value: this.userActivation, configurable: true });
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (GESTURES.has(type)) this.listenersFor(type).add(fn);
      add(type, fn, opts as boolean);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (GESTURES.has(type)) this.listenersFor(type).delete(fn);
      remove(type, fn, opts as boolean);
    }) as typeof window.removeEventListener;
    this.undo.push(() => {
      g.AudioContext = had.AudioContext;
      g.fetch = had.fetch;
      window.addEventListener = add;
      window.removeEventListener = remove;
      Reflect.deleteProperty(navigator, 'userActivation');
      for (const [type, fns] of this.gestureListeners)
        for (const fn of fns) for (const capture of [true, false]) remove(type, fn, capture);
    });
  }

  uninstall(): void {
    for (const undo of this.undo.splice(0)) undo();
  }

  get open(): FakeContext[] {
    return this.made.filter((c) => c.state !== 'closed');
  }

  liveNodes(): number {
    return this.open.reduce((n, c) => n + c.nodes.filter((x) => x.connected).length, 0);
  }

  gestureListenerCount(): number {
    return [...this.gestureListeners.values()].reduce((n, fns) => n + fns.size, 0);
  }

  private listenersFor(type: string): Set<EventListenerOrEventListenerObject> {
    let fns = this.gestureListeners.get(type);
    if (!fns) this.gestureListeners.set(type, (fns = new Set()));
    return fns;
  }

  press(): void {
    this.inGesture = true;
    this.userActivation.hasBeenActive = true;
    try {
      window.dispatchEvent(new Event('pointerdown'));
    } finally {
      this.inGesture = false;
    }
  }

  async pass(ms: number, step = 50): Promise<void> {
    for (let left = ms; left > 0; left -= step) {
      const dt = Math.min(step, left);
      for (const c of this.open) c.render(dt);
      await vi.advanceTimersByTimeAsync(dt);
    }
  }

  frozenFor(ms: number): void {
    vi.setSystemTime(Date.now() + ms);
  }

  sleep(ms: number, wake: Wake): void {
    for (const c of this.open) {
      if (c.state === 'running') c.state = 'interrupted';
      c.held = true;
    }
    this.frozenFor(ms);
    for (const c of this.open) {
      if (wake === 'stuck') continue;
      c.held = false;
      if (c.state !== 'interrupted') continue;
      c.state = wake === 'suspended' ? 'suspended' : 'running';
      c.stalled = wake === 'stalled';
    }
  }

  unplugOutput(): void {
    for (const c of this.open) c.stalled = true;
  }

  closeContext(): void {
    for (const c of this.open) c.state = 'closed';
  }

  holdInterruption(): void {
    this.bornInterrupted = true;
    for (const c of this.open) {
      c.state = 'interrupted';
      c.held = true;
    }
  }

  endInterruption(): void {
    this.bornInterrupted = false;
    for (const c of this.open) {
      c.held = false;
      if (c.state === 'interrupted') c.state = 'suspended';
    }
  }

  suspendHiddenPage(ms: number): void {
    this.frozenFor(ms);
    for (const c of this.open) c.audible = false;
  }
}
