import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { build } from 'vite';

const { values: args } = parseArgs({
  options: {
    bars: { type: 'string', default: '50000' },
    setup: { type: 'string', default: 'standard' },
    dpr: { type: 'string', default: '1,2' },
    runs: { type: 'string', default: '3' },
    hide: { type: 'string', default: '' },
    shots: { type: 'string' },
    trace: { type: 'string' },
    json: { type: 'boolean' },
    layers: { type: 'boolean' },
  },
});
const benchDir = resolve(import.meta.dirname, '../bench');
const outDir = mkdtempSync(join(tmpdir(), 'tessera-bench-chart-'));
const ORIGIN = 'http://bench.invalid';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const SCENARIOS = ['pan, default zoom', 'redraw, zoomed out', 'pan, zoomed out'] as const;

interface Row {
  frame: number[];
  draw: number[];
  main: number;
  raster: number;
  composite: number;
}

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  tdur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: { message?: string } };
}

try {
  await build({ root: benchDir, configFile: false, logLevel: 'error', build: { outDir, emptyOutDir: true } });
  const browser = await chromium.launch();
  const results: Record<string, Record<string, Row[]>> = {};
  if (args.shots) mkdirSync(args.shots, { recursive: true });
  try {
    for (const dpr of args.dpr.split(',').map(Number)) {
      for (let run = 0; run < Number(args.runs); run++) {
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
        await page.route(`${ORIGIN}/**`, (route) => {
          const path = new URL(route.request().url()).pathname;
          const file = join(outDir, path === '/' ? 'index.html' : path);
          void route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? 'text/plain' });
        });
        page.on('pageerror', (e) => {
          console.error('[bench] page error:', e.message);
        });
        await page.goto(`${ORIGIN}/?bars=${args.bars}&setup=${args.setup}`);
        await page.waitForFunction(() => window.bench !== undefined);
        await page.waitForTimeout(1000);
        const shot = async (name: string) => {
          if (run === 0 && args.shots) {
            await page.screenshot({ path: join(args.shots, `${args.setup}-${name}-dpr${String(dpr)}.png`) });
          }
        };
        await shot('default');
        if (args.layers) {
          console.info(`dpr ${String(dpr)}`, await page.evaluate(layerCosts));
          await page.close();
          continue;
        }
        const { measured, trace } = await traced(page, () => page.evaluate(runScenarios, args.hide));
        if (args.trace && run === 0) writeFileSync(`${args.trace}-dpr${String(dpr)}.json`, JSON.stringify(trace));
        const byName = (results[`dpr ${String(dpr)}`] ??= {});
        for (const m of measured) (byName[m.name] ??= []).push({ ...m, ...threadTimes(trace, m.name, m.frame.length) });
        await shot('zoomed-out');
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (args.json) console.info(JSON.stringify(summary(results), null, 2));
  else report(results);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

async function traced<T>(page: Page, body: () => Promise<T>): Promise<{ measured: T; trace: TraceEvent[] }> {
  const cdp = await page.context().newCDPSession(page);
  const trace: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (e) => trace.push(...(e.value as unknown as TraceEvent[])));
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,toplevel,cc,viz',
    transferMode: 'ReportEvents',
  });
  const measured = await body();
  const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  return { measured, trace };
}

