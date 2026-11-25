import {
  ChartEngine,
  type CanvasLike,
  type EngineOptions,
  type FrameScheduler,
  type SetDataOptions,
  type SurfaceHost,
} from './engine.ts';
import { GPU_PIXEL_RATIO, type GpuCanvasLike, type GpuHost } from './gpu/surface.ts';
import type { Layer, LayerClass } from './layers/types.ts';
import type { SeriesStore } from './store.ts';
import type {
  BarInput,
  ChartCoords,
  ChartEventMap,
  ChartEventName,
  ChartOptions,
  ChartTheme,
  GpuState,
  LayerInfo,
  Surface2D,
  ViewportState,
  ViewportUpdate,
} from './types.ts';

export interface ChartApi {
  setData(seriesId: string, bars: readonly BarInput[] | SeriesStore, options?: SetDataOptions): void;
  prepend(seriesId: string, bars: readonly BarInput[]): number;
  update(seriesId: string, bar: BarInput): void;
  getSeries(seriesId?: string): SeriesStore | null;
  addLayer(layer: Layer): LayerInfo;
  removeLayer(id: string): boolean;
  setLayerVisible(id: string, visible: boolean): void;
  setLayerZ(id: string, z: number): void;
  getLayer(id: string): Layer | null;
  getLayer<T extends Layer>(id: string, kind: LayerClass<T>): T | null;
  layers(): LayerInfo[];
  setViewport(update: ViewportUpdate): void;
  getViewport(): ViewportState;
  setOptions(options: Partial<ChartOptions>): void;
  readonly theme: ChartTheme;
  on<K extends ChartEventName>(event: K, cb: (payload: ChartEventMap[K]) => void): () => void;
  resize(width?: number, height?: number): void;
  coords(): ChartCoords;
  render(force?: boolean): void;
  setSuspended(suspended: boolean): void;
  gpuState(): GpuState;
  destroy(): void;
}

const rafScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => {
    cancelAnimationFrame(h);
  },
};

class DomSurfaceHost implements SurfaceHost {
  readonly canvases: Record<Surface2D, HTMLCanvasElement>;
  readonly root: HTMLDivElement;
  readonly gpu: GpuHost;
  private gpuCanvas: HTMLCanvasElement | null = null;
  private cssW = 1;
  private cssH = 1;

  constructor(container: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'tessera-chart';
    root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;outline:none;';
    root.tabIndex = 0;
    root.setAttribute('role', 'img');
    root.setAttribute('aria-roledescription', 'chart');
    const make = (kind: Surface2D, z: number) => {
      const c = document.createElement('canvas');
      c.dataset.surface = kind;
      c.style.cssText = `position:absolute;left:0;top:0;z-index:${String(z)};display:block;`;
      if (kind !== 'overlay') c.style.pointerEvents = 'none';
      else c.style.touchAction = 'none';
      root.appendChild(c);
      return c;
    };
    this.canvases = { underlay: make('underlay', 0), main: make('main', 1), overlay: make('overlay', 2) };
    container.appendChild(root);
    this.root = root;
    this.gpu = {
      acquire: () => {
        if (!this.gpuCanvas) {
          const c = document.createElement('canvas');
          c.dataset.surface = 'gpu';
          c.style.cssText = 'position:absolute;left:0;top:0;z-index:0;display:block;pointer-events:none;';
          root.insertBefore(c, root.firstChild);
          this.gpuCanvas = c;
          this.sizeGpu();
        }
        return this.gpuCanvas;
      },
      release: () => {
        this.gpuCanvas?.remove();
        this.gpuCanvas = null;
      },
    };
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssW = width;
    this.cssH = height;
    for (const c of Object.values(this.canvases)) {
      c.width = Math.max(1, Math.round(width * dpr));
      c.height = Math.max(1, Math.round(height * dpr));
      c.style.width = `${String(width)}px`;
      c.style.height = `${String(height)}px`;
    }
    this.sizeGpu();
  }

  setBackground(color: string): void {
    this.root.style.background = color;
  }

  private sizeGpu(): void {
    const c = this.gpuCanvas;
    if (!c) return;
    c.width = Math.max(1, Math.round(this.cssW * GPU_PIXEL_RATIO));
    c.height = Math.max(1, Math.round(this.cssH * GPU_PIXEL_RATIO));
    c.style.width = `${String(this.cssW)}px`;
    c.style.height = `${String(this.cssH)}px`;
  }
}

