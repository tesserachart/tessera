import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChartEngine,
  DATA_FRAME_MS,
  GPU_DATA_FRAME_MS,
  GPU_LOSS_WINDOW_MS,
  GPU_MAX_LOSSES,
  MAX_GPU_CONTEXTS,
  SETTLE_MS,
  WebGlSurface,
  gpuContextsHeld,
  parseColor,
  type FrameEvent,
  type FrameScheduler,
  type GpuRenderContext,
  type Layer,
  type LayerHost,
  type RenderContext,
  type SurfaceHost,
  type ViewportState,
} from '../src/index.ts';
import { equityBars, headless } from './fixtures.ts';
import { FakeGpuCanvas, fakeGl, ManualTimers } from './gpu.ts';

type Ctx = { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };

const alphaAt = (chart: ReturnType<typeof headless>, x: number, y: number) =>
  (chart.canvases.main.getContext('2d') as Ctx).getImageData(Math.round(x), Math.round(y), 1, 1).data[3]!;

function layer(id: string, extra: Partial<Layer> & Pick<Layer, 'surface'>): Layer & { host: LayerHost | null } {
  const l: Layer & { host: LayerHost | null } = {
    id,
    kind: 'series',
    draw: () => undefined,
    host: null,
    attach(host) {
      l.host = host;
    },
    ...extra,
  };
  return l;
}

describe('view hints', () => {
  it('lets bars widen only as far as the widest visible layer asks, 80 px without one', () => {
    const chart = headless();
    chart.setData('main', equityBars(3));
    chart.setViewport({ barSpacing: 400 });
    expect(chart.getViewport().barSpacing).toBe(80);

    const footprint = layer('fp', { surface: 'main', viewHints: () => ({ maxBarSpacing: 480 }) });
    chart.addLayer(footprint);
    chart.setViewport({ barSpacing: 400 });
    expect(chart.getViewport().barSpacing).toBe(400);
    chart.addLayer(layer('small', { surface: 'main', viewHints: () => ({ maxBarSpacing: 20 }) }));
    chart.setViewport({ barSpacing: 470 });
    expect(chart.getViewport().barSpacing).toBe(470);

    chart.setLayerVisible('fp', false);
    chart.render();
    expect(chart.getViewport().barSpacing).toBe(80);
    chart.destroy();
  });
});

describe('a layer that draws the series itself', () => {
  it('sends the candles aside only while it says so', () => {
    const chart = headless();
    const bars = equityBars(3);
    chart.setData('main', bars);
    let replacing = false;
    const seen: RenderContext[] = [];
    chart.addLayer(
      layer('fp', {
        surface: 'main',
        replacesSeries: (rc) => {
          seen.push(rc);
          return replacing;
        },
      }),
    );
    chart.render(true);
    const c = chart.coords();
    const last = bars.length - 1;
    const b = bars[last]!;
    const x = c.xOfIndex(last);
    const y = c.yOfPrice((b.o + b.c) / 2);
    expect(alphaAt(chart, x, y)).toBe(255);
    replacing = true;
    chart.render(true);
    expect(alphaAt(chart, x, y)).toBe(0);
    expect(seen.at(-1)?.pane).toEqual(c.plot);
    chart.destroy();
  });
});

describe('xOfTime', () => {
  it('places a moment inside its bar by the elapsed share of the timeframe', () => {
    const chart = headless({ timeframeMs: 300_000 });
    const bars = equityBars(2);
    chart.setData('main', bars);
    let time: RenderContext['time'] | null = null;
    chart.addLayer(
      layer('probe', {
        surface: 'main',
        draw: (rc) => {
          time = rc.time;
        },
      }),
    );
    chart.render(true);
    const tv = time as unknown as RenderContext['time'];
    const i = bars.length - 10;
    const t = bars[i]!.t;
    const x = tv.xOfIndex(i);
    expect(tv.xOfTime(t)).toBeCloseTo(x - tv.barSpacing / 2, 9);
    expect(tv.xOfTime(t + 150_000)).toBeCloseTo(x, 9);
    expect(tv.xOfTime(t + 225_000)).toBeCloseTo(x + tv.barSpacing / 4, 9);
    expect(tv.xOfTime(bars.at(-1)!.t + 10 * 300_000)).toBeCloseTo(tv.xOfIndex(bars.length - 1) + tv.barSpacing / 2, 9);
    expect(Number.isNaN(tv.xOfTime(bars[0]!.t - 1))).toBe(true);
    chart.destroy();
  });
});

