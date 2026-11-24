const SUMMARIES: Readonly<Record<string, string>> = {
  volume: 'How many contracts traded in each bar, coloured by whether the bar closed up or down, with an average line.',
  vwap: 'The average price paid, weighted by volume, restarting each session, week or month. Bands show how far price has stretched from it.',
  sma: 'The plain average of the last closes, a smooth line that follows the trend.',
  ema: 'An average of the last closes that leans on the most recent bars, so it turns sooner than a simple average.',
  rsi: 'Momentum from 0 to 100 that compares recent up moves with down moves. High readings mean stretched up, low ones stretched down.',
  atr: 'How far price usually travels in a bar. Use it to size stops and targets to the market you are in.',
  volume_profile:
    'How much traded at each price, drawn sideways beside the chart. It marks the busiest price and the range where most of the volume sat.',
  market_profile:
    'Market Profile: each price gets a letter for every half hour it traded in, or the time you pick, stacked from the start of the session, so the shape shows where the market spent its time. It marks the most visited price, the value area and the first hour’s range.',
  footprint:
    'Inside each bar, how many contracts sellers hit and buyers lifted at every price. It flags lopsided prices and stacks of them.',
  big_trades:
    'Bubbles where unusually large orders hit the market, sized by how big they were. Bubbles in the up colour bought, in the down colour sold.',
  wma: 'An average of the last closes that weighs each bar more the newer it is.',
  bollinger:
    'A moving average with a band above and below that widens when the market gets jumpy and narrows when it calms down.',
  macd: 'The gap between a fast and a slow average, with a signal line and a histogram, to read shifts in momentum.',
  stochastic: 'Where the close sits in the recent high-low range, from 0 to 100, with a slower line to confirm turns.',
  delta: 'Buying minus selling at the market, bar by bar or added up through the session.',
  stacked_imbalance:
    'Zones where one side hit through several prices in a row inside a bar. Each runs right until price comes back to it, with or without the footprint on.',
  opening_range:
    'The high and low of each session’s first minutes, the opening range, and of its first hour, the initial balance, with lines half and a full range beyond them.',
  effort:
    'Bands over bursts where one side traded hard but price barely moved. They mark where that effort was absorbed, for price to come back to.',
};

const SHARED_HELP: Readonly<Record<string, string>> = {
  length: 'How many bars it looks back over. Fewer bars follow price closer; more bars smooth it out.',
  source: 'Which price of each bar it uses: the close, open, high, low or an average of them.',
  upper: 'The level above which it counts as stretched up. A guide line is drawn there.',
  lower: 'The level below which it counts as stretched down. A guide line is drawn there.',
  rowTicks: 'How many ticks each row covers. Auto picks a size that keeps the rows readable at this zoom.',
  daysToLoad:
    'How many sessions of prints it fetches, this one counting as one. Fewer load faster; older bars use prints already saved on this computer.',
};