function threadTimes(trace: TraceEvent[], name: string, frames: number) {
  const stamp = (edge: string) =>
    trace.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === `${edge}:${name}`);
  const from = stamp('start')?.ts ?? 0;
  const to = stamp('end')?.ts ?? 0;
  const threads = new Map<string, string>();
  for (const e of trace)
    if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${String(e.pid)}:${String(e.tid)}`, e.args?.name ?? '');
  const sum = (thread: string, event: string) =>
    trace
      .filter((e) => e.ph === 'X' && e.name === event && e.ts >= from && e.ts < to)
      .filter((e) => threads.get(`${String(e.pid)}:${String(e.tid)}`) === thread)
      .reduce((s, e) => s + (e.tdur ?? e.dur ?? 0), 0) /
    1000 /
    frames;
  return {
    main: sum('CrRendererMain', 'ThreadControllerImpl::RunTask'),
    raster: sum('CrRendererMain', 'LayerTreeHost::DoUpdateLayers'),
    composite: sum('VizCompositorThread', 'Display::DrawAndSwap'),
  };
}

async function runScenarios(hide: string) {
  const { chart, frames } = window.bench!;
  for (const id of hide.split(',').filter(Boolean)) chart.setLayerVisible(id, false);
  const overlay = document.querySelector<HTMLCanvasElement>('canvas[data-surface="overlay"]')!;
  const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
  const wheel = (deltaX: number, deltaY: number) =>
    overlay.dispatchEvent(
      new WheelEvent('wheel', { deltaX, deltaY, clientX: 1200, clientY: 400, bubbles: true, cancelable: true }),
    );
  const scenario = async (name: string, steps: number, step: (i: number) => void) => {
    for (let i = 0; i < 10; i++) await nextFrame();
    frames.length = 0;
    const frame: number[] = [];
    let last = await nextFrame();
    // eslint-disable-next-line no-console
    console.timeStamp(`start:${name}`);
    for (let i = 0; i < steps; i++) {
      step(i);
      const now = await nextFrame();
      frame.push(now - last);
      last = now;
    }
    // eslint-disable-next-line no-console
    console.timeStamp(`end:${name}`);
    return { name, frame, draw: frames.map((f) => f.durationMs) };
  };
  const pan = (i: number) => wheel(i % 2 ? 40 : -40, 0);
  const out = [await scenario('pan, default zoom', 120, pan)];
  for (let i = 0; i < 400 && chart.getViewport().from > 0; i++) {
    wheel(0, 120);
    await nextFrame();
  }
  out.push(await scenario('redraw, zoomed out', 120, () => chart.render(true)));
  out.push(await scenario('pan, zoomed out', 120, pan));
  return out;
}

async function layerCosts() {
  const { chart } = window.bench!;
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>('canvas[data-surface]')];
  const overlay = canvases.find((c) => c.dataset.surface === 'overlay')!;
  for (let i = 0; i < 400 && chart.getViewport().from > 0; i++) {
    overlay.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, clientX: 1200, clientY: 400, bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
  }
  const ids = chart.layers().map((l) => l.id);
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!.toFixed(1);
  const time = () => {
    const total: number[] = [];
    const draw: number[] = [];
    for (let k = 0; k < 40; k++) {
      const t0 = performance.now();
      chart.render(true);
      draw.push(performance.now() - t0);
      // Chromium rasters a canvas's recorded draws at the next commit; reading a pixel rasters them now.
      for (const c of canvases) c.getContext('2d')?.getImageData(0, 0, 1, 1);
      total.push(performance.now() - t0);
    }
    return `${median(total)} (draw ${median(draw)})`;
  };
  const out: Record<string, string> = { all: time() };
  for (const id of ids) chart.setLayerVisible(id, false);
  out.none = time();
  for (const id of ids) {
    chart.setLayerVisible(id, true);
    out[id] = time();
    chart.setLayerVisible(id, false);
  }
  return out;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

function summary(results: Record<string, Record<string, Row[]>>) {
  const out: Record<string, Record<string, Record<string, number>>> = {};
  for (const [dpr, byName] of Object.entries(results)) {
    for (const name of SCENARIOS) {
      const rows = byName[name] ?? [];
      const frame = rows.flatMap((r) => r.frame);
      (out[dpr] ??= {})[name] = {
        frameMean: mean(frame),
        frameMedian: quantile(frame, 0.5),
        frameP90: quantile(frame, 0.9),
        draw: quantile(
          rows.flatMap((r) => r.draw),
          0.5,
        ),
        main: mean(rows.map((r) => r.main)),
        raster: mean(rows.map((r) => r.raster)),
        composite: mean(rows.map((r) => r.composite)),
      };
    }
  }
  return out;
}

function report(results: Record<string, Record<string, Row[]>>): void {
  const f = (v: number) => v.toFixed(1).padStart(7);
  const runs = Object.values(Object.values(results)[0] ?? {})[0]?.length ?? 0;
  console.info(`chart bench: ${args.bars} 1m bars, ${args.setup} setup, 1600×900 css px, ${String(runs)} runs`);
  console.info('mean, median, p90: time between frames (16.7 is 60 fps); draw: the engine, median;');
  console.info('main, raster, composite: thread CPU time per frame, mean (raster is part of main)');
  for (const [dpr, byDpr] of Object.entries(summary(results))) {
    console.info(`\n${dpr.padEnd(20)}   mean median   p90   draw    main  raster  composite`);
    for (const [name, s] of Object.entries(byDpr)) {
      console.info(
        `${name.padEnd(20)}${f(s.frameMean!)}${f(s.frameMedian!)}${f(s.frameP90!)}${f(s.draw!)}${f(s.main!)}${f(s.raster!)}${f(s.composite!)}`,
      );
    }
  }
}
