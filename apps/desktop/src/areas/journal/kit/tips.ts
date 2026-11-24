export interface MetricTip {
  what: string;
  why: string;
  benchmark: string;
}

export const METRIC_TIPS = {
  totalPnl: {
    what: 'Your total net profit or loss across closed trades, after fees.',
    why: "The bottom line: whether you're making or losing money overall.",
    benchmark: 'Positive is profitable. Compare it to your starting capital for a return.',
  },
  winRate: {
    what: 'Winners over decided trades (wins + losses); breakevens are left out.',
    why: "How often you're right. Only meaningful beside the payoff ratio.",
    benchmark: '40–60% is typical for day traders; lower is fine with a high payoff ratio.',
  },
  profitFactor: {
    what: 'Gross profit divided by gross loss.',
    why: 'How much you make for every dollar you lose.',
    benchmark: 'Above 1 is profitable, above 1.5 good, above 2 excellent.',
  },
  avgTrade: {
    what: 'Net P&L over the number of closed trades.',
    why: 'Your edge per trade, the base of any projection.',
    benchmark: 'Above zero means the trades so far earned on average.',
  },
  expectancy: {
    what: 'Win rate × average win − loss rate × average loss.',
    why: 'What a trade earned on average, measured, not promised.',
    benchmark: 'Above zero is profitable. Small samples move it a lot.',
  },
  payoffRatio: {
    what: 'Average winning trade divided by average losing trade.',
    why: 'Reward against risk; it can make up for a lower win rate.',
    benchmark: 'Above 1 means wins are larger than losses, above 2 is excellent.',
  },
  sharpeRatio: {
    what: 'Average trade P&L over the standard deviation of trade P&L (per trade, not annualised).',
    why: 'Higher means steadier returns for the same average.',
    benchmark: 'Above 0.5 per trade is strong; below 0 means losing money.',
  },
  currentStreak: {
    what: 'Your current run of consecutive wins or losses.',
    why: 'Knowing the run you are in helps keep size and temper steady.',
    benchmark: "Runs are normal. Don't size up after wins or chase after losses.",
  },
  maxDrawdown: {
    what: 'The largest fall of the equity curve from a peak.',
    why: 'Your worst stretch, the base of sizing and risk.',
    benchmark: 'Compare it to your account size and any drawdown limit you trade under.',
  },
  currentDrawdown: {
    what: 'How far the equity curve is below its peak now.',
    why: 'Whether you are making new highs or still recovering.',
    benchmark: 'Zero means you are at a new high.',
  },
  sortinoRatio: {
    what: 'Average trade P&L over the deviation of losing trades only (per trade).',
    why: "Like Sharpe, but it doesn't count large wins as risk.",
    benchmark: 'Higher is better; above 1 per trade is strong.',
  },
  calmarRatio: {
    what: 'Return over the period divided by the maximum drawdown.',
    why: 'Return per unit of drawdown: rewards steady growth.',
    benchmark: 'Above 1 is good, above 2 excellent, above 3 exceptional.',
  },
  recoveryFactor: {
    what: 'Net profit divided by the maximum drawdown.',
    why: 'How well the account climbs out of its worst fall.',
    benchmark: 'Above 3 is good, above 5 excellent; below 1 means the drawdown is not yet earned back.',
  },
  ulcerIndex: {
    what: 'The root mean square of the drawdowns, trade by trade.',
    why: 'Counts both how deep and how long drawdowns last: the pain of them.',
    benchmark: 'Lower is calmer. Compare it across periods, not across traders.',
  },
  drawdowns: {
    what: 'How many times the curve fell from a peak and came back.',
    why: 'Many shallow drawdowns read differently from one deep one.',
    benchmark: 'Read it beside the deepest drawdowns table.',
  },
  timeInDrawdown: {
    what: 'The share of trades taken while below a previous peak.',
    why: 'How much of the time the account was recovering.',
    benchmark: 'Lower is better; a long stretch below the peak weighs on decisions.',
  },
  kelly: {
    what: 'Kelly fraction: win rate − loss rate ÷ payoff ratio.',
    why: 'The share of capital that would maximise growth if these stats held.',
    benchmark: 'Most traders use half or a quarter of it. Above 30% wants more data.',
  },
} satisfies Record<string, MetricTip>;