const INPUT_HELP: Readonly<Record<string, string>> = {
  'volume.maLength': 'How many bars the average line covers.',
  'vwap.period':
    'How long the average runs before it starts over: each session, each week or each month. The bands follow it.',
  'vwap.band1': 'Draw the first band around the average price.',
  'vwap.mult1': 'How far the first band sits from the average, in standard deviations.',
  'vwap.band2': 'Draw the second band around the average price.',
  'vwap.mult2': 'How far the second band sits from the average, in standard deviations.',
  'vwap.band3': 'Draw the third band around the average price.',
  'vwap.mult3': 'How far the third band sits from the average, in standard deviations.',
  'atr.smoothing': 'How the bar ranges are averaged. Wilder’s method is the classic one.',
  'volume_profile.period':
    'Which bars to count: each session, day, week or month on its own, several of them together, a range you pick on the chart, from a bar you pick to now, or what is on screen.',
  'volume_profile.compositePeriod': 'What a composite adds up: sessions, days, weeks or months.',
  'volume_profile.length':
    'How many sessions, days, weeks or months: each drawn on its own, or added up in a composite.',
  'volume_profile.from': 'Where a fixed range or an anchored profile starts.',
  'volume_profile.to': 'Where a fixed range ends.',
  'volume_profile.contract': 'Which contract’s trades the profile counts.',
  'volume_profile.side': 'Draw each profile from the start of its period, or against its end.',
  'volume_profile.priorVa': 'Carry the last period’s busiest price and value area across the current one.',
  'volume_profile.show':
    'What each row shows: total volume, buyers and sellers side by side, the difference between them, or volume with the difference beside it.',
  'volume_profile.hours':
    'Count the whole session, regular hours only, or regular and overnight hours as two profiles.',
  'volume_profile.valueArea': 'The share of the volume the value area holds around the busiest price.',
  'volume_profile.extendLines': 'Carry the busiest price and the value area lines to the right of the chart.',
  'volume_profile.nakedPocs': 'Keep showing past busiest prices that price has not traded back to.',
  'volume_profile.developingPoc': 'Show how the busiest price moved as the session went on.',
  'volume_profile.developingVa': 'Show how the value area moved as the session went on.',
  'volume_profile.nodes': 'Mark prices that traded a lot or very little compared with their neighbours.',
  'market_profile.period': 'Which bars each profile covers: a session, a day, a week or a month.',
  'market_profile.length': 'How many sessions, days, weeks or months to draw, each on its own.',
  'market_profile.tpo': 'How long each letter lasts. Thirty minutes is the classic.',
  'market_profile.style':
    'Draw each period as letters or as plain blocks. Where letters are too small to read, they draw as blocks.',
  'market_profile.hours': 'Count the whole session or regular hours only.',
  'market_profile.contract': 'Which contract’s trades the profile counts.',
  'market_profile.valueArea': 'The share of the letters the value area holds around the most visited price.',
  'market_profile.ib': 'Mark the first hour from the regular open with a bar beside the letters.',
  'footprint.mode':
    'What each price shows: sellers and buyers side by side, their difference, the total, how many trades printed there, or sellers and buyers as bars.',
  'footprint.tint': 'Shade each price by how much traded there, by the difference between sides, or not at all.',
  'footprint.dimBelow': 'Fade the prices that traded less than this share of the busiest price in their bar.',
  'footprint.maxLevel': 'Outline the price in each bar with the most volume, trades, selling or buying.',
  'footprint.ratio': 'How many times bigger one side must be than the other diagonally to count as lopsided.',
  'footprint.minVolume': 'Ignore lopsided prices where fewer contracts than this traded.',
  'footprint.minDifference': 'Ignore lopsided prices where the two sides differ by fewer contracts than this.',
  'footprint.includeZero': 'Count a price where one side traded nothing as lopsided.',
  'footprint.stackRows': 'How many lopsided prices in a row make a stack worth marking.',
  'footprint.extendZones': 'Carry stacks to the right until price trades back through them.',
  'footprint.poc': 'Outline the busiest price in each bar.',
  'footprint.deltaPoc': 'Outline the price in each bar where one side won by the most.',
  'footprint.valueArea': 'Mark the range in each bar where most of its volume traded.',
  'footprint.unfinished': 'Mark a bar’s high or low where both sides still traded, a sign price may come back.',
  'stacked_imbalance.ratio': 'How many times bigger one side must be than the other diagonally to count as lopsided.',
  'stacked_imbalance.stackRows': 'How many lopsided prices in a row make a zone.',
  'stacked_imbalance.minVolume': 'Ignore lopsided prices where fewer contracts than this traded.',
  'stacked_imbalance.minDifference': 'Ignore lopsided prices where the two sides differ by fewer contracts than this.',
  'stacked_imbalance.includeZero': 'Count a price where one side traded nothing as lopsided.',
  'stacked_imbalance.rowTicks':
    'How many ticks each row covers when looking for stacks. Auto uses the contract’s footprint rows.',
  'stacked_imbalance.tested':
    'Keep zones price came back to, ending at the bar that reached them. Off shows only the zones still waiting.',
  'footprint.stats': 'Show a table under the bars with each bar’s volume and the difference between sides.',
  'big_trades.size':
    'How the smallest trade to show is picked. Auto follows what Tessera counts as big for the day; Fixed uses your own sizes.',
  'big_trades.tier': 'Which of Auto’s three sizes to show. Low shows the most trades and High only the very biggest.',
  'big_trades.minSize': 'With Fixed, the smallest trade to show.',
  'big_trades.maxSize': 'With Fixed, the largest trade to show. None shows them all.',
  'big_trades.showSize': 'Write each trade’s size inside its bubble when there is room.',
  'big_trades.price': 'Place each bubble at the trade’s average price, its first fill or its last fill.',
  'big_trades.joinOrders': 'Count the fills of one order as one trade.',
  'big_trades.reachLimit': 'End a trade that sweeps through prices once it runs two ticks past where it started.',
  'big_trades.zones':
    'Draw a band one tick either side of each big trade’s price, forward from the next bar until a bar trades through it.',
  'big_trades.zoneBars': 'How many bars a zone reaches forward, unless price trades back through it first.',
  'big_trades.zoneBiggest': 'Only the biggest trade in each bar gets a zone.',
  'big_trades.zoneBody': 'Which trades that sit in the bar’s body get a zone: with the bar, against it, all or none.',
  'big_trades.zoneWick': 'Which trades that sit in the bar’s wick get a zone: with the bar, against it, all or none.',
  'bollinger.mult': 'How far the bands sit from the average, in standard deviations.',
  'macd.fast': 'How many bars the fast average covers.',
  'macd.slow': 'How many bars the slow average covers.',
  'macd.signal': 'How many bars the signal line averages the gap over.',
  'stochastic.length': 'How many bars the high-low range covers.',
  'stochastic.smoothK': 'How many bars smooth the main line.',
  'stochastic.smoothD': 'How many bars the slower confirming line averages.',
  'delta.mode': 'Add the difference up through the session, or show each bar on its own.',
  'delta.style': 'Draw the running total as candles, a line, or bars up and down from zero.',
  'delta.reset': 'Start the running total again each session, or once from the start of the chart.',
  'delta.barStats': 'Show each bar’s volume and difference under the pane.',
  'delta.highlight': 'Keep the bars where one side won by at least this share of the volume bright, and fade the rest.',
  'delta.divergence':
    'Mark bars whose price closed the other way from their difference: up on selling, down on buying.',
  'opening_range.minutes': 'How many minutes from the open make the opening range.',
  'opening_range.ib': 'How many minutes from the open make the initial balance. An hour is the classic one.',
  'opening_range.open':
    'Time both from the regular open, or from the start of the whole session. Markets without a regular open use the session start.',
  'opening_range.extensions':
    'Which range the lines beyond are measured from: the initial balance or the opening range.',
  'effort.minDeltaPercent': 'The smallest share of the bar’s volume one side must win by for the bar to count.',
  'effort.maxDeltaPercent': 'The largest share one side may win by. Bars above it are too one-sided to count.',
  'effort.maxDeltaPerTick':
    'The most contracts of difference allowed per tick the bar travelled. Lower means tighter absorption.',
  'effort.maxBarSeconds': 'A bar slower than this does not count. Keep it suited to your chart’s bar speed.',
  'effort.minBars': 'How many bars in a row must qualify before a band is drawn.',
  'effort.fullRangeBars': 'How many bars keep the band at the streak’s full range before it narrows.',
  'effort.keepPercent': 'The share of the streak’s range the narrow band keeps, centred on its middle.',
  'effort.extendBars': 'How many bars the band reaches forward unless price comes back into it first.',
  'effort.tickSize': 'The instrument’s tick, used to measure how far the bar travelled. 0.25 for NQ.',
  'effort.opacity': 'How strongly the band is filled.',
  'effort.buyColor': 'The band colour when buyers absorbed.',
  'effort.sellColor': 'The band colour when sellers absorbed.',
};

export function studySummary(kind: string): string | null {
  return SUMMARIES[kind] ?? null;
}

export function inputHelp(kind: string, key: string): string | null {
  return INPUT_HELP[`${kind}.${key}`] ?? SHARED_HELP[key] ?? null;
}
