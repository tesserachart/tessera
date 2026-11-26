import { timeframeWords, type Timeframe } from '@tessera/protocol';
import { TextInput, ToggleGroup } from '@tessera/ui';
import { useState, type KeyboardEvent } from 'react';
import { runTool } from '../../../app/tools.ts';
import { displaySymbol, intervalText, tabRowChoices, withPresets } from '../../../market/instruments.ts';
import { CHART_TYPES, type ChartType } from '../../../state/layouts.ts';
import { saveSetting, useSetting } from '../../../state/runtimeSettings.ts';
import { DEFAULT_INSTRUMENT, DEFAULT_TIMEFRAME } from '../../../frame/workspaces.ts';
import { setDefaultChartType, toggleFavouriteInterval, useUi } from '../../../state/ui.ts';
import { Row, Section, SettingSelect } from '../parts.tsx';

const TYPE_WORD: Record<ChartType, string> = { candles: 'Candles', bars: 'Bars', line: 'Line' };

function SymbolField({
  value,
  onSave,
  onClear,
}: {
  value: string | null;
  onSave: (v: string) => Promise<string | null>;
  onClear: () => Promise<string | null>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const commit = async () => {
    if (text === null) return;
    const typed = text.trim();
    if (!typed) {
      const problem = value === null ? null : await onClear();
      setErr(problem);
      if (!problem) setText(null);
      return;
    }
    if (typed.toUpperCase() === value?.toUpperCase()) {
      setText(null);
      setErr(null);
      return;
    }
    const problem = await onSave(typed);
    setErr(problem);
    if (!problem) setText(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setText(null);
      setErr(null);
    }
  };
  return (
    <span className="st-num">
      <TextInput
        className="st-symbol"
        aria-label="Symbol of new charts"
        value={text ?? (value ? displaySymbol(value) : '')}
        placeholder="Last charted"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
      {err ? (
        <span className="st-err" role="alert">
          {err}
        </span>
      ) : null}
    </span>
  );
}

export function NewChartsSection() {
  const tf = useSetting(DEFAULT_TIMEFRAME);
  const value = useSetting(DEFAULT_INSTRUMENT);
  const favourites = useUi((s) => s.favouriteIntervals);
  const type = useUi((s) => s.defaultChartType);
  const saveSymbol = async (typed: string): Promise<string | null> => {
    const found = await runTool('market.search_instruments', { query: typed, limit: 8 }).catch(() => null);
    const q = typed.toUpperCase().replace(/\s+/g, '');
    const hit = found?.results.find(
      (r) => r.symbol.toUpperCase() === q || r.root?.toUpperCase() === q || displaySymbol(r.id).replace(' ', '') === q,
    );
    if (!hit) return `No symbol ${typed}`;
    return saveSetting(DEFAULT_INSTRUMENT, hit.root?.toUpperCase() === q ? hit.root : hit.symbol);
  };
  return (
    <Section id="chart.newCharts">
      <Row id="chart.instrument">
        <SymbolField value={value} onSave={saveSymbol} onClear={() => saveSetting(DEFAULT_INSTRUMENT, null)} />
      </Row>
      <Row id="chart.timeframe">
        {tf !== null ? (
          <SettingSelect<Timeframe>
            label="Interval of new charts"
            value={tf}
            onValueChange={(v) => void saveSetting(DEFAULT_TIMEFRAME, v)}
            options={withPresets([tf]).map((t) => ({ value: t, label: timeframeWords(t) }))}
          />
        ) : null}
      </Row>
      <Row id="chart.chartType">
        <SettingSelect<ChartType>
          label="Chart type of new charts"
          value={type}
          onValueChange={(v) => setDefaultChartType(v)}
          options={CHART_TYPES.map((t) => ({ value: t, label: TYPE_WORD[t] }))}
        />
      </Row>
      <Row id="chart.intervals">
        <ToggleGroup
          label="Intervals in the toolbar"
          options={tabRowChoices(favourites, null).map((i) => ({ value: intervalText(i), label: intervalText(i) }))}
          value={favourites}
          onToggle={(t) => toggleFavouriteInterval(t)}
        />
      </Row>
    </Section>
  );
}