describe('settling', () => {
  it('fires once, 150 ms after the last move, and says when the view is moving', () => {
    const timers = new ManualTimers();
    const chart = headless({ timers });
    chart.setData('main', equityBars(3));
    timers.advance(SETTLE_MS);
    const settled = vi.fn();
    const events: ViewportState[] = [];
    chart.on('settled', (v) => events.push(v));
    let interacting: boolean | null = null;
    chart.addLayer(
      layer('profile', {
        surface: 'underlay',
        onViewSettled: settled,
        draw: (rc) => {
          interacting = rc.interacting;
        },
      }),
    );
    chart.render(true);
    expect(interacting).toBe(false);

    chart.engine.wheel(0, -40, 600, 300);
    chart.render();
    expect(interacting).toBe(true);
    timers.advance(100);
    chart.engine.wheel(0, -40, 600, 300);
    chart.render();
    timers.advance(100);
    expect(settled).not.toHaveBeenCalled();
    timers.advance(SETTLE_MS - 100);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.barSpacing).toBe(chart.getViewport().barSpacing);
    const frames: FrameEvent[] = [];
    chart.on('frame', (f) => frames.push(f));
    chart.render();
    expect(frames[0]?.surfaces).toEqual(['underlay']);
    expect(interacting).toBe(false);
    chart.destroy();
  });

  it('waits for a pan drag to end', () => {
    const timers = new ManualTimers();
    const chart = headless({ timers });
    chart.setData('main', equityBars(3));
    const settled = vi.fn();
    chart.on('settled', settled);
    timers.advance(SETTLE_MS);
    settled.mockClear();
    chart.engine.pointerDown(600, 300);
    chart.engine.pointerMove(560, 300);
    expect(chart.engine.interacting).toBe(true);
    timers.advance(SETTLE_MS * 3);
    expect(settled).not.toHaveBeenCalled();
    chart.engine.pointerUp(560, 300);
    timers.advance(SETTLE_MS);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(chart.engine.interacting).toBe(false);
    chart.destroy();
  });
});

function governed() {
  const queue: (() => void)[] = [];
  const scheduler: FrameScheduler = {
    request: (cb) => queue.push(cb),
    cancel: (h) => {
      queue[h - 1] = () => undefined;
    },
  };
  const timers = new ManualTimers();
  const make = () => createCanvas(800, 400) as never;
  const host: SurfaceHost = {
    canvases: { underlay: make(), main: make(), overlay: make() },
    resize: () => undefined,
  };
  const engine = new ChartEngine(host, {
    width: 800,
    height: 400,
    dpr: 1,
    scheduler,
    timers,
    liveClock: false,
    legend: false,
  });
  const frames: FrameEvent[] = [];
  engine.on('frame', (f) => frames.push(f));
  const drain = () => {
    while (queue.length) {
      for (const cb of queue.splice(0, queue.length)) {
        const before = frames.length;
        cb();
        const drawn = frames.splice(before);
        if (drawn.length) frames.push({ ...drawn[0]!, surfaces: [...new Set(drawn.flatMap((f) => f.surfaces))] });
      }
    }
  };
  return { engine, timers, frames, drain, queued: () => queue.length };
}

