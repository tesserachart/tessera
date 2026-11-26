import { formatMoney } from '@tessera/ui';
import {
  timeframeMs,
  type BacktestTrade,
  type JournalTrade,
  type ReplayTrade,
  type SessionRunnerSetting,
  type Setup,
  type Study,
  type TradingSessionStatus,
} from '@tessera/protocol';
import { linkTrade, tradeRange } from '../../chart/linkedTrade.ts';
import { requestViewport } from '../../chart/viewportRequests.ts';
import { read } from '../../app/store.ts';
import { layoutsStore } from '../../state/layouts.ts';
import { activeChartTarget, setChartTimeframe, showOnChart } from '../../workspace/controller.ts';
import { SESSION_RUNNER, runnerValue, sessionRunning, standingWords } from '../../analyst/tradingSessions.ts';
import { refreshTools, runTool } from '../../app/tools.ts';
import { saveSetting } from '../../state/runtimeSettings.ts';
import { pct, plural, tradeClosed } from '../journal/model/format.ts';
import { setJournal } from '../journal/store.ts';
import { showArea } from '../store.ts';
import { selectStudy, showRunTrade } from './selection.ts';

const PAGE = 2000;
const STUDY_TOOLS = ['research.list_studies', 'research.get_study'];

export function tradable(s: Pick<Study, 'state'>): boolean {
  return s.state !== 'draft';
}

export function tradedBySessions(setting: SessionRunnerSetting, study: Pick<Study, 'id'>): boolean {
  return setting.studyId === study.id;
}

export function replayTrades(trades: readonly JournalTrade[]): ReplayTrade[] {
  return trades.flatMap((t) =>
    tradeClosed(t)
      ? [{ instrument: t.instrument, side: t.side, qty: t.qty, openedAt: t.openedAt, closedAt: t.closedAt }]
      : [],
  );
}

export function setupOfStudy(setups: readonly Setup[], study: Pick<Study, 'id'>): Setup | null {
  return setups.find((s) => s.studyId === study.id) ?? null;
}

export function openStudy(id: string): void {
  selectStudy(id);
  showArea('research');
}

export async function showTradeOnChart(
  study: Pick<Study, 'name' | 'data'>,
  runId: string,
  n: number,
  trade: BacktestTrade,
): Promise<void> {
  showArea('desk');
  const target = activeChartTarget();
  if (!target) return;
  const { instrument, tf } = study.data;
  const chart = read(layoutsStore).layouts[target.layoutId]?.charts[target.tileId];
  if (chart?.instrument !== instrument) await showOnChart(instrument, target);
  const step = timeframeMs(tf);
  if (!chart || chart.printBars || timeframeMs(chart.timeframe) > step) await setChartTimeframe(tf, target);
  linkTrade({
    label: `Trade ${String(n)} · ${study.name}`,
    instrument,
    trade,
    target,
    back: () => {
      showRunTrade(runId, n);
      showArea('research');
    },
  });
  requestViewport(target, tradeRange(trade, step * 1e6));
}

export function openSetupTrades(setup: Pick<Setup, 'id'>): void {
  setJournal({ section: 'trades', trade: null, filter: { setups: [setup.id] } });
  showArea('journal');
}

async function closedTradesOf(setup: Pick<Setup, 'id'>): Promise<JournalTrade[]> {
  const out: JournalTrade[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await runTool('journal.list_trades', {
      filter: { setups: [setup.id], status: 'closed' },
      sort: 'opened',
      ascending: true,
      limit: PAGE,
      offset,
    });
    out.push(...page.trades);
    if (page.trades.length < PAGE) return out;
  }
}

export async function studySetup(setup: Setup): Promise<string> {
  const { studies } = await runTool('research.list_studies', {});
  if (setup.studyId && studies.some((s) => s.id === setup.studyId)) return setup.studyId;
  const study = await runTool(
    'research.study_trades',
    { name: `${setup.name} · journaled trades`, hypothesis: null, trades: replayTrades(await closedTradesOf(setup)) },
    { refresh: STUDY_TOOLS },
  );
  await runTool('journal.save_setup', { id: setup.id, studyId: study.id }, { refresh: ['journal.get_catalog'] });
  return study.id;
}

export function tradedWords(setup: Pick<Setup, 'stats'>): string | null {
  const s = setup.stats;
  if (!s.n) return null;
  return `${plural(s.n, 'trade')} in the journal · net ${formatMoney(s.net, { signed: true })} · ${pct(s.winRate, 0)} won`;
}

export async function tradeInSessions(setting: SessionRunnerSetting, studyId: string): Promise<string | null> {
  const why = await saveSetting(SESSION_RUNNER, runnerValue(setting, { studyId }));
  void refreshTools('agent.trading_session');
  return why;
}

export function sessionsWords(status: TradingSessionStatus | undefined, now: number): string {
  if (status && !status.setting.enabled) return 'Trading sessions are off';
  return standingWords(status, now);
}

export interface StudyTradeView {
  action: string | null;
  standing: string;
}

export function studyTradeView(
  setting: SessionRunnerSetting,
  status: TradingSessionStatus | undefined,
  study: Pick<Study, 'id' | 'state'>,
  now: number,
): StudyTradeView {
  const on = tradedBySessions(setting, study);
  const running = sessionRunning(status, now) ? (status?.day ?? null) : null;
  const runsThis = running?.studyId === study.id;
  const action = on
    ? 'Stop the analyst trading it'
    : tradable(study)
      ? setting.studyId
        ? 'Have the analyst trade it instead'
        : 'Have the analyst trade it'
      : null;
  if (on && running && !runsThis)
    return {
      action,
      standing: running.studyId
        ? 'From the next session: the running one keeps its study'
        : 'From the next session: the running one trades without a study',
    };
  if (!on && runsThis) return { action, standing: 'The running session trades it until its close' };
  return { action, standing: on ? sessionsWords(status, now) : '' };
}
