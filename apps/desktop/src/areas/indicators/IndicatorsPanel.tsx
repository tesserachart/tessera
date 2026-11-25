import { INDICATOR_SPECS, type Timeframe } from '@tessera/protocol';
import { Button, Icon, Loaded, Menu, MenuContent, MenuTrigger, Tooltip, cx, useLoadPending } from '@tessera/ui';
import { useEffect, useMemo } from 'react';
import { useToolValue } from '../../app/tools.ts';
import { ChartSetupItems, type ToolChart } from '../../chart/ChartTools.tsx';
import { displaySymbol } from '../../market/instruments.ts';
import { useCatalogLoaded, useCustomIndicators } from '../../indicators/custom.ts';
import { useLayouts } from '../../state/layouts.ts';
import { useActiveChart } from '../../state/workspace.ts';
import { BuiltinDetail, BuiltinView } from './BuiltinDetail.tsx';
import { Catalog } from './Catalog.tsx';
import { CustomEditor, EditorSample } from './CustomEditor.tsx';
import { useEditorLayout } from './layout.ts';
import { PreviewFrame } from './PreviewFrame.tsx';
import { builtinSpec, countOnChart, firstSelection, keyOf, select, usePage, pageStore } from './model.ts';
import { read } from '../../app/store.ts';
import './indicators.css';

const FALLBACK: { instrument: string; tf: Timeframe } = { instrument: 'NQ', tf: '5m' };

function TargetChart() {
  const active = useActiveChart();
  const layoutId = active?.layoutId ?? null;
  const tileId = active?.tileId ?? null;
  const instrument = active?.instrument ?? null;
  const tf = active?.tf ?? null;
  const chart = useMemo<ToolChart | null>(
    () => (layoutId && tileId && instrument && tf ? { layoutId, tileId, instrument, tf, printBars: null } : null),
    [layoutId, tileId, instrument, tf],
  );
  if (!chart) return <span className="ia-target text-t3">Open a chart to add indicators</span>;
  return (
    <Menu>
      <Tooltip content="What this chart shows">
        <MenuTrigger asChild>
          <button
            type="button"
            className="ctl-word ia-target"
            aria-label={`On ${displaySymbol(chart.instrument)} ${chart.tf}`}
          >
            <span className="text-t3">On</span>
            <b>{displaySymbol(chart.instrument)}</b>
            {chart.tf}
            <Icon name="chevron-down" className="chev" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="start" style={{ width: 260 }}>
        <ChartSetupItems chart={chart} />
      </MenuContent>
    </Menu>
  );
}

export function IndicatorsPanel() {
  return (
    <section className="ia-page" aria-label="Indicators">
      <div className="ia-bar" role="toolbar" aria-label="Indicators">
        <TargetChart />
        <span className="ia-page-fill" />
        <Button size="s" variant="quiet" onClick={() => select({ kind: 'new' })}>
          New indicator
        </Button>
      </div>
      <Loaded label="Loading indicators" sample={<IndicatorsSample />}>
        <IndicatorsBody />
      </Loaded>
    </section>
  );
}

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

function IndicatorsSample() {
  const chosen = usePage((s) => s.selection);
  const selection = chosen ?? firstSelection([]);
  const spec = selection.kind === 'builtin' ? builtinSpec(INDICATOR_SPECS, selection.key) : null;
  return (
    <div className="ia-page-body">
      <Catalog builtins={INDICATOR_SPECS} custom={[]} selection={selection} drafting={false} onChart={NO_COUNTS} />
      <main className="ia-detail">
        {spec ? (
          <BuiltinView spec={spec} chart={null} onChart={0} preview={FALLBACK} drawing={<PreviewFrame />} />
        ) : (
          <EditorSample title={selection.kind === 'new' ? 'New indicator' : 'Custom indicator'} preview={FALLBACK} />
        )}
      </main>
    </div>
  );
}

function IndicatorsBody() {
  const custom = useCustomIndicators();
  const catalogLoaded = useCatalogLoaded();
  useLoadPending(!catalogLoaded);
  const list = useToolValue('indicators.list', {}, { keepFor: 60_000 });
  const chosen = usePage((s) => s.selection);
  const selection = chosen ?? (catalogLoaded ? firstSelection(custom) : null);
  const drafting = usePage((s) => s.drafts.new !== undefined || s.selection?.kind === 'new');
  const chart = useActiveChart();
  const layers = useLayouts((s) => (chart ? s.layouts[chart.layoutId]?.charts[chart.tileId]?.layers : undefined));
  const onChart = useMemo(() => countOnChart(layers ?? []), [layers]);
  const preview = chart ? { instrument: chart.instrument, tf: chart.tf } : FALLBACK;
  const codeOnly = useEditorLayout((s) => s.codeOnly);
  const sandbox = list?.sandbox ?? null;
  const unavailable = sandbox && !sandbox.available ? (sandbox.reason ?? 'Custom indicators cannot run here.') : null;

  useEffect(() => {
    if (read(pageStore).selection || !catalogLoaded) return;
    select(firstSelection(custom));
  }, [catalogLoaded, custom]);
  useEffect(() => {
    if (selection?.kind === 'custom' && catalogLoaded && !custom.some((c) => c.id === selection.id)) select(null);
  }, [selection, custom, catalogLoaded]);

  const key = keyOf(selection);
  let detail = null;
  if (selection?.kind === 'builtin') {
    const spec = builtinSpec(INDICATOR_SPECS, selection.key);
    if (spec)
      detail = (
        <BuiltinDetail
          key={spec.kind}
          spec={spec}
          chart={chart}
          onChart={onChart.get(spec.kind) ?? 0}
          settingsLayer={layers?.find((l) => l.kind === spec.kind)?.id ?? null}
          preview={preview}
        />
      );
  } else if (key) {
    detail = (
      <CustomEditor
        key={key}
        id={key}
        indicator={custom.find((c) => c.id === key) ?? null}
        chart={chart}
        preview={preview}
        unavailable={unavailable}
      />
    );
  }

  return (
    <div className={cx('ia-page-body', codeOnly && key && 'is-code-only')}>
      <Catalog builtins={INDICATOR_SPECS} custom={custom} selection={selection} drafting={drafting} onChart={onChart} />
      <main className="ia-detail">{detail}</main>
    </div>
  );
}
