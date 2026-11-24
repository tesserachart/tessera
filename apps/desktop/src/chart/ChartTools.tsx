import { timeframeWords, type ChartLayer, type PrintBars, type Timeframe } from '@tessera/protocol';
import {
  Icon,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Segmented,
  Tooltip,
  cx,
  useCloseMenu,
} from '@tessera/ui';
import { Fragment, forwardRef, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { afterOpenerTakesFocus } from './focus.ts';
import { useInSight } from '../app/inSight.ts';
import { CHART_TYPE_VIEWS, kindShown, toggleChartView } from './orderflowCommands.ts';
import { requirementWords, useUnavailableKinds } from './settings/availability.ts';
import { IndicatorMenuItems } from './settings/IndicatorMenu.tsx';
import { groupLevels, isLevelShown, toggleLevel } from './levels.ts';
import { openHome } from '../shell/tradeActions.ts';
import { useChartLevels } from './useChartLevels.ts';
import {
  intervalOf,
  intervalsOf,
  intervalText,
  parseInterval,
  PRINT_BAR_KINDS,
  printBarChoices,
  printBarsGroup,
  printBarsKey,
  printBarsShort,
  printBarsWords,
  tabRowChoices,
  withPresets,
  type Interval,
} from '../market/instruments.ts';
import { SymbolPopover } from '../markets/SymbolPopover.tsx';
import {
  SERIES_TYPES,
  CHART_TYPE_WORD,
  chartTypeOf,
  useChartState,
  useStageView,
  type SeriesType,
} from '../state/layouts.ts';
import {
  useUi,
  closeSymbolSearch,
  saveFavouriteInterval,
  toggleFavouriteInterval,
  type SymbolSearchAt,
} from '../state/ui.ts';
import { activateChart, setChartTimeframe, setChartType, updateChart } from '../workspace/controller.ts';
import { chooseFromLibrary } from '../workspace/dock/library.ts';
import type { ChartRef } from './settings/store.ts';

export interface ToolChart extends ChartRef {
  instrument: string;
  tf: Timeframe;
  printBars: PrintBars | null;
}

export function SymbolSearch({ active, at = 'chart' }: { active: boolean; at?: SymbolSearchAt }) {
  const inSight = useInSight();
  const open = useUi((s) => s.symbolSearch !== null && s.symbolSearchAt === at) && active && inSight;
  return (
    <Popover open={open} onOpenChange={(o) => (o ? undefined : closeSymbolSearch())}>
      <PopoverAnchor asChild>
        <span className="sym-anchor" aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent className="sym-search-pop" align="start" sideOffset={0} aria-label="Symbol search">
        {open ? <SymbolPopover /> : null}
      </PopoverContent>
    </Popover>
  );
}

const WordButton = forwardRef<HTMLButtonElement, { children: ReactNode; label?: string; className?: string }>(
  function WordButton({ children, label, className, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={cx('ctl-word', className)} aria-label={label} {...rest}>
        {children}
        <Icon name="chevron-down" className="chev" />
      </button>
    );
  },
);

function intervalWords(i: Interval): string {
  return i.printBars ? printBarsWords(i.printBars) : timeframeWords(i.tf);
}

function IntervalField({ onShow, onSave }: { onShow: (i: Interval) => void; onSave: (i: Interval) => void }) {
  const close = useCloseMenu();
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => afterOpenerTakesFocus(() => ref.current?.focus()), []);
  const typed = text.trim() === '' ? null : parseInterval(text);
  const wrong = text.trim() !== '' && typed === null;
  const act = (then: (i: Interval) => void) => {
    if (!typed) return;
    then(typed);
    close();
  };
  return (
    <div className="tpl-form" role="group" aria-label="Any interval">
      <div className="tpl-form-row">
        <div className={cx('t-input', 'tpl-name', wrong && 'is-error')}>
          <input
            ref={ref}
            aria-label="Interval"
            placeholder="15s, 2D, 500T…"
            value={text}
            maxLength={16}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') return;
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                act(e.metaKey || e.ctrlKey ? onSave : onShow);
              }
            }}
          />
        </div>
        <Tooltip content={typed ? `Show ${intervalText(typed)}` : 'Type an interval first'}>
          <span>
            <button type="button" className="tpl-verb" disabled={!typed} onClick={() => act(onShow)}>
              Show
            </button>
          </span>
        </Tooltip>
        <Tooltip content={typed ? `Show ${intervalText(typed)} and keep it in the tab row` : 'Type an interval first'}>
          <span>
            <button type="button" className="tpl-verb" disabled={!typed} onClick={() => act(onSave)}>
              Save
            </button>
          </span>
        </Tooltip>
      </div>
      {typed ? <div className="tpl-hint">{intervalWords(typed)}</div> : null}
      {wrong ? (
        <div className="tpl-err" role="alert">
          Not an interval
        </div>
      ) : null}
    </div>
  );
}