function wrap(engine: ChartEngine, onResize: (w?: number, h?: number) => void, onDestroy: () => void): ChartApi {
  return {
    setData: (id, bars, options) => {
      engine.setData(id, bars, options);
    },
    prepend: (id, bars) => engine.prepend(id, bars),
    update: (id, bar) => {
      engine.update(id, bar);
    },
    getSeries: (id) => engine.getSeries(id),
    addLayer: (layer) => engine.addLayer(layer),
    removeLayer: (id) => engine.removeLayer(id),
    setLayerVisible: (id, v) => {
      engine.setLayerVisible(id, v);
    },
    setLayerZ: (id, z) => {
      engine.setLayerZ(id, z);
    },
    getLayer: engine.getLayer.bind(engine),
    layers: () => engine.layers(),
    setViewport: (u) => {
      engine.setViewport(u);
    },
    getViewport: () => engine.getViewport(),
    setOptions: (o) => {
      engine.setOptions(o);
    },
    get theme() {
      return engine.currentTheme;
    },
    on: (event, cb) => engine.on(event, cb),
    resize: onResize,
    coords: () => engine.coords(),
    render: (force) => {
      engine.render(force);
    },
    setSuspended: (on) => {
      engine.setSuspended(on);
    },
    gpuState: () => engine.gpuState,
    destroy: onDestroy,
  };
}

