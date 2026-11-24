# Custom indicators

A custom indicator is a short JavaScript module. It declares what it takes (inputs) and what it draws (plots), computes
its values from the bars, and may draw lines, labels and boxes. Tessera runs it in its own engine (QuickJS, built into
the runtime) and draws the result like a built-in: legend, settings, styles and presets.

What it computes is a measured value of a formula over past bars. A cross, a band or a level describes the data; it is
not a prediction.

## Quick start

```js
export const indicator = { title: 'Fast EMA', placement: 'overlay', inputs: { length: 9 }, plots: ['ema'] };

export function compute(bars, inputs) {
  return { ema: ta.ema(bars.close, inputs.length) };
}
```

Open **Indicators** and choose **New indicator**. It runs over the active chart's market as you type. **Save**, then
**Add to chart**.

## The declaration: `export const indicator = {…}`

| Field         | What it is                                                    | Default                              |
| ------------- | ------------------------------------------------------------- | ------------------------------------ |
| `title`       | The name in the catalog and the legend (up to 64 characters)  | `Custom indicator`                   |
| `short`       | The start of its legend label (up to 24)                      | `title`                              |
| `description` | What it computes; a `/** … */` that opens the file also works | none                                 |
| `placement`   | `"overlay"` (on the price) or `"pane"` (its own pane)         | `"pane"`                             |
| `format`      | `"price"`, `"number"` or `"volume"`                           | price on the price, number in a pane |
| `range`       | A fixed pane scale, `[low, high]`                             | the pane fits the values             |
| `inputs`      | What the user can set (at most 24)                            | none                                 |
| `plots`       | What `compute` returns, and guides (at most 16)               | required (`[]` when it only draws)   |
| `fills`       | Shading between two plots (at most 8)                         | none                                 |

**Inputs** map a name to a default (`length: 14`, `mult: 2.5`, `on: true`, `source: "close"`) or to a declaration
`{ type, default, min, max, step, options, label, inLabel }`. The types are `int`, `number`, `bool`, `source`, `enum`
(`options: ["a", { value: "b", label: "Bee" }]`), `color`, `session` (hours of the day, `"07:00-10:00"`) and `timezone`
(an IANA name, `"Europe/London"`). A bare default picks its type. A `source` input arrives in `compute` as the price
series it names; a `session` or `timezone` input arrives as its text. A value outside its bounds is refused before the
code runs.

**Plots** are names or `{ name, label, kind, color, width, style, opacity, colorBy, downColor, value, valueInput,
shownBy, visible }`. `kind` is `line` (the default), `histogram` or `hline`, a guide drawn at `value` or at a number
input's value. `style` is `solid`, `dash` or `dot`. `colorBy` is `direction` or `sign`. `shownBy` names a bool input
that shows or hides it; `visible: false` starts it hidden. Colours are palette names (`mist`, `t1`–`t4`, `up`, `down`,
`brass`, `teal`) or hex (`#rrggbb`). An indicator with plots needs at least one line or histogram. **Fills** are
`{ from, to, name, label, color, opacity, shownBy }`, where `from` and `to` name plots.

## `export function compute(bars, inputs)`

`bars` holds `Float64Array`s, oldest bar first: `time` (UTC seconds), `open`, `high`, `low`, `close`, `volume`, `hl2`,
`hlc3`, `ohlc4`, `day` (the instrument's trading day as `yyyymmdd`, from its session calendar; a CME day starts at 18:00
New York) and, when the bars carry aggressor sides, `buyVolume`, `sellVolume` and `delta`. `bars.length` is the number
of bars.

Return an object of plot name to an array as long as the bars, with `NaN` where there is no value. With one plot the
array alone will do. Every line and histogram plot must be in the result, and nothing else. `console.log` prints under
the editor.

### `ta`

The chart's own definitions. Averages seed with the mean of their first `n` values, deviations are population
deviations, and warm-ups are `NaN`.

