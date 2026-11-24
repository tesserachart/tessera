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