export function createChart(container: HTMLElement, options: ChartOptions = {}): ChartApi {
  const host = new DomSurfaceHost(container);
  const rect = () => container.getBoundingClientRect();
  const r0 = rect();
  const engine = new ChartEngine(host, {
    ...options,
    width: Math.max(1, Math.floor(r0.width)),
    height: Math.max(1, Math.floor(r0.height)),
    dpr: window.devicePixelRatio || 1,
    scheduler: rafScheduler,
  });
  const overlay = host.canvases.overlay;
  const local = (e: { clientX: number; clientY: number }) => {
    const b = overlay.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const mods = (e: MouseEvent) => ({ shift: e.shiftKey, alt: e.altKey, cmdOrCtrl: mac ? e.metaKey : e.ctrlKey });

  const onPointerMove = (e: PointerEvent) => {
    const p = local(e);
    engine.pointerMove(p.x, p.y, mods(e));
    overlay.style.cursor = engine.cursorAt(p.x, p.y);
  };
  const onPointerDown = (e: PointerEvent) => {
    const p = local(e);
    overlay.setPointerCapture(e.pointerId);
    engine.pointerDown(p.x, p.y, e.button, mods(e));
    overlay.style.cursor = engine.cursorAt(p.x, p.y);
    host.root.focus({ preventScroll: true });
  };
  const onPointerUp = (e: PointerEvent) => {
    const p = local(e);
    if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
    engine.pointerUp(p.x, p.y, mods(e));
    overlay.style.cursor = engine.cursorAt(p.x, p.y);
  };
  const onLeave = () => {
    engine.pointerLeave();
  };
  const onCancel = (e: PointerEvent) => {
    if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
    if (engine.pointerCancel()) overlay.style.cursor = '';
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    engine.wheel(e.deltaX * scale, e.deltaY * scale, p.x, p.y, { shift: e.shiftKey, ctrl: e.ctrlKey });
  };
  const onDblClick = (e: MouseEvent) => {
    const p = local(e);
    engine.doubleClick(p.x, p.y, mods(e));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (engine.keyDown(e.key)) e.preventDefault();
  };
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', onCancel);
  overlay.addEventListener('lostpointercapture', onCancel);
  overlay.addEventListener('pointerleave', onLeave);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  overlay.addEventListener('dblclick', onDblClick);
  host.root.addEventListener('keydown', onKeyDown);

  const measure = (w?: number, h?: number) => {
    const r = rect();
    engine.resize(
      Math.max(1, Math.floor(w ?? r.width)),
      Math.max(1, Math.floor(h ?? r.height)),
      window.devicePixelRatio || 1,
    );
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
  ro?.observe(container);

  let mq: MediaQueryList | null = null;
  const onDpr = () => {
    measure();
    armDpr();
  };
  const armDpr = () => {
    mq?.removeEventListener('change', onDpr);
    mq = window.matchMedia(`(resolution: ${String(window.devicePixelRatio || 1)}dppx)`);
    mq.addEventListener('change', onDpr, { once: true });
  };
  armDpr();
  if ('fonts' in document) {
    void document.fonts.ready.then(() => {
      engine.render(true);
    });
  }

  return wrap(engine, measure, () => {
    ro?.disconnect();
    mq?.removeEventListener('change', onDpr);
    overlay.removeEventListener('pointermove', onPointerMove);
    overlay.removeEventListener('pointerdown', onPointerDown);
    overlay.removeEventListener('pointerup', onPointerUp);
    overlay.removeEventListener('pointercancel', onCancel);
    overlay.removeEventListener('lostpointercapture', onCancel);
    overlay.removeEventListener('pointerleave', onLeave);
    overlay.removeEventListener('wheel', onWheel);
    overlay.removeEventListener('dblclick', onDblClick);
    host.root.removeEventListener('keydown', onKeyDown);
    engine.destroy();
    host.root.remove();
  });
}

export interface HeadlessChartOptions extends ChartOptions {
  width: number;
  height: number;
  dpr?: number;
  createCanvas: (width: number, height: number) => CanvasLike;
  createGpuCanvas?: (width: number, height: number) => GpuCanvasLike | null;
  timers?: EngineOptions['timers'];
}

export interface HeadlessChart extends ChartApi {
  readonly engine: ChartEngine;
  readonly canvases: Readonly<Record<Surface2D, CanvasLike>>;
  readonly gpuCanvas: GpuCanvasLike | null;
  snapshot(): CanvasLike;
}

interface ComposeContext {
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: unknown, x: number, y: number): void;
}

export function createHeadlessChart(options: HeadlessChartOptions): HeadlessChart {
  const dpr = options.dpr ?? 1;
  const canvases = {
    underlay: options.createCanvas(Math.round(options.width * dpr), Math.round(options.height * dpr)),
    main: options.createCanvas(Math.round(options.width * dpr), Math.round(options.height * dpr)),
    overlay: options.createCanvas(Math.round(options.width * dpr), Math.round(options.height * dpr)),
  };
  let gpuCanvas: GpuCanvasLike | null = null;
  let css = { w: options.width, h: options.height };
  const makeGpu = options.createGpuCanvas;
  const host: SurfaceHost = {
    canvases,
    resize(width, height, d) {
      css = { w: width, h: height };
      for (const c of Object.values(canvases)) {
        c.width = Math.max(1, Math.round(width * d));
        c.height = Math.max(1, Math.round(height * d));
      }
      if (gpuCanvas) {
        gpuCanvas.width = Math.max(1, Math.round(width * GPU_PIXEL_RATIO));
        gpuCanvas.height = Math.max(1, Math.round(height * GPU_PIXEL_RATIO));
      }
    },
    ...(makeGpu
      ? {
          gpu: {
            acquire: () =>
              (gpuCanvas ??= makeGpu(Math.round(css.w * GPU_PIXEL_RATIO), Math.round(css.h * GPU_PIXEL_RATIO))),
            release: () => {
              gpuCanvas = null;
            },
          },
        }
      : {}),
  };
  const manual: FrameScheduler = { request: () => 0, cancel: () => undefined };
  const engine = new ChartEngine(host, { liveClock: false, ...options, dpr, scheduler: manual });
  const api = wrap(
    engine,
    (w, h) => {
      engine.resize(w ?? engine.size.width, h ?? engine.size.height);
    },
    () => {
      engine.destroy();
    },
  );
  const snapshot = (): CanvasLike => {
    const out = options.createCanvas(canvases.main.width, canvases.main.height);
    const ctx = out.getContext('2d') as ComposeContext;
    ctx.fillStyle = engine.currentTheme.background;
    ctx.fillRect(0, 0, out.width, out.height);
    for (const c of [canvases.underlay, canvases.main, canvases.overlay]) ctx.drawImage(c, 0, 0);
    return out;
  };
  const chart = Object.assign(api, { engine, canvases, snapshot, gpuCanvas: null as GpuCanvasLike | null });
  // Object.assign would copy a getter's value once
  Object.defineProperty(chart, 'gpuCanvas', { get: () => gpuCanvas, enumerable: true });
  return chart;
}