| Function                                                   | Value                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `sma(x, n)`, `ema(x, n)`, `rma(x, n)`, `wma(x, n)`         | Simple, exponential, Wilder's and weighted averages                                                                            |
| `stdev(x, n)`, `zscore(x, n)`                              | Rolling deviation; distance from the rolling mean in deviations                                                                |
| `sum(x, n)`, `cum(x)`, `highest(x, n)`, `lowest(x, n)`     | Rolling sum, running sum, rolling max and min                                                                                  |
| `shift(x, k)`, `change(x, k)`                              | The value k bars back; `x` minus that value                                                                                    |
| `crossover(a, b)`, `crossunder(a, b)`                      | 1 on bars where `a` crosses above (below) `b`, else 0; either may be a number                                                  |
| `rsi(x, n)`, `tr(bars)`, `atr(bars, n, smoothing)`         | RSI (Wilder), true range, average true range (`smoothing`: `"rma"`, `"sma"`, `"ema"` or `"wma"`)                               |
| `vwap(bars, { source, reset })`, `vwapStdev(bars, …)`      | VWAP of a bar price (default `hlc3`) restarting each `reset` (`"day"`, `"week"`, `"none"` or an id per bar), and its deviation |
| `firstAbove(x, level, from)`, `firstBelow(x, level, from)` | The first bar at or after `from` beyond `level`, or −1                                                                         |

The chart's own VWAP (each session, week or month) is measured from prints, not bars; read it with `indicators.compute`.

### `session`

Hours are read in UTC unless a time zone follows them: `list(bars, "07:00-10:00", "Europe/London")` is London's morning
all year, daylight saving included. An unknown zone is refused. `"day"` and `"week"` are the instrument's own trading
days and weeks (`bars.day`), which no zone changes.

| Function                                              | Value                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list(bars, "09:30-11:00", zone)`                     | Each occurrence of those hours: `{ start, end, open, high, highAt, low, lowAt, close, complete }`. `start`, `end`, `highAt` and `lowAt` are bar indices; `end` is the bar after its last; `complete` when it is whole within the bars |
| `days(bars)`, `weeks(bars)`                           | The same for trading days and weeks                                                                                                                                                                                                   |
| `ids(bars, hours, zone)`                              | Per bar, the day its occurrence began on, `NaN` outside                                                                                                                                                                               |
| `high(bars, period, zone)`, `low(bars, period, zone)` | Per bar, the high (low) of its occurrence so far; `period` is hours, `"day"` or `"week"`                                                                                                                                              |
| `prior(bars, period, zone)`                           | Per bar, `{ high, low }` of the previous whole occurrence (PDH/PDL, PWH/PWL)                                                                                                                                                          |
| `clock(t, zone)`                                      | `{ year, month, day, weekday, hour, minute, second }` of a time in a zone (UTC without one)                                                                                                                                           |

### `draw`

| Call                                                   | Draws                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `draw.line(time1, price1, [time2, price2,] [options])` | A line between two (bar time, price) points. No `time2` runs it to the last bar; no `price2` keeps it level |
| `draw.label(time, price, text, [options])`             | Text `side` `"above"`, `"below"` or `"at"` the price; `size` `"small"`, `"normal"` or `"large"`; `color`    |
| `draw.box(time1, price1, time2, price2, [options])`    | A box; `color` is its border (`width: 0` for none), `fill` its inside at `opacity`                          |

Line and box options: `color`, `width`, `style`, `extend` (`"none"`, `"left"`, `"right"`, `"both"`), `label` (text on
it), `labelAt` (`"start"`, `"middle"`, `"end"`), `labelSide` (`"above"`, `"below"`) and `labelColor`. Without a colour
an object takes the indicator's. Times are bar times (`bars.time[i]`). Each call returns a handle: set its fields later
(`level.time2 = bars.time[j]`, `level.style = "dash"`) or call `level.delete()`. At most 500 of each kind are kept, the
newest. A level that must move with new sessions belongs here, not in fixed chart drawings.

## Errors and limits

Errors name the line of your code: `line 4: inputs.n: default 0 is below min 1`. A save reads the declaration first and
refuses a bad one, so the catalog never holds an indicator the chart cannot draw.

Each run gets a fresh engine with 2 s and 64 MB. There is nothing of the machine to reach: no imports, files, network,
timers or processes. Code is at most 256 KB. The runtime runs it over every bar the chart holds (up to 50,000) and
keeps the values. It runs again when the bars change, at most once a second while a bar forms.

## Examples

### EMA cross

```js
/**
 * Two exponential moving averages of a price. Where the fast one crosses the slow one, the short-term
 * average has moved through the longer one; it says nothing about what comes next.
 */
