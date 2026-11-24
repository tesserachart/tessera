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
