import type { ChartHours } from '@tessera/protocol';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, StatusDot, Tooltip } from '@tessera/ui';
import { useCallback, useSyncExternalStore } from 'react';
import { useClock } from '../app/clock.ts';
import { useMarketSessions } from '../markets/sessions.ts';
import { useChartState } from '../state/layouts.ts';
import { setChartHours } from '../workspace/controller.ts';
import type { ToolChart } from './ChartTools.tsx';
import { HOURS_SHORT, HOURS_WORDS, hasRegularHours, hoursOf, hoursSpan, tradingNow } from './hours.ts';

const CHOICES: readonly ChartHours[] = ['rth', 'eth'];

export function HoursPill({ chart }: { chart: ToolChart }) {
  const model = useChartState(chart.layoutId, chart.tileId);
  const clock = useClock();
  const sessions = useMarketSessions(chart.instrument, clock.now());
  const hours = hoursOf(model);
  const trading = useCallback(
    () => (sessions ? tradingNow(sessions, hours, clock.now()) : false),
    [sessions, hours, clock],
  );
  const live = useSyncExternalStore(clock.subscribe, trading);
  if (chart.printBars || !sessions || hasRegularHours(sessions) !== true) return null;
  const span = hoursSpan(sessions.hours, hours, clock.now());
  const tip = `${HOURS_WORDS[hours]}${span ? ` · ${span}` : ''}${live ? '' : ' · closed now'}`;
  return (
    <Menu>
      <Tooltip content={tip}>
        <MenuTrigger asChild>
          <button
            type="button"
            className="chart-hours"
            aria-label={`Chart hours: ${HOURS_WORDS[hours]}`}
            data-hours={hours}
          >
            <StatusDot state={live ? 'ok' : 'off'} />
            <span className="nm">{HOURS_SHORT[hours]}</span>
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" style={{ width: 240 }}>
        <MenuRadioGroup
          value={hours}
          onValueChange={(v) => void setChartHours(v as ChartHours, { layoutId: chart.layoutId, tileId: chart.tileId })}
        >
          {CHOICES.map((h) => (
            <MenuRadioItem key={h} value={h} hint={HOURS_SHORT[h]} detail={hoursSpan(sessions.hours, h, clock.now())}>
              {HOURS_WORDS[h]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
