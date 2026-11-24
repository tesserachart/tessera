/**
 * ORB baseline on 5-minute bars. The opening range is the high and low of the first `minutes`
 * from 9:30 New York. The entry is at the next open after a close outside it, once a session.
 * A close back through the range's midpoint takes the trade out at the next open, and the target
 * is `mult` times the range's width from the fill. The study's window (9:30 to 12:00) has it
 * flat by noon.
 */
export const strategy = {
  inputs: {
    minutes: { type: 'int', default: 15, min: 5, max: 120 },
    mult: { type: 'number', default: 2, min: 0.5, max: 10 },
  },
};

export function positions(bars, inputs) {
  const n = bars.length;
  const position = new Float64Array(n).fill(NaN);
  const targetDistance = new Float64Array(n).fill(NaN);
  const open = 9 * 60 + 30;
  const formed = open + inputs.minutes;
  let day = NaN;
  let high = -Infinity;
  let low = Infinity;
  let side = 0;
  let traded = false;
  for (let i = 0; i < n; i++) {
    if (bars.day[i] !== day) {
      day = bars.day[i];
      high = -Infinity;
      low = Infinity;
      side = 0;
      traded = false;
    }
    const t = session.clock(bars.time[i], 'America/New_York');
    const minute = t.hour * 60 + t.minute;
    if (minute < open) continue;
    if (minute < formed) {
      high = Math.max(high, bars.high[i]);
      low = Math.min(low, bars.low[i]);
      continue;
    }
    if (!(high > low)) continue;
    const close = bars.close[i];
    if (side === 0 && !traded) {
      side = close > high ? 1 : close < low ? -1 : 0;
      if (side !== 0) {
        position[i] = side;
        targetDistance[i] = inputs.mult * (high - low);
        traded = true;
      }
    } else if (side !== 0 && side * (close - (high + low) / 2) < 0) {
      position[i] = 0;
      side = 0;
    }
  }
  return { position, targetDistance };
}