export const indicator = {
  title: 'EMA cross',
  short: 'EMA×',
  placement: 'overlay',
  inputs: {
    fast: { type: 'int', default: 9, min: 1, max: 500 },
    slow: { type: 'int', default: 21, min: 2, max: 500 },
    source: 'close',
  },
  plots: [
    { name: 'fast', label: 'Fast', color: 'mist' },
    { name: 'slow', label: 'Slow', color: 't3' },
  ],
  fills: [{ from: 'fast', to: 'slow', color: 'mist', opacity: 0.08 }],
};

export function compute(bars, inputs) {
  // a source input arrives as the price series it names
  return {
    fast: ta.ema(inputs.source, inputs.fast),
    slow: ta.ema(inputs.source, inputs.slow),
  };
}
```

### Z-score band

```js
/**
 * How many standard deviations the close sits from its moving average, with a band at ±k. A measured
 * distance from a recent mean, not a forecast of a return to it.
 */
export const indicator = {
  title: 'Z-score band',
  short: 'Z',
  placement: 'pane',
  inputs: {
    length: { type: 'int', default: 50, min: 2, max: 2000 },
    band: { type: 'number', default: 2, min: 0.5, max: 5, step: 0.1 },
  },
  plots: [
    { name: 'z', label: 'Z', color: 'mist', width: 1.5 },
    { name: 'upper', label: '+k', color: 't3', style: 'dash', width: 1 },
    { name: 'lower', label: '−k', color: 't3', style: 'dash', width: 1 },
    { name: 'zero', kind: 'hline', value: 0 },
  ],
  fills: [{ from: 'upper', to: 'lower', color: 'mist', opacity: 0.06 }],
};

export function compute(bars, inputs) {
  const z = ta.zscore(bars.close, inputs.length);
  const upper = z.map((v) => (Number.isNaN(v) ? NaN : inputs.band));
  return { z, upper, lower: upper.map((v) => -v) };
}
```

### Delta divergence

```js
/**
 * Where price and cumulative delta sit in their recent ranges, and how far apart. Each is placed between
 * -1 (its low over the window) and +1 (its high); the oscillator is delta's place minus price's, smoothed.
 * It is negative when price is high in its range while buyers' net volume is not, positive in the
 * opposite case. Needs aggressor-side volume.
 */
export const indicator = {
  title: 'Delta divergence',
  short: 'Δ div',
  placement: 'pane',
  range: [-2, 2],
  inputs: {
    length: { type: 'int', default: 20, min: 3, max: 500 },
    smooth: { type: 'int', default: 5, min: 1, max: 100 },
  },
  plots: [
    { name: 'osc', label: 'Divergence', kind: 'histogram', colorBy: 'sign', color: 'up', downColor: 'down' },
    { name: 'zero', kind: 'hline', value: 0 },
  ],
};

/** Where x sits in its last n values: -1 at the low, +1 at the high, 0 when they are equal. */
function place(x, n) {
  const hi = ta.highest(x, n);
  const lo = ta.lowest(x, n);
  return x.map((v, i) => (Number.isNaN(hi[i]) ? NaN : hi[i] > lo[i] ? (2 * (v - lo[i])) / (hi[i] - lo[i]) - 1 : 0));
}

export function compute(bars, inputs) {
  if (!bars.delta) throw new Error('this market reports no aggressor side, so there is no delta to compare');
  const price = place(bars.close, inputs.length);
  const delta = place(ta.cum(bars.delta), inputs.length);
  const apart = delta.map((d, i) => d - price[i]);
  return { osc: ta.ema(apart, inputs.smooth) };
}
```

### Session levels

```js
/**
 * Each session's high and low as a level: Asia, London and the New York morning, the previous day's (PDH,
 * PDL) and the previous week's (PWH, PWL). A level runs from the bar that made it until a later bar trades
 * through it, and stops there; each is named on its line, in its colour. Each session's hours are read in its
 * own time zone, so London stays 07:00-10:00 London through the weeks when the US and the UK change their
 * clocks on different dates. A level is a price the market traded; it does not say whether price will come
 * back to it.
 */