describe('a chart out of sight (a tab behind another)', () => {
  it('draws nothing and settles nothing while hidden, then one frame of everything as it now is when shown', () => {
    const { engine, timers, frames, drain, queued } = governed();
    const bars = equityBars(2);
    engine.setData('main', bars);
    drain();
    timers.advance(SETTLE_MS);
    const onSettled = vi.fn();
    const study = layer('study', { surface: 'main', onViewSettled: onSettled });
    engine.addLayer(study);
    drain();
    frames.length = 0;

    engine.setSuspended(true);
    expect(engine.isSuspended).toBe(true);
    let last = bars.at(-1)!;
    for (let i = 0; i < 50; i++) {
      timers.advance(5);
      last = { ...last, c: last.c + 0.01, h: Math.max(last.h, last.c + 0.01) };
      engine.update('main', last);
    }
    engine.setViewport({ lastBars: 40 });
    engine.invalidate('all');
    engine.render(true);
    timers.advance(SETTLE_MS * 2);
    expect(queued()).toBe(0);
    drain();
    expect(frames).toHaveLength(0);
    expect(onSettled).not.toHaveBeenCalled();

    engine.setSuspended(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    drain();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.surfaces).toEqual(expect.arrayContaining(['main', 'overlay']));
    const series = engine.getSeries()!;
    expect(series.bar(series.length - 1).c).toBeCloseTo(last.c);
    engine.destroy();
  });
});

describe('the data frame governor', () => {
  it('draws market data at most 30 times a second, and the pointer on the next frame', () => {
    const { engine, timers, frames, drain, queued } = governed();
    const bars = equityBars(2);
    engine.setData('main', bars);
    drain();
    frames.length = 0;

    let last = bars.at(-1)!;
    const tick = () => {
      last = { ...last, c: last.c + 0.01, h: Math.max(last.h, last.c + 0.01) };
      engine.update('main', last);
    };
    for (let i = 0; i < 20; i++) {
      timers.advance(1);
      tick();
    }
    expect(queued()).toBe(0);
    timers.advance(DATA_FRAME_MS - 20);
    expect(queued()).toBe(1);
    drain();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.surfaces).toEqual(['main', 'overlay']);

    frames.length = 0;
    timers.advance(1);
    engine.pointerMove(300, 200);
    expect(queued()).toBe(1);
    drain();
    expect(frames).toHaveLength(1);

    engine.pointerMove(310, 200);
    last = { ...last, v: last.v + 1 };
    engine.update('main', last);
    drain();
    expect(frames).toHaveLength(2);
    expect(frames[1]!.surfaces).toEqual(['overlay']);
    timers.advance(DATA_FRAME_MS);
    drain();
    expect(frames).toHaveLength(3);
    expect(frames[2]!.surfaces).toEqual(['main']);

    frames.length = 0;
    for (let i = 0; i < 200; i++) {
      timers.advance(5);
      tick();
      drain();
    }
    expect(frames.length).toBeGreaterThanOrEqual(28);
    expect(frames.length).toBeLessThanOrEqual(31);
    engine.destroy();
  });

  it('paces the gpu surface at 10 Hz', () => {
    const { engine, timers, frames, drain } = governed();
    engine.setData('main', equityBars(2));
    const heat = layer('heat', { surface: 'gpu' });
    engine.addLayer(heat);
    drain();
    frames.length = 0;
    for (let i = 0; i < 100; i++) {
      timers.advance(10);
      heat.host!.invalidate('data');
      drain();
    }
    expect(frames.length).toBeGreaterThanOrEqual(9);
    expect(frames.length).toBeLessThanOrEqual(11);
    expect(frames.every((f) => f.surfaces.includes('underlay'))).toBe(true);
    expect(GPU_DATA_FRAME_MS).toBe(100);
    engine.destroy();
  });

  it('render() draws paced data at once', () => {
    const chart = headless({ timers: new ManualTimers() });
    const bars = equityBars(2);
    chart.setData('main', bars);
    chart.render();
    const frames: FrameEvent[] = [];
    chart.on('frame', (f) => frames.push(f));
    chart.update('main', { ...bars.at(-1)!, c: bars.at(-1)!.c + 0.01 });
    chart.render();
    expect(frames[0]!.surfaces).toEqual(['main', 'overlay']);
    chart.destroy();
  });
});

