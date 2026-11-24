'use strict';
(function (global) {
  const natives = { log: global.__log, zoneOffset: global.__zoneOffset, barOffsets: global.__barOffsets };
  delete global.__log;
  delete global.__zoneOffset;
  delete global.__barOffsets;

  class CodeError extends Error {
    constructor(message, path) {
      super(message);
      this.name = 'CodeError';
      if (path) this.path = path;
    }
  }

  const NaN_ = Number.NaN;
  const isNum = (v) => typeof v === 'number';
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  function show(v) {
    if (typeof v === 'string') return `'${v}'`;
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'function') return 'a function';
    if (ArrayBuffer.isView(v) || Array.isArray(v)) return `an array of ${v.length}`;
    if (typeof v === 'object') return 'an object';
    return String(v);
  }

  function oneOf(v, options, what) {
    if (!options.includes(v)) {
      const list = options.map((o) => `'${o}'`);
      throw new CodeError(`${what} is ${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}, not ${show(v)}`);
    }
    return v;
  }

  function series(x, what) {
    if (x == null || typeof x !== 'object' || typeof x.length !== 'number') {
      throw new CodeError(`${what} takes a series (bars.close, or an array with a value per bar), not ${show(x)}`);
    }
    return x;
  }

  function length(n, what) {
    if (!finite(n) || Math.floor(n) !== n || n < 1) {
      throw new CodeError(`${what}: the length is a whole number of at least 1, not ${show(n)}`);
    }
    return n;
  }

  const nans = (n) => new Float64Array(n).fill(NaN_);

  function format(v, depth) {
    if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
    if (typeof v === 'number' || typeof v === 'boolean' || v == null || typeof v === 'bigint') return String(v);
    if (typeof v === 'function') return `[function ${v.name || 'anonymous'}]`;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (depth > 2) return Array.isArray(v) || ArrayBuffer.isView(v) ? '[…]' : '{…}';
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const head = Array.prototype.slice.call(v, 0, 20).map((x) => format(x, depth + 1));
      const more = v.length > 20 ? `, … ${v.length - 20} more` : '';
      return `[${head.join(', ')}${more}]`;
    }
    const keys = Object.keys(v);
    const parts = keys.slice(0, 20).map((k) => `${k}: ${format(v[k], depth + 1)}`);
    return `{ ${parts.join(', ')}${keys.length > 20 ? ', …' : ''} }`;
  }
  const print = (...args) => natives.log(args.map((a) => format(a, 0)).join(' '));
  const console = Object.freeze({ log: print, info: print, warn: print, error: print, debug: print });

  function windowMean(x, i, n) {
    if (i < n - 1) return NaN_;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += x[k];
    return s / n;
  }

  function smooth(x, n, alpha) {
    const N = x.length;
    const out = nans(N);
    let prev = NaN_;
    for (let i = 0; i < N; i++) {
      const v = x[i];
      if (v !== v) prev = NaN_;
      else if (prev !== prev) prev = windowMean(x, i, n);
      else prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }

  function sums(x) {
    const N = x.length;
    const cum = new Float64Array(N + 1);
    const bad = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) {
      const v = x[i];
      const nan = v !== v;
      cum[i + 1] = cum[i] + (nan ? 0 : v);
      bad[i + 1] = bad[i] + (nan ? 1 : 0);
    }
    return { cum, bad };
  }

  function sma(x, n) {
    series(x, 'ta.sma');
    length(n, 'ta.sma');
    const N = x.length;
    const out = nans(N);
    const { cum, bad } = sums(x);
    for (let i = n - 1; i < N; i++) out[i] = bad[i + 1] - bad[i + 1 - n] > 0 ? NaN_ : (cum[i + 1] - cum[i + 1 - n]) / n;
    return out;
  }

  function sum(x, n) {
    series(x, 'ta.sum');
    length(n, 'ta.sum');
    const N = x.length;
    const out = nans(N);
    const { cum, bad } = sums(x);
    for (let i = n - 1; i < N; i++) out[i] = bad[i + 1] - bad[i + 1 - n] > 0 ? NaN_ : cum[i + 1] - cum[i + 1 - n];
    return out;
  }

  function ema(x, n) {
    series(x, 'ta.ema');
    length(n, 'ta.ema');
    return smooth(x, n, 2 / (n + 1));
  }

  function rma(x, n) {
    series(x, 'ta.rma');
    length(n, 'ta.rma');
    return smooth(x, n, 1 / n);
  }

  function windowWma(x, i, n) {
    if (i < n - 1) return NaN_;
    let s = 0;
    for (let k = 0; k < n; k++) s += (n - k) * x[i - k];
    return s / ((n * (n + 1)) / 2);
  }

  function wma(x, n) {
    series(x, 'ta.wma');
    length(n, 'ta.wma');
    const N = x.length;
    const out = nans(N);
    for (let i = n - 1; i < N; i++) out[i] = windowWma(x, i, n);
    return out;
  }

  function stdev(x, n) {
    series(x, 'ta.stdev');
    length(n, 'ta.stdev');
    const N = x.length;
    const out = nans(N);
    const { cum, bad } = sums(x);
    for (let i = n - 1; i < N; i++) {
      if (bad[i + 1] - bad[i + 1 - n] > 0) continue;
      const mean = (cum[i + 1] - cum[i + 1 - n]) / n;
      let ss = 0;
      for (let j = i - n + 1; j <= i; j++) {
        const d = x[j] - mean;
        ss += d * d;
      }
      out[i] = Math.sqrt(ss / n);
    }
    return out;
  }

  function zscore(x, n) {
    const m = sma(x, n);
    const sd = stdev(x, n);
    const out = nans(x.length);
    for (let i = 0; i < x.length; i++) {
      const z = (x[i] - m[i]) / sd[i];
      if (Number.isFinite(z)) out[i] = z;
    }
    return out;
  }

  function extreme(x, n, greater) {
    const N = x.length;
    const out = nans(N);
    const q = new Int32Array(N);
    let h = 0;
    let t = 0;
    let lastNan = -1;
    for (let i = 0; i < N; i++) {
      const v = x[i];
      if (v !== v) {
        lastNan = i;
        h = t = 0;
      } else {
        while (t > h && (greater ? x[q[t - 1]] <= v : x[q[t - 1]] >= v)) t--;
        q[t++] = i;
      }
      while (t > h && q[h] <= i - n) h++;
      if (i >= n - 1 && lastNan <= i - n && t > h) out[i] = x[q[h]];
    }
    return out;
  }

  function highest(x, n) {
    series(x, 'ta.highest');
    length(n, 'ta.highest');
    return extreme(x, n, true);
  }

  function lowest(x, n) {
    series(x, 'ta.lowest');
    length(n, 'ta.lowest');
    return extreme(x, n, false);
  }

  function shift(x, k = 1) {
    series(x, 'ta.shift');
    if (!finite(k) || Math.floor(k) !== k)
      throw new CodeError(`ta.shift: bars to shift by is a whole number, not ${show(k)}`);
    const N = x.length;
    const out = nans(N);
    for (let i = 0; i < N; i++) {
      const j = i - k;
      if (j >= 0 && j < N) out[i] = x[j];
    }
    return out;
  }

  function change(x, k = 1) {
    const s = shift(x, k);
    for (let i = 0; i < s.length; i++) s[i] = x[i] - s[i];
    return s;
  }

  function cum(x) {
    series(x, 'ta.cum');
    const out = new Float64Array(x.length);
    let s = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v === v) s += v;
      out[i] = s;
    }
    return out;
  }

  const at = (x, i) => (isNum(x) ? x : x[i]);

  function crosses(a, b, what, above) {
    if (!isNum(a)) series(a, what);
    if (!isNum(b)) series(b, what);
    const N = isNum(a) ? b.length : a.length;
    const out = new Uint8Array(N);
    for (let i = 1; i < N; i++) {
      const a0 = at(a, i - 1);
      const a1 = at(a, i);
      const b0 = at(b, i - 1);
      const b1 = at(b, i);
      out[i] = above ? (a1 > b1 && a0 <= b0 ? 1 : 0) : a1 < b1 && a0 >= b0 ? 1 : 0;
    }
    return out;
  }
  const crossover = (a, b) => crosses(a, b, 'ta.crossover', true);
  const crossunder = (a, b) => crosses(a, b, 'ta.crossunder', false);

  function rsi(x, n = 14) {
    series(x, 'ta.rsi');
    length(n, 'ta.rsi');
    const N = x.length;
    const out = nans(N);
    const gain = nans(N);
    const loss = nans(N);
    const up = (i) => (i < 1 ? NaN_ : Math.max(0, x[i] - x[i - 1]));
    const down = (i) => (i < 1 ? NaN_ : Math.max(0, x[i - 1] - x[i]));
    const step = (read, s, i) => {
      const v = read(i);
      if (v !== v) return NaN_;
      const prev = i > 0 ? s[i - 1] : NaN_;
      if (prev !== prev) {
        if (i < n - 1) return NaN_;
        let total = 0;
        for (let k = i - n + 1; k <= i; k++) total += read(k);
        return total / n;
      }
      return (1 / n) * v + (1 - 1 / n) * prev;
    };
    for (let i = 0; i < N; i++) {
      const g = i >= n ? step(up, gain, i) : NaN_;
      const l = i >= n ? step(down, loss, i) : NaN_;
      gain[i] = g;
      loss[i] = l;
      out[i] = g !== g || l !== l ? NaN_ : l === 0 ? 100 : g === 0 ? 0 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function isBars(b) {
    return b != null && typeof b === 'object' && b.high && b.low && b.close && isNum(b.length);
  }

  function tr(bars) {
    if (!isBars(bars)) throw new CodeError(`ta.tr takes the bars, not ${show(bars)}`);
    const { high: h, low: l, close: c } = bars;
    const N = bars.length;
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      if (i === 0) out[i] = h[i] - l[i];
      else {
        const pc = c[i - 1];
        out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - pc), Math.abs(l[i] - pc));
      }
    }
    return out;
  }

  function atr(bars, n = 14, smoothing = 'rma') {
    if (!isBars(bars)) throw new CodeError(`ta.atr takes the bars, not ${show(bars)}`);
    length(n, 'ta.atr');
    oneOf(smoothing, ['rma', 'sma', 'ema', 'wma'], 'ta.atr smoothing');
    const t = tr(bars);
    if (smoothing === 'ema') return smooth(t, n, 2 / (n + 1));
    if (smoothing === 'rma') return smooth(t, n, 1 / n);
    const out = nans(t.length);
    for (let i = n - 1; i < t.length; i++) out[i] = smoothing === 'sma' ? windowMean(t, i, n) : windowWma(t, i, n);
    return out;
  }

  const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'];

  function sourceOf(bars, src, what) {
    if (typeof src === 'string') return bars[oneOf(src, SOURCES, `${what} source`)];
    return series(src, what);
  }

  function resetsOf(bars, reset, what) {
    if (reset === 'day') return bars.day;
    if (reset === 'week') return weekIds(bars);
    if (reset === 'none') return null;
    if (reset != null && typeof reset === 'object' && reset.length === bars.length) return reset;
    throw new CodeError(`${what} reset is 'day', 'week', 'none' or an id per bar, not ${show(reset)}`);
  }

  function vwapSums(bars, opts, what) {
    if (!isBars(bars)) throw new CodeError(`${what} takes the bars, not ${show(bars)}`);
    const o = opts ?? {};
    const x = sourceOf(bars, o.source ?? 'hlc3', what);
    const ids = resetsOf(bars, o.reset ?? 'day', what);
    const v = bars.volume;
    const N = bars.length;
    const mid = new Float64Array(N);
    const sigma = new Float64Array(N);
    let a = 0;
    let b = 0;
    let c = 0;
    for (let i = 0; i < N; i++) {
      const p = x[i];
      const w = v[i];
      if (i === 0 || (ids && ids[i] !== ids[i - 1])) a = b = c = 0;
      a += p * w;
      b += p * p * w;
      c += w;
      const m = c > 0 ? a / c : p;
      mid[i] = m;
      sigma[i] = c > 0 ? Math.sqrt(Math.max(0, b / c - m * m)) : NaN_;
    }
    return { mid, sigma };
  }

  const vwap = (bars, opts) => vwapSums(bars, opts, 'ta.vwap').mid;
  const vwapStdev = (bars, opts) => vwapSums(bars, opts, 'ta.vwapStdev').sigma;

  function first(x, level, from, what, above) {
    series(x, what);
    if (!isNum(level)) throw new CodeError(`${what}: the level is a number, not ${show(level)}`);
    const start = from === undefined ? 0 : from;
    if (!finite(start) || Math.floor(start) !== start)
      throw new CodeError(`${what}: from is a bar index, not ${show(from)}`);
    for (let i = Math.max(0, start); i < x.length; i++) if (above ? x[i] > level : x[i] < level) return i;
    return -1;
  }
  const firstAbove = (x, level, from) => first(x, level, from, 'ta.firstAbove', true);
  const firstBelow = (x, level, from) => first(x, level, from, 'ta.firstBelow', false);

  const ta = Object.freeze({
    sma,
    ema,
    rma,
    wma,
    stdev,
    zscore,
    sum,
    cum,
    highest,
    lowest,
    shift,
    change,
    crossover,
    crossunder,
    rsi,
    tr,
    atr,
    vwap,
    vwapStdev,
    firstAbove,
    firstBelow,
  });

  const DAY = 86400;
  const zoneCache = new WeakMap();

  function notAZone(zone, what, path) {
    return new CodeError(
      `${what}: ${show(zone)} is not a time zone (an IANA name such as 'America/New_York', 'Europe/London' or 'UTC')`,
      path,
    );
  }

  const isZone = (zone) => typeof zone === 'string' && natives.zoneOffset(zone, 0) != null;

  function localTimes(bars, zone, what) {
    let byZone = zoneCache.get(bars);
    if (!byZone) {
      byZone = new Map();
      zoneCache.set(bars, byZone);
    }
    let local = byZone.get(zone);
    if (!local) {
      const off = typeof zone === 'string' ? natives.barOffsets(zone) : undefined;
      if (!off) throw notAZone(zone, what);
      local = new Float64Array(bars.length);
      for (let i = 0; i < bars.length; i++) local[i] = bars.time[i] + off[i];
      byZone.set(zone, local);
    }
    return local;
  }

  const HOURS = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/;

  function hours(spec, what, path) {
    const m = typeof spec === 'string' ? HOURS.exec(spec) : null;
    if (!m)
      throw new CodeError(
        `${what}: a session is hours of the day as 'HH:MM-HH:MM' ('09:30-11:00'), not ${show(spec)}`,
        path,
      );
    const start = Number(m[1]) * 60 + Number(m[2]);
    let end = Number(m[3]) * 60 + Number(m[4]);
    if (start >= 1440 || end > 1440 || Number(m[2]) > 59 || Number(m[4]) > 59) {
      throw new CodeError(`${what}: ${show(spec)} is not a time of day`, path);
    }
    if (end === 0) end = 1440;
    if (end <= start) end += 1440;
    return { start, end };
  }

  function sessionIds(bars, spec, zone, what) {
    const { start, end } = hours(spec, what);
    const local = localTimes(bars, zone === undefined ? 'UTC' : zone, what);
    const out = nans(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const day = Math.floor(local[i] / DAY);
      const minute = Math.floor((local[i] - day * DAY) / 60);
      if (minute >= start && minute < end) out[i] = day;
      else if (end > 1440 && minute < end - 1440) out[i] = day - 1;
    }
    return out;
  }

  function ids(bars, spec, zone) {
    if (!isBars(bars)) throw new CodeError(`session.ids takes the bars, not ${show(bars)}`);
    return sessionIds(bars, spec, zone, 'session.ids');
  }

  function dayNumber(key) {
    const y = Math.floor(key / 10000);
    const m = Math.floor(key / 100) % 100;
    const d = key % 100;
    return Date.UTC(y, m - 1, d) / 86400000;
  }

  function weekIds(bars) {
    const out = new Float64Array(bars.length);
    let lastKey = NaN_;
    let lastWeek = NaN_;
    for (let i = 0; i < bars.length; i++) {
      const key = bars.day[i];
      if (key !== lastKey) {
        lastKey = key;
        lastWeek = Math.floor((dayNumber(key) + 3) / 7);
      }
      out[i] = lastWeek;
    }
    return out;
  }

  function runs(bars, id) {
    const out = [];
    const N = bars.length;
    const { high, low, open, close } = bars;
    let i = 0;
    while (i < N) {
      const k = id[i];
      if (k !== k) {
        i++;
        continue;
      }
      let j = i;
      let hi = i;
      let lo = i;
      while (j < N && id[j] === k) {
        if (high[j] > high[hi]) hi = j;
        if (low[j] < low[lo]) lo = j;
        j++;
      }
      out.push(
        Object.freeze({
          id: k,
          start: i,
          end: j,
          open: open[i],
          high: high[hi],
          highAt: hi,
          low: low[lo],
          lowAt: lo,
          close: close[j - 1],
          complete: i > 0 && j < N,
        }),
      );
      i = j;
    }
    return out;
  }

  function periodIds(bars, period, zone, what) {
    if (!isBars(bars)) throw new CodeError(`${what} takes the bars, not ${show(bars)}`);
    if (period === 'day' || period === 'week') {
      if (zone !== undefined)
        throw new CodeError(
          `${what}: '${period}' is the instrument's trading ${period}, which no zone changes; for a calendar day in a zone give its hours ('00:00-00:00', ${show(zone)})`,
        );
      return period === 'day' ? bars.day : weekIds(bars);
    }
    return sessionIds(bars, period, zone, what);
  }

  const list = (bars, period, zone) => runs(bars, periodIds(bars, period, zone, 'session.list'));
  const days = (bars) => runs(bars, periodIds(bars, 'day', undefined, 'session.days'));
  const weeks = (bars) => runs(bars, periodIds(bars, 'week', undefined, 'session.weeks'));

  function running(bars, period, zone, what, greater) {
    const id = periodIds(bars, period, zone, what);
    const x = greater ? bars.high : bars.low;
    const out = nans(bars.length);
    let best = NaN_;
    for (let i = 0; i < bars.length; i++) {
      const k = id[i];
      if (k !== k) {
        best = NaN_;
        continue;
      }
      if (i === 0 || id[i - 1] !== k || best !== best) best = x[i];
      else best = greater ? Math.max(best, x[i]) : Math.min(best, x[i]);
      out[i] = best;
    }
    return out;
  }
  const high = (bars, period, zone) => running(bars, period, zone, 'session.high', true);
  const low = (bars, period, zone) => running(bars, period, zone, 'session.low', false);

  function prior(bars, period, zone) {
    const id = periodIds(bars, period, zone, 'session.prior');
    const all = runs(bars, id);
    const ph = nans(bars.length);
    const pl = nans(bars.length);
    let last = null;
    let r = 0;
    for (let i = 0; i < bars.length; i++) {
      while (r < all.length && all[r].end <= i) {
        if (all[r].start > 0) last = all[r];
        r++;
      }
      if (last) {
        ph[i] = last.high;
        pl[i] = last.low;
      }
    }
    return Object.freeze({ high: ph, low: pl });
  }

  function clock(t, zone = 'UTC') {
    if (!finite(t)) throw new CodeError(`session.clock takes a time (UTC seconds, bars.time[i]), not ${show(t)}`);
    const off = typeof zone === 'string' ? natives.zoneOffset(zone, t) : undefined;
    if (off == null) throw notAZone(zone, 'session.clock');
    const d = new Date((t + off) * 1000);
    return Object.freeze({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      weekday: d.getUTCDay(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    });
  }

  const session = Object.freeze({ ids, list, days, weeks, high, low, prior, clock });

  const MAX_OBJECTS = 500;
  const MAX_TEXT = 100;
  const SWATCHES = ['mist', 't1', 't2', 't3', 't4', 'up', 'down', 'brass', 'teal'];
  const DASHES = ['solid', 'dash', 'dot'];
  const EXTENDS = ['none', 'left', 'right', 'both'];
  const ALONG = ['start', 'middle', 'end'];
  const SIDES = ['above', 'below'];
  const LABEL_SIDES = ['above', 'below', 'at'];
  const SIZES = ['small', 'normal', 'large'];

  function color(v, what, path) {
    if (v == null) return null;
    if (typeof v === 'string') {
      if (SWATCHES.includes(v)) return v;
      if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return v;
    }
    throw new CodeError(`${what}: ${show(v)} is not a colour (use #rrggbb or one of ${SWATCHES.join(', ')})`, path);
  }

  function time(v, what, optional) {
    if (v == null && optional) return null;
    if (!finite(v)) throw new CodeError(`${what} is a bar time (bars.time[i], UTC seconds), not ${show(v)}`);
    if (v < 1e8 || v >= 1e11)
      throw new CodeError(`${what} is ${v}: a time is UTC seconds, as in bars.time (bars.time[i] for bar i)`);
    return v;
  }

  function price(v, what) {
    if (!finite(v)) throw new CodeError(`${what} must be a number, not ${show(v)}`);
    return v;
  }

  function text(v, what, optional) {
    if (v == null && optional) return null;
    if (typeof v !== 'string') throw new CodeError(`${what} is a string, not ${show(v)}`);
    const t = v.split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_TEXT);
    return t || !optional ? t : null;
  }

  const width = (lo) => (v, what) => Math.min(4, Math.max(lo, price(v, what)));
  const choice = (options) => (v, what) => oneOf(v, options, what);

  const SEGMENT = {
    time1: (v, w) => time(v, w, false),
    price1: price,
    time2: (v, w) => time(v, w, true),
    price2: price,
    color: (v, w) => color(v, w),
    style: choice(DASHES),
    extend: choice(EXTENDS),
    label: (v, w) => text(v, w, true),
    labelAt: choice(ALONG),
    labelSide: choice(SIDES),
    labelColor: (v, w) => color(v, w),
  };
  const FIELDS = {
    line: { ...SEGMENT, width: width(0.5) },
    label: {
      time: (v, w) => time(v, w, false),
      price,
      text: (v, w) => text(v, w, false),
      color: (v, w) => color(v, w),
      size: choice(SIZES),
      side: choice(LABEL_SIDES),
    },
    box: {
      ...SEGMENT,
      width: width(0),
      fill: (v, w) => color(v, w),
      opacity: (v, w) => Math.min(1, Math.max(0, price(v, w))),
    },
  };

  let canvas = null;

  class Canvas {
    constructor() {
      this.kinds = { line: new Map(), label: new Map(), box: new Map() };
      this.next = 0;
    }
    add(entry) {
      const m = this.kinds[entry.kind];
      entry.id = ++this.next;
      m.set(entry.id, entry);
      if (m.size > MAX_OBJECTS) {
        const oldest = m.keys().next().value;
        m.get(oldest).id = null;
        m.delete(oldest);
      }
    }
    remove(entry) {
      if (entry.id !== null) this.kinds[entry.kind].delete(entry.id);
      entry.id = null;
    }
    empty() {
      return this.kinds.line.size + this.kinds.label.size + this.kinds.box.size === 0;
    }
    out() {
      const seg = (v) => ({
        time1: v.time1,
        price1: v.price1,
        time2: v.time2,
        price2: v.price2,
        color: v.color,
        width: v.width,
        line: v.style,
        extend: v.extend,
        label: v.label ? { text: v.label, at: v.labelAt, side: v.labelSide, color: v.labelColor } : null,
      });
      const pick = (kind, f) => Array.from(this.kinds[kind].values(), (e) => f(e.v));
      return {
        lines: pick('line', seg),
        labels: pick('label', (v) => ({
          time: v.time,
          price: v.price,
          text: v.text,
          color: v.color,
          size: v.size,
          side: v.side,
        })),
        boxes: pick('box', (v) => ({ ...seg(v), fill: v.fill, opacity: v.opacity })),
      };
    }
  }

  function make(kind, values) {
    if (!canvas)
      throw new CodeError(`draw.${kind}() draws from inside compute(bars, inputs), where the bars are known`);
    const fields = FIELDS[kind];
    const entry = { kind, id: null, v: {} };
    for (const k of Object.keys(values)) entry.v[k] = fields[k](values[k], `${kind}.${k}`);
    const target = canvas;
    const remove = () => target.remove(entry);
    const handle = new Proxy(entry, {
      get(e, k) {
        if (k === 'delete') return remove;
        if (k === 'kind') return kind;
        if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(fields, k)) return e.v[k];
        return undefined;
      },
      set(e, k, v) {
        const check = typeof k === 'string' ? fields[k] : undefined;
        if (!check) throw new CodeError(`a ${kind} has no '${String(k)}'; it has ${Object.keys(fields).join(', ')}`);
        e.v[k] = check(v, `${kind}.${k}`);
        return true;
      },
      has: (e, k) => k === 'delete' || k === 'kind' || Object.prototype.hasOwnProperty.call(fields, k),
      ownKeys: () => Object.keys(fields),
      getOwnPropertyDescriptor: (e, k) =>
        Object.prototype.hasOwnProperty.call(fields, k)
          ? { value: e.v[k], writable: true, enumerable: true, configurable: true }
          : undefined,
      defineProperty: (e, k) => {
        throw new CodeError(`a ${kind} has no '${String(k)}'; it has ${Object.keys(fields).join(', ')}`);
      },
      deleteProperty: (e, k) => {
        throw new CodeError(`${kind}.${String(k)} cannot be deleted; delete() takes the ${kind} off the chart`);
      },
    });
    canvas.add(entry);
    return handle;
  }

  function options(opts, kind, allowed) {
    if (opts === undefined || opts === null) return {};
    if (typeof opts !== 'object' || Array.isArray(opts) || ArrayBuffer.isView(opts)) {
      throw new CodeError(`draw.${kind}: the options are an object ({ color: 'mist' }), not ${show(opts)}`);
    }
    for (const k of Object.keys(opts)) {
      if (!allowed.includes(k))
        throw new CodeError(`draw.${kind}: no option '${k}'; the options are ${allowed.join(', ')}`);
    }
    return opts;
  }

  const LINE_OPTIONS = [
    'time2',
    'price2',
    'color',
    'width',
    'style',
    'extend',
    'label',
    'labelAt',
    'labelSide',
    'labelColor',
  ];
  const BOX_OPTIONS = [...LINE_OPTIONS, 'fill', 'opacity'];
  const LABEL_OPTIONS = ['color', 'size', 'side'];
  const isOptions = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

  function line(time1, price1, a, b, c) {
    let o;
    let t2 = null;
    let p2;
    if (isOptions(a)) o = options(a, 'line', LINE_OPTIONS);
    else {
      t2 = a ?? null;
      if (isOptions(b)) o = options(b, 'line', LINE_OPTIONS);
      else {
        p2 = b;
        o = options(c, 'line', LINE_OPTIONS);
      }
    }
    if ('time2' in o) t2 = o.time2;
    if ('price2' in o) p2 = o.price2;
    return make('line', {
      time1,
      price1,
      time2: t2,
      price2: p2 === undefined || p2 === null ? price1 : p2,
      color: o.color ?? null,
      width: o.width ?? 1,
      style: o.style ?? 'solid',
      extend: o.extend ?? 'none',
      label: o.label ?? null,
      labelAt: o.labelAt ?? 'end',
      labelSide: o.labelSide ?? 'above',
      labelColor: o.labelColor ?? null,
    });
  }

  function label(time, price, text, opts) {
    const o = options(opts, 'label', LABEL_OPTIONS);
    return make('label', {
      time,
      price,
      text,
      color: o.color ?? null,
      size: o.size ?? 'normal',
      side: o.side ?? 'above',
    });
  }

  function box(time1, price1, time2, price2, opts) {
    const o = options(opts, 'box', BOX_OPTIONS);
    return make('box', {
      time1,
      price1,
      time2: time2 ?? null,
      price2,
      color: o.color ?? null,
      width: o.width ?? 1,
      style: o.style ?? 'solid',
      fill: o.fill ?? null,
      opacity: o.opacity ?? 0.12,
      extend: o.extend ?? 'none',
      label: o.label ?? null,
      labelAt: o.labelAt ?? 'start',
      labelSide: o.labelSide ?? 'above',
      labelColor: o.labelColor ?? null,
    });
  }

  const draw = Object.freeze({ line, label, box, MAX_OBJECTS });

  const PALETTE = ['mist', 't2', 't3', 'up', 'down'];
  const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

  function key(k, what, path) {
    if (typeof k !== 'string' || !KEY.test(k)) {
      throw new CodeError(
        `${what} ${show(k)} is not a valid name (letters, digits and _, up to 32, not starting with a digit)`,
        path,
      );
    }
    return k;
  }

  function labelOf(k) {
    const s = k
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function number(v, what, path) {
    if (!finite(v)) throw new CodeError(`${what} must be a number, not ${show(v)}`, path);
    return v;
  }

  function known(decl, fields, what, path) {
    const unknown = Object.keys(decl).filter((k) => !fields.includes(k));
    if (unknown.length)
      throw new CodeError(`${what} has unknown fields: ${unknown.join(', ')} (it takes ${fields.join(', ')})`, path);
  }

  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const INDICATOR_FIELDS = [
    'title',
    'short',
    'description',
    'placement',
    'format',
    'range',
    'inputs',
    'plots',
    'fills',
  ];
  const MAX_INPUTS = 24;
  const INPUT_FIELDS = ['type', 'default', 'min', 'max', 'step', 'options', 'label', 'inLabel'];
  const PLOT_FIELDS = [
    'name',
    'label',
    'kind',
    'color',
    'downColor',
    'colorBy',
    'width',
    'style',
    'opacity',
    'value',
    'valueInput',
    'shownBy',
    'visible',
  ];
  const FILL_FIELDS = ['from', 'to', 'name', 'label', 'color', 'opacity', 'shownBy'];

  function readInput(k, raw, path) {
    const decl = isPlain(raw) ? raw : { default: raw };
    known(decl, INPUT_FIELDS, `inputs.${k}`, path);
    let def = decl.default;
    let type = decl.type;
    if (type === undefined) {
      if (typeof def === 'boolean') type = 'bool';
      else if (finite(def)) type = Number.isInteger(def) ? 'int' : 'number';
      else if (typeof def === 'string' && SOURCES.includes(def)) type = 'source';
      else if (typeof def === 'string' && def.startsWith('#')) type = 'color';
      else if (decl.options !== undefined) type = 'enum';
      else if (typeof def === 'string' && HOURS.test(def)) type = 'session';
      else if (isZone(def)) type = 'timezone';
      else
        throw new CodeError(
          `inputs.${k}: give a default (a number, true or false, a price such as 'close', hours such as '09:30-11:00', a time zone such as 'Europe/London') or a type`,
          path,
        );
    }
    oneOf(type, ['int', 'number', 'bool', 'source', 'enum', 'color', 'session', 'timezone'], `inputs.${k}.type`);
    const item = {
      key: k,
      label: String(decl.label || labelOf(k)).slice(0, 40),
      type,
      min: null,
      max: null,
      step: null,
      options: null,
      inLabel: decl.inLabel === undefined ? type === 'int' || type === 'number' : Boolean(decl.inLabel),
    };
    if (type === 'int' || type === 'number') {
      for (const b of ['min', 'max', 'step']) if (decl[b] != null) item[b] = number(decl[b], `inputs.${k}.${b}`, path);
      if (def === undefined) def = item.min ?? 1;
      number(def, `inputs.${k}.default`, path);
      if (type === 'int') {
        if (!Number.isInteger(def))
          throw new CodeError(`inputs.${k}: an int input's default is a whole number, not ${def}`, path);
        if (item.step === null) item.step = 1;
      }
      if (item.min !== null && def < item.min)
        throw new CodeError(`inputs.${k}: default ${def} is below min ${item.min}`, path);
      if (item.max !== null && def > item.max)
        throw new CodeError(`inputs.${k}: default ${def} is above max ${item.max}`, path);
    } else if (type === 'bool') {
      if (def !== undefined && typeof def !== 'boolean')
        throw new CodeError(`inputs.${k}: a bool input's default is true or false, not ${show(def)}`, path);
      def = def ?? false;
    } else if (type === 'source') {
      def = def ?? 'close';
      if (!SOURCES.includes(def))
        throw new CodeError(`inputs.${k}: a source is one of ${SOURCES.join(', ')}, not ${show(def)}`, path);
    } else if (type === 'color') {
      def = color(def ?? 'mist', `inputs.${k}`, path);
    } else if (type === 'session') {
      hours(def, `inputs.${k}`, path);
    } else if (type === 'timezone') {
      def = def ?? 'UTC';
      if (!isZone(def)) throw notAZone(def, `inputs.${k}`, path);
    } else {
      const opts = decl.options;
      if (!Array.isArray(opts) || opts.length === 0)
        throw new CodeError(`inputs.${k}: an enum input lists its options`, path);
      item.options = opts.map((o) => {
        const value = isPlain(o) ? o.value : o;
        if (typeof value !== 'string' || !value)
          throw new CodeError(`inputs.${k}: options are strings, or { value, label }`, path);
        return { value, label: String((isPlain(o) && o.label) || labelOf(value)) };
      });
      def = def ?? item.options[0].value;
      if (!item.options.some((o) => o.value === def))
        throw new CodeError(`inputs.${k}: default ${show(def)} is not one of its options`, path);
    }
    item.default = def;
    return item;
  }

  function readPlot(raw, plots, types) {
    const decl = typeof raw === 'string' ? { name: raw } : raw;
    if (!isPlain(decl))
      throw new CodeError(`each plot is a name or an object ({ name: 'value' }), not ${show(raw)}`, ['plots']);
    const path = ['plots', typeof decl.name === 'string' ? decl.name : ''];
    known(decl, PLOT_FIELDS, `plot ${show(decl.name)}`, path);
    const name = key(decl.name, 'plot', path);
    if (plots.some((p) => p.key === name)) throw new CodeError(`two plots are named '${name}'`, path);
    const kind = decl.kind ?? 'line';
    oneOf(kind, ['line', 'histogram', 'hline'], `plot '${name}' kind`);
    const colorBy = decl.colorBy ?? null;
    if (colorBy !== null) oneOf(colorBy, ['direction', 'sign'], `plot '${name}' colorBy`);
    let value = decl.value ?? null;
    const valueInput = decl.valueInput ?? null;
    if (kind === 'hline') {
      if (value === null && valueInput === null)
        throw new CodeError(`hline '${name}' needs a value or a valueInput`, path);
      if (value !== null) value = number(value, `hline '${name}' value`, path);
      if (valueInput !== null && !['int', 'number'].includes(types[valueInput])) {
        throw new CodeError(`hline '${name}': valueInput must name a number input`, path);
      }
    }
    const shownBy = decl.shownBy ?? null;
    if (shownBy !== null && types[shownBy] !== 'bool')
      throw new CodeError(`plot '${name}': shownBy must name a bool input`, path);
    const w = number(decl.width ?? (kind === 'hline' ? 1 : 1.5), `plot '${name}' width`, path);
    const opacity = number(decl.opacity ?? (kind === 'hline' ? 0.6 : 1), `plot '${name}' opacity`, path);
    const style = decl.style ?? (kind === 'hline' ? 'dash' : 'solid');
    oneOf(style, DASHES, `plot '${name}' style`);
    const lines = plots.filter((p) => p.kind !== 'hline').length;
    const fallback = kind === 'hline' ? 't3' : PALETTE[lines % PALETTE.length];
    return {
      key: name,
      label: String(decl.label || labelOf(name)).slice(0, 40),
      kind,
      colorBy,
      value,
      valueInput,
      shownBy,
      default: {
        color: color(decl.color ?? fallback, `plot '${name}'`, path),
        downColor: color(decl.downColor ?? (colorBy ? 'down' : null), `plot '${name}' downColor`, path),
        width: Math.min(4, Math.max(0.5, w)),
        line: style,
        opacity: Math.min(1, Math.max(0, opacity)),
        visible: decl.visible === undefined ? true : Boolean(decl.visible),
      },
    };
  }

  function describe(decl, compute) {
    if (decl === undefined) {
      throw new CodeError(
        "declare the indicator: export const indicator = { title: 'My indicator', plots: ['value'] }",
      );
    }
    if (!isPlain(decl))
      throw new CodeError(`indicator is an object ({ title, inputs, plots, … }), not ${show(decl)}`, []);
    known(decl, INDICATOR_FIELDS, 'indicator', []);
    if (typeof compute !== 'function') {
      throw new CodeError('define the computation: export function compute(bars, inputs) { return { value: … } }');
    }
    const title = decl.title ?? 'Custom indicator';
    if (typeof title !== 'string' || !title.trim()) throw new CodeError('title is a non-empty string', ['title']);
    const short = decl.short ?? title;
    if (typeof short !== 'string' || !short.trim()) throw new CodeError('short is a non-empty string', ['short']);
    const placement = decl.placement ?? 'pane';
    if (!['overlay', 'pane'].includes(placement)) {
      throw new CodeError(`placement is 'overlay' (on the price) or 'pane' (its own pane), not ${show(placement)}`, [
        'placement',
      ]);
    }
    const fmt = decl.format ?? (placement === 'overlay' ? 'price' : 'number');
    if (!['price', 'number', 'volume'].includes(fmt))
      throw new CodeError(`format is 'price', 'number' or 'volume', not ${show(fmt)}`, ['format']);
    let range = decl.range ?? null;
    if (range !== null) {
      if (!Array.isArray(range) || range.length !== 2) throw new CodeError('range is [low, high]', ['range']);
      range = [number(range[0], 'range low', ['range']), number(range[1], 'range high', ['range'])];
      if (!(range[0] < range[1])) throw new CodeError("range's low must be below its high", ['range']);
    }
    const rawInputs = decl.inputs ?? {};
    if (!isPlain(rawInputs))
      throw new CodeError('inputs is an object of input name to its default or its declaration', ['inputs']);
    const inputKeys = Object.keys(rawInputs);
    if (inputKeys.length > MAX_INPUTS) throw new CodeError(`at most ${MAX_INPUTS} inputs`, ['inputs']);
    const inputs = inputKeys.map((k) => readInput(key(k, 'input', ['inputs', k]), rawInputs[k], ['inputs', k]));
    const types = Object.fromEntries(inputs.map((i) => [i.key, i.type]));

    let rawPlots = decl.plots;
    if (rawPlots === undefined) {
      throw new CodeError(
        "declare what compute() returns: plots: ['value'] or plots: [{ name: 'value', … }] (plots: [] for an indicator that only draws lines, labels and boxes)",
        [],
      );
    }
    if (typeof rawPlots === 'string' || isPlain(rawPlots)) rawPlots = [rawPlots];
    if (!Array.isArray(rawPlots)) throw new CodeError('plots is a list of plots', ['plots']);
    if (rawPlots.length > 16) throw new CodeError('at most 16 plots', ['plots']);
    const plots = [];
    for (const p of rawPlots) plots.push(readPlot(p, plots, types));
    if (plots.length && !plots.some((p) => p.kind !== 'hline')) {
      throw new CodeError('plots needs at least one line or histogram besides its guides', ['plots']);
    }

    const rawFills = decl.fills ?? [];
    if (!Array.isArray(rawFills)) throw new CodeError('fills is a list of { from: plot, to: plot }', ['fills']);
    const keys = new Set(plots.map((p) => p.key));
    const fills = rawFills.slice(0, 8).map((f, i) => {
      if (!isPlain(f) || !keys.has(f.from) || !keys.has(f.to)) {
        throw new CodeError("each fill names two plots: { from: 'upper', to: 'lower' }", ['fills']);
      }
      known(f, FILL_FIELDS, 'fill', ['fills']);
      return {
        key: key(f.name ?? `fill${i + 1}`, 'fill', ['fills']),
        label: String(f.label || `${f.from} to ${f.to}`).slice(0, 40),
        from: f.from,
        to: f.to,
        shownBy: f.shownBy ?? null,
        default: {
          color: color(f.color ?? 'mist', 'fill', ['fills']),
          opacity: Math.min(1, Math.max(0, number(f.opacity ?? 0.12, 'fill opacity', ['fills']))),
          visible: true,
        },
      };
    });
    const description = decl.description ?? null;
    if (description !== null && typeof description !== 'string')
      throw new CodeError('description is a string', ['description']);
    return {
      title: title.trim().slice(0, 64),
      short: short.trim().slice(0, 24),
      description: description ? description.split(/\s+/).filter(Boolean).join(' ').slice(0, 400) : null,
      placement,
      format: fmt,
      range,
      inputs,
      plots,
      fills,
    };
  }

  function barsOf(cols) {
    const n = cols.time.length;
    const { high, low, close, open, volume } = cols;
    const hl2 = new Float64Array(n);
    const hlc3 = new Float64Array(n);
    const ohlc4 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      hl2[i] = (high[i] + low[i]) / 2;
      hlc3[i] = (high[i] + low[i] + close[i]) / 3;
      ohlc4[i] = (open[i] + high[i] + low[i] + close[i]) / 4;
    }
    const bars = { length: n, time: cols.time, open, high, low, close, volume, hl2, hlc3, ohlc4, day: cols.day };
    if (cols.buyVolume) {
      const sell = new Float64Array(n);
      const delta = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        sell[i] = volume[i] - cols.buyVolume[i];
        delta[i] = cols.buyVolume[i] - sell[i];
      }
      bars.buyVolume = cols.buyVolume;
      bars.sellVolume = sell;
      bars.delta = delta;
    }
    if (cols.session) bars.session = cols.session;
    if (cols.levels) {
      bars.levels = Object.freeze(cols.levels);
      bars.levelsAsOf = Object.freeze(cols.levelsAsOf);
    }
    return Object.freeze(bars);
  }

  function resolveInputs(manifest, given, bars) {
    const rest = { ...(given ?? {}) };
    const out = {};
    for (const i of manifest.inputs) {
      const k = i.key;
      let v = k in rest ? rest[k] : i.default;
      delete rest[k];
      if (i.type === 'int' || i.type === 'number') {
        if (!finite(v)) throw new CodeError(`input ${k} must be a number, not ${show(v)}`);
        if (i.type === 'int' && !Number.isInteger(v))
          throw new CodeError(`input ${k} must be a whole number, not ${v}`);
        if (i.min !== null && v < i.min) throw new CodeError(`input ${k} is ${v}; it must be at least ${i.min}`);
        if (i.max !== null && v > i.max) throw new CodeError(`input ${k} is ${v}; it must be at most ${i.max}`);
      } else if (i.type === 'bool') {
        if (typeof v !== 'boolean') throw new CodeError(`input ${k} is true or false, not ${show(v)}`);
      } else if (i.type === 'source') {
        if (!SOURCES.includes(v)) throw new CodeError(`input ${k} is one of ${SOURCES.join(', ')}, not ${show(v)}`);
        v = bars[v];
      } else if (i.type === 'enum') {
        if (!i.options.some((o) => o.value === v))
          throw new CodeError(`input ${k}: ${show(v)} is not one of its options`);
      } else if (i.type === 'color') {
        v = color(v, `input ${k}`);
      } else if (i.type === 'session') {
        hours(v, `input ${k}`);
      } else if (i.type === 'timezone') {
        if (!isZone(v)) throw notAZone(v, `input ${k}`);
      }
      out[k] = v;
    }
    const extra = Object.keys(rest);
    if (extra.length) {
      const names = manifest.inputs.map((i) => i.key).join(', ') || 'none';
      throw new CodeError(`no input named ${extra.join(', ')} (inputs: ${names})`);
    }
    return Object.freeze(out);
  }

  function toSeries(k, v, n) {
    if (isNum(v))
      throw new CodeError(`plot '${k}': compute() returned one number; return an array with a value per bar`);
    if (v == null || typeof v !== 'object' || typeof v.length !== 'number') {
      throw new CodeError(`plot '${k}': compute() returned ${show(v)}, not an array with a value per bar`);
    }
    if (v.length !== n) throw new CodeError(`plot '${k}' has ${v.length} values; there are ${n} bars`);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = v[i];
      out[i] = typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'boolean' ? Number(x) : NaN_;
    }
    return out;
  }

  function run(decl, compute, cols, given) {
    const manifest = describe(decl, compute);
    const bars = barsOf(cols);
    const inputs = resolveInputs(manifest, given, bars);
    const mine = (canvas = new Canvas());
    let result;
    try {
      result = compute(bars, inputs);
    } finally {
      canvas = null;
    }
    const keys = manifest.plots.filter((p) => p.kind !== 'hline').map((p) => p.key);
    if (keys.length === 0 && result == null) result = {};
    if (!isPlain(result) || ArrayBuffer.isView(result)) {
      if (keys.length === 1 && result != null && typeof result === 'object') result = { [keys[0]]: result };
      else {
        const want = keys.length ? `an object with ${keys.join(', ')}` : 'nothing (plots: [])';
        throw new CodeError(`compute() returned ${show(result)}; return ${want}`);
      }
    }
    const extra = Object.keys(result).filter((k) => !keys.includes(k));
    if (extra.length) {
      throw new CodeError(
        `compute() returned ${extra.map((k) => `'${k}'`).join(', ')}, which plots does not declare (plots: ${keys.join(', ') || 'none'})`,
      );
    }
    const missing = keys.filter((k) => !(k in result));
    if (missing.length) throw new CodeError(`compute() did not return ${missing.map((k) => `'${k}'`).join(', ')}`);
    return {
      manifest: JSON.stringify(manifest),
      keys,
      values: keys.map((k) => toSeries(k, result[k], bars.length)),
      objects: mine.empty() ? null : JSON.stringify(mine.out()),
    };
  }

  function call(entry, cols, params) {
    if (typeof entry !== 'function') throw new CodeError('the module exports no such function');
    const bars = barsOf(cols);
    const result = entry(bars, params);
    if (!isPlain(result)) throw new CodeError(`it returned ${show(result)}, not an object of arrays`);
    const keys = Object.keys(result);
    return { keys, values: keys.map((k) => toSeries(k, result[k], bars.length)) };
  }

  const STRATEGY_FIELDS = ['description', 'inputs'];
  const DECIDED = ['position', 'stopDistance', 'targetDistance'];

  function strategyInputs(decl, positions) {
    if (typeof positions !== 'function') {
      throw new CodeError(
        'define the rules: export function positions(bars, inputs) { return position } (a target position per bar)',
      );
    }
    if (decl === undefined) return [];
    if (!isPlain(decl)) throw new CodeError(`strategy is an object ({ inputs }), not ${show(decl)}`, []);
    known(decl, STRATEGY_FIELDS, 'strategy', []);
    const raw = decl.inputs ?? {};
    if (!isPlain(raw))
      throw new CodeError('inputs is an object of input name to its default or its declaration', ['inputs']);
    const keys = Object.keys(raw);
    if (keys.length > MAX_INPUTS) throw new CodeError(`at most ${MAX_INPUTS} inputs`, ['inputs']);
    return keys.map((k) => readInput(key(k, 'input', ['inputs', k]), raw[k], ['inputs', k]));
  }

  function decided(k, v, n) {
    if (v == null || typeof v !== 'object' || typeof v.length !== 'number') {
      throw new CodeError(`positions() returned ${show(v)} for ${k}, not an array with a value per bar`);
    }
    if (v.length !== n) throw new CodeError(`${k} has ${v.length} values; there are ${n} bars`);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = v[i];
      out[i] = typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'boolean' ? Number(x) : NaN_;
    }
    return out;
  }

  function strategy(decl, positions, cols, given) {
    const inputs = strategyInputs(decl, positions);
    const bars = barsOf(cols);
    const resolved = resolveInputs({ inputs }, given, bars);
    let result = positions(bars, resolved);
    if (!isPlain(result) || ArrayBuffer.isView(result)) result = { position: result };
    known(result, DECIDED, 'what positions() returned');
    if (!('position' in result)) throw new CodeError('positions() returned no position');
    const keys = DECIDED.filter((k) => k in result);
    return { keys, values: keys.map((k) => decided(k, result[k], bars.length)) };
  }

  function records(entry, text, name) {
    if (typeof entry !== 'function') {
      throw new CodeError(
        'define the reader: export function records(text, file) { return { time, instrument, level, value } }',
      );
    }
    const out = entry(text, Object.freeze({ name }));
    if (!isPlain(out)) throw new CodeError(`records() returned ${show(out)}, not an object of columns`);
    return JSON.stringify(out, (_, v) =>
      ArrayBuffer.isView(v) ? Array.from(v, (x) => (Number.isFinite(x) ? x : null)) : v,
    );
  }

  const hidden = (v) => ({ value: v, writable: false, enumerable: false, configurable: false });
  Object.defineProperties(global, {
    ta: hidden(ta),
    session: hidden(session),
    draw: hidden(draw),
    console: hidden(console),
    __tessera: hidden(
      Object.freeze({
        describe: (d, c) => JSON.stringify(describe(d, c)),
        run,
        call,
        describeStrategy: (d, p) => JSON.stringify(strategyInputs(d, p)),
        strategy,
        records,
      }),
    ),
  });
})(globalThis);
