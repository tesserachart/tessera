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