describe('the gpu surface', () => {
  afterEach(() => {
    expect(gpuContextsHeld()).toBe(0);
  });

  function gpuChart(supports = true) {
    const made: FakeGpuCanvas[] = [];
    const chart = headless({
      timers: new ManualTimers(),
      createGpuCanvas: (w, h) => {
        const c = new FakeGpuCanvas(w, h, supports);
        made.push(c);
        return c;
      },
    });
    chart.setData('main', equityBars(2));
    const draws = { gpu: 0, twoD: 0, generation: -1, size: [0, 0] };
    const heat = layer('heat', {
      surface: 'gpu',
      draw: () => {
        draws.twoD++;
      },
      drawGpu: (rc: GpuRenderContext) => {
        draws.gpu++;
        draws.generation = rc.gpu.generation;
        draws.size = [rc.gpu.width, rc.gpu.height];
        rc.gpu.texture('ramp', 256, 1, 'rgba8', new Uint8Array(1024));
      },
    });
    return { chart, made, draws, heat };
  }

  it('is made when a gpu layer shows, cleared to the ground at a pixel ratio of 1, and dropped when none does', () => {
    const { chart, made, draws, heat } = gpuChart();
    chart.render(true);
    expect(made).toHaveLength(0);
    expect(chart.gpuState()).toBe('none');
    chart.addLayer(heat);
    chart.render();
    expect(made).toHaveLength(1);
    expect(chart.gpuState()).toBe('active');
    expect(gpuContextsHeld()).toBe(1);
    expect(draws).toMatchObject({ gpu: 1, twoD: 0, size: [1200, 700] });
    const gl = made[0]!.fake;
    const clear = gl.calls.find((c) => c.name === 'clearColor')!.args as number[];
    expect(clear.slice(0, 3).map((v) => Math.round(v * 255))).toEqual([5, 8, 11]);
    expect(gl.count('texImage2D')).toBe(1);
    chart.render(true);
    expect(gl.count('texImage2D')).toBe(1);

    chart.setLayerVisible('heat', false);
    chart.render();
    expect(chart.gpuState()).toBe('none');
    expect(gpuContextsHeld()).toBe(0);
    expect(chart.gpuCanvas).toBeNull();
    expect(gl.count('loseContext')).toBe(1);
    chart.destroy();
  });

  it('draws in 2D on the underlay when WebGL2 is missing', () => {
    const { chart, draws, heat } = gpuChart(false);
    chart.addLayer(heat);
    chart.render();
    expect(chart.gpuState()).toBe('failed');
    expect(draws).toMatchObject({ gpu: 0, twoD: 1 });
    chart.destroy();
    const bare = headless();
    bare.setData('main', equityBars(1));
    const l = layer('heat', { surface: 'gpu', draw: vi.fn() });
    bare.addLayer(l);
    bare.render();
    expect(bare.gpuState()).toBe('failed');
    expect(l.draw).toHaveBeenCalledTimes(1);
    bare.destroy();
  });

  it('counts a lost context as a blip once the window since the last loss has passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { chart, made, heat } = gpuChart();
      chart.addLayer(heat);
      chart.render();
      const canvas = made[0]!;
      canvas.fire('webglcontextlost');
      canvas.fire('webglcontextrestored');
      chart.render();
      vi.advanceTimersByTime(GPU_LOSS_WINDOW_MS);
      canvas.fire('webglcontextlost');
      chart.render();
      expect(chart.gpuState()).toBe('fallback');
      canvas.fire('webglcontextrestored');
      chart.render();
      expect(chart.gpuState()).toBe('active');
      chart.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back while a lost context waits, re-uploads on restore, and gives up after two losses', () => {
    const { chart, made, draws, heat } = gpuChart();
    chart.addLayer(heat);
    chart.render();
    const canvas = made[0]!;
    canvas.fire('webglcontextlost');
    expect(canvas.prevented).toBe(1);
    chart.render();
    expect(chart.gpuState()).toBe('fallback');
    expect(draws.twoD).toBe(1);
    canvas.fire('webglcontextrestored');
    chart.render();
    expect(chart.gpuState()).toBe('active');
    expect(draws.generation).toBe(1);
    expect(canvas.fake.count('texImage2D')).toBe(2);
    expect(GPU_MAX_LOSSES).toBe(2);
    canvas.fire('webglcontextlost');
    chart.render();
    expect(chart.gpuState()).toBe('failed');
    expect(chart.gpuCanvas).toBeNull();
    expect(canvas.listening('webglcontextlost')).toBe(0);
    const twoD = draws.twoD;
    chart.render(true);
    expect(draws.twoD).toBe(twoD + 1);
    expect(made).toHaveLength(1);
    chart.destroy();
  });

  it('holds at most four contexts; the fifth chart draws in 2D', () => {
    const charts = Array.from({ length: MAX_GPU_CONTEXTS + 1 }, () => gpuChart());
    for (const { chart, heat } of charts) {
      chart.addLayer(heat);
      chart.render();
    }
    expect(charts.map((c) => c.chart.gpuState())).toEqual(['active', 'active', 'active', 'active', 'fallback']);
    expect(charts[4]!.draws.twoD).toBe(1);
    charts[0]!.chart.destroy();
    charts[4]!.chart.render(true);
    expect(charts[4]!.chart.gpuState()).toBe('active');
    for (const { chart } of charts.slice(1)) chart.destroy();
  });
});

