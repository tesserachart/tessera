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