function IntervalMenuItems({ chart }: { chart: ToolChart }) {
  const favourites = useUi((s) => s.favouriteIntervals);
  const current = intervalOf(chart.tf, chart.printBars);
  const saved = intervalsOf(favourites);
  const timeframes = withPresets([chart.tf, ...saved.map((i) => i.tf)]);
  const choices = tabRowChoices(favourites, current);
  const savedTexts = saved.map(intervalText);
  const show = (i: Interval) => void setChartTimeframe(i.tf ?? chart.tf, chart, i.printBars);
  const keep = (i: Interval) => {
    saveFavouriteInterval(intervalText(i));
    show(i);
  };
  const pick = (v: string) => {
    const i = parseInterval(v);
    if (i) show(i);
  };
  return (
    <>
      <IntervalField onShow={show} onSave={keep} />
      <MenuSeparator />
      <MenuRadioGroup value={intervalText(current)} onValueChange={pick}>
        {timeframes.map((t) => (
          <MenuRadioItem key={t} value={t} hint={t}>
            {timeframeWords(t)}
          </MenuRadioItem>
        ))}
        {PRINT_BAR_KINDS.map((kind) => (
          <Fragment key={kind}>
            <MenuSeparator />
            <MenuLabel>{printBarsGroup(kind)}</MenuLabel>
            {printBarChoices(kind, [current, ...saved]).map((b) => (
              <MenuRadioItem key={printBarsKey(b)} value={printBarsShort(b)} hint={printBarsShort(b)}>
                {printBarsWords(b)}
              </MenuRadioItem>
            ))}
          </Fragment>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuLabel>In the tab row</MenuLabel>
      {choices.map((i) => {
        const text = intervalText(i);
        return (
          <MenuCheckboxItem
            key={text}
            checked={savedTexts.includes(text)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => toggleFavouriteInterval(text)}
          >
            {text}
          </MenuCheckboxItem>
        );
      })}
    </>
  );
}

export function IntervalTools({ chart }: { chart: ToolChart }) {
  const favourites = useUi((s) => s.favouriteIntervals);
  const current = intervalOf(chart.tf, chart.printBars);
  const shown = intervalsOf([...favourites, intervalText(current)]).map(intervalText);
  const label = intervalText(current);
  return (
    <>
      <span className="ctl-tf">
        <Segmented
          label="Timeframe"
          options={shown.map((t) => ({ value: t, label: t }))}
          value={label}
          onChange={(t) => {
            const i = parseInterval(t);
            if (i) void setChartTimeframe(i.tf ?? chart.tf, chart, i.printBars);
          }}
        />
        <Menu>
          <Tooltip content="All intervals">
            <MenuTrigger asChild>
              <button type="button" className="ctl-more" aria-label="All intervals">
                <Icon name="chevron-down" />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="start" style={{ width: 240 }}>
            <IntervalMenuItems chart={chart} />
          </MenuContent>
        </Menu>
      </span>
      <span className="ctl-tf-menu">
        <Menu>
          <Tooltip content="Interval">
            <MenuTrigger asChild>
              <WordButton label={`Interval ${label}`}>{label}</WordButton>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="start" style={{ width: 240 }}>
            <IntervalMenuItems chart={chart} />
          </MenuContent>
        </Menu>
      </span>
    </>
  );
}

export function ChartTypeItems({
  chart,
  type,
  layers,
  open,
}: {
  chart: ChartRef;
  type: SeriesType;
  layers: readonly ChartLayer[];
  open: boolean;
}) {
  const unavailable = useUnavailableKinds(chart, open);
  return (
    <>
      <MenuRadioGroup value={type} onValueChange={(v) => void setChartType(v as SeriesType, chart)}>
        {SERIES_TYPES.map((t) => (
          <MenuRadioItem key={t} value={t}>
            {CHART_TYPE_WORD[t]}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      {CHART_TYPE_VIEWS.map((v) => {
        const why = unavailable.get(v.kind);
        return (
          <MenuCheckboxItem
            key={v.kind}
            checked={kindShown(layers, v.kind)}
            disabled={why !== undefined}
            hint={why ? requirementWords(why.requires) : undefined}
            shortcut={v.shortcut}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => void toggleChartView(chart, v.kind)}
          >
            {v.name}
          </MenuCheckboxItem>
        );
      })}
    </>
  );
}

export function ChartTypeMenu({ chart }: { chart: ToolChart }) {
  const model = useChartState(chart.layoutId, chart.tileId);
  const type = chartTypeOf(
    useStageView(chart.layoutId),
    chart.tileId,
    useUi((s) => s.defaultChartType),
    model,
  );
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip content="Chart type">
        <MenuTrigger asChild>
          <WordButton label={`Chart type: ${CHART_TYPE_WORD[type]}`} className="ctl-type">
            {CHART_TYPE_WORD[type]}
          </WordButton>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="start" style={{ width: 220 }}>
        <ChartTypeItems chart={chart} type={type} layers={model?.layers ?? []} open={open} />
      </MenuContent>
    </Menu>
  );
}

export function FxButton({ chart }: { chart: ChartRef }) {
  return (
    <Tooltip content="Indicators">
      <button
        type="button"
        className="ctl-fx"
        aria-label="Indicators"
        onClick={() => {
          activateChart(chart.layoutId, chart.tileId);
          chooseFromLibrary('indicators', null);
        }}
      >
        ƒx
      </button>
    </Tooltip>
  );
}

export function ChartSetupItems({ chart }: { chart: ToolChart }) {
  const model = useChartState(chart.layoutId, chart.tileId);
  const levels = useChartLevels(chart.instrument);
  const layers = model?.layers ?? [];
  const edit = (fn: (ls: readonly ChartLayer[]) => ChartLayer[]) =>
    void updateChart(chart.layoutId, chart.tileId, (c) => ({ ...c, layers: fn(c.layers) }));
  const groups = groupLevels(levels, layers);
  return (
    <>
      <IndicatorMenuItems chart={chart} layers={layers} add={false} />
      {groups.map((g) => (
        <div key={g.label} role="group" aria-label={g.label}>
          <MenuSeparator />
          <MenuLabel>{g.label}</MenuLabel>
          {g.levels.map((l) => (
            <MenuCheckboxItem
              key={l.key}
              checked={isLevelShown(layers, l)}
              disabled={l.price === null}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => edit((ls) => toggleLevel(ls, l))}
            >
              {l.label}
            </MenuCheckboxItem>
          ))}
        </div>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={() => openHome('levels')}>Level settings…</MenuItem>
    </>
  );
}