describe('WebGlSurface', () => {
  it('pools textures by key and version, spends the frame budget and evicts the least recently used', () => {
    const { gl, count } = fakeGl();
    const tile = 256 * 256 * 2;
    const s = new WebGlSurface(gl, tile * 2);
    s.beginFrame(10, 10, '#05070c');
    const a = new Uint16Array(256 * 256);
    s.texture('a', 256, 256, 'r16f', a, 1);
    expect(s.uploadBudget).toBe(256 * 1024 - tile);
    s.texture('a', 256, 256, 'r16f', a, 1);
    expect(count('texImage2D')).toBe(1);
    s.texture('a', 256, 256, 'r16f', a, 2);
    expect(count('texImage2D')).toBe(2);
    expect(count('createTexture')).toBe(1);
    s.texture('b', 256, 256, 'r16f', a);
    s.texture('a', 256, 256, 'r16f', a, 2);
    s.texture('c', 256, 256, 'r16f', a);
    expect(s.has('a', 2)).toBe(true);
    expect(s.has('b')).toBe(false);
    expect(s.has('c')).toBe(true);
    expect(s.bytes).toBe(tile * 2);
    s.beginFrame(10, 10, '#05070c');
    expect(s.uploadBudget).toBe(256 * 1024);
  });

  it('compiles a program once per context generation', () => {
    const { gl, count } = fakeGl();
    const s = new WebGlSurface(gl);
    const p = s.program('heat', 'v', 'f');
    expect(s.program('heat', 'v', 'f')).toBe(p);
    expect(count('linkProgram')).toBe(1);
    s.markLost();
    s.restore();
    s.program('heat', 'v', 'f');
    expect(count('linkProgram')).toBe(2);
  });

  it('reads the theme colours the clear uses', () => {
    expect(parseColor('#05070c').map((v) => Math.round(v * 255))).toEqual([5, 7, 12, 255]);
    expect(parseColor('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseColor('rgba(220,235,239,0.5)')).toEqual([220 / 255, 235 / 255, 239 / 255, 0.5]);
    expect(parseColor('nonsense')).toEqual([0, 0, 0, 1]);
  });
});

describe('a time span asked of the view', () => {
  it('shows the bars between two times, the last at the right edge, within the data', () => {
    const chart = headless();
    const bars = equityBars(3);
    chart.setData('main', bars);
    const from = bars[20]!.t;
    const to = bars[59]!.t;
    chart.setViewport({ range: { from, to } });
    const vp = chart.getViewport();
    expect(vp.from).toBeGreaterThanOrEqual(19);
    expect(vp.from).toBeLessThanOrEqual(20);
    expect(vp.to).toBeGreaterThanOrEqual(59);
    expect(vp.to).toBeLessThanOrEqual(60);
    chart.setViewport({ range: { from: bars[200]!.t, to: bars[200]!.t + 1e12 } });
    expect(chart.getViewport().to).toBe(bars.length - 1);
    expect(chart.getViewport().from).toBeGreaterThanOrEqual(199);
    chart.destroy();
  });
});