export const indicator = {
  title: 'Session levels',
  short: 'Sessions',
  placement: 'overlay',
  inputs: {
    asia: { type: 'bool', default: true, label: 'Asia' },
    asiaColor: { type: 'color', default: 't3', label: 'Asia colour' },
    asiaHours: { type: 'session', default: '20:00-00:00', label: 'Asia hours' },
    asiaZone: { type: 'timezone', default: 'America/New_York', label: 'Asia time zone' },
    london: { type: 'bool', default: true, label: 'London' },
    londonColor: { type: 'color', default: 't2', label: 'London colour' },
    londonHours: { type: 'session', default: '07:00-10:00', label: 'London hours' },
    londonZone: { type: 'timezone', default: 'Europe/London', label: 'London time zone' },
    nyAm: { type: 'bool', default: true, label: 'NY AM' },
    nyAmColor: { type: 'color', default: 'mist', label: 'NY AM colour' },
    nyAmHours: { type: 'session', default: '09:30-11:00', label: 'NY AM hours' },
    nyAmZone: { type: 'timezone', default: 'America/New_York', label: 'NY AM time zone' },
    day: { type: 'bool', default: true, label: 'Previous day' },
    dayColor: { type: 'color', default: 't1', label: 'Previous day colour' },
    week: { type: 'bool', default: true, label: 'Previous week' },
    weekColor: { type: 'color', default: 't2', label: 'Previous week colour' },
    swept: { type: 'bool', default: true, label: 'Keep swept levels' },
  },
  plots: [], // it draws lines, no plots
};

// name, and the start of its inputs' names
const SESSIONS = [
  ['Asia', 'asia'],
  ['London', 'london'],
  ['NY AM', 'nyAm'],
];

export function compute(bars, inputs) {
  const sources = SESSIONS.filter(([, key]) => inputs[key]).map(([name, key]) => [
    `${name} H`,
    `${name} L`,
    inputs[`${key}Color`],
    session.list(bars, inputs[`${key}Hours`], inputs[`${key}Zone`]),
  ]);
  if (inputs.day) sources.push(['PDH', 'PDL', inputs.dayColor, session.days(bars)]);
  if (inputs.week) sources.push(['PWH', 'PWL', inputs.weekColor, session.weeks(bars)]);
  for (const [high, low, color, periods] of sources) {
    // one begun before the first bar (its extremes are unknown) or not over yet draws nothing
    for (const p of periods.filter((p) => p.complete)) {
      level(bars, p.highAt, p.high, ta.firstAbove(bars.high, p.high, p.end), high, color, inputs.swept);
      level(bars, p.lowAt, p.low, ta.firstBelow(bars.low, p.low, p.end), low, color, inputs.swept);
    }
  }
}

/** A level from bar `from` until now, or until bar `swept` traded through it (-1: none has yet). */
function level(bars, from, price, swept, name, color, keepSwept) {
  if (swept >= 0 && !keepSwept) return;
  const line = draw.line(bars.time[from], price, { color, label: name }); // until now
  if (swept >= 0) {
    line.time2 = bars.time[swept]; // it stops where price traded through it
    line.style = 'dash';
  }
}
```

## For the analyst and other tools

`indicators.list`, `indicators.get` (a custom one's code and versions), `indicators.preview` (unsaved code over an
instrument's bars: values, objects, or the error with its line), `indicators.compute` (a saved one's values, or a
built-in's), `indicators.create_custom`, `indicators.update_custom` (`baseVersion` guards against a save made in
between) and `indicators.delete_custom`. `chart.add_layer {kind: "custom", params: {indicator: "ci_…"}}` draws one.

## Studies and level files

The same engine runs a research study's rules and a vendor file's reader.

A study's strategy (`research.save_study`, `strategy: {kind: "script", code, inputs}`) exports `positions(bars, inputs)`.
It returns an array with a target position per bar in contracts (`NaN` for no change), or such arrays as
`{ position, stopDistance, targetDistance }` to give a trade its own stop and target, in price from its fill. Each decision acts at the next bar's open. `bars` is
the indicator's, plus `session`, `levels` and `levelsAsOf` (the study's level inputs, `NaN` where none stands).
`export const strategy = { inputs }` declares inputs the way an indicator does; they count toward the study's research
budget. A run gets 30 s and 512 MB. `fixtures/research/orb-baseline.js` is an opening-range breakout written this way.

A level-history adapter (`intel.import_level_history`, `adapter: {kind: "script", vendor, code}`) exports
`records(text, file)` and returns `{ time, instrument, level, value, package? }`: arrays of one length, or one value for
every row. `null` or `NaN` means not applicable.
