import type { IndicatorInput, IndicatorSpec, Timeframe } from '@tessera/protocol';
import { Button, Icon, Tooltip } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { colorOf, drawnAsIndicator } from '../../chart/indicators.ts';
import { addToChart } from '../../chart/settings/actions.ts';
import { StudySettingsDialog } from '../../chart/settings/StudySettingsDialog.tsx';
import { groupLabel } from '../../chart/settings/catalog.ts';
import { zoneLabel } from '../../state/timeZone.ts';
import type { ActiveChart } from '../../state/workspace.ts';
import { chartWords } from './model.ts';
import { PreviewChart } from './PreviewChart.tsx';
import { inputHelp, studySummary } from './summaries.ts';

function inputDefault(i: IndicatorInput): string {
  if (i.type === 'bool') return i.default === true ? 'On' : 'Off';
  if (i.type === 'enum') return i.options?.find((o) => o.value === i.default)?.label ?? String(i.default);
  if (i.type === 'timezone') return zoneLabel(String(i.default));
  return String(i.default);
}

function inputRange(i: IndicatorInput): string {
  if (i.type === 'enum') return (i.options ?? []).map((o) => o.label).join(', ');
  if (i.type === 'source') return 'a bar price';
  if (i.type === 'session') return 'hours, HH:MM-HH:MM';
  if (i.type === 'timezone') return 'a time zone';
  if (i.min !== null && i.max !== null) return `${String(i.min)} – ${String(i.max)}`;
  return '';
}

function InputLabel({ label, help }: { label: string; help: string | null }) {
  if (!help) return <>{label}</>;
  return (
    <Tooltip content={help}>
      <span className="ia-bi-help" tabIndex={0} aria-description={help}>
        {label}
      </span>
    </Tooltip>
  );
}

function onChartStatus(where: string, count: number, added: boolean): string {
  if (added) return `Added to ${where}`;
  return count > 1 ? `${String(count)} on ${where}` : `On ${where}`;
}

interface BuiltinProps {
  spec: IndicatorSpec;
  chart: ActiveChart | null;
  onChart: number;
  settingsLayer?: string | null;
  preview: { instrument: string; tf: Timeframe };
}

export function BuiltinDetail(props: BuiltinProps) {
  return (
    <BuiltinView
      {...props}
      drawing={<PreviewChart instrument={props.preview.instrument} tf={props.preview.tf} builtin={props.spec} />}
    />
  );
}

export function BuiltinView({
  spec,
  chart,
  onChart,
  settingsLayer = null,
  preview,
  drawing,
}: BuiltinProps & { drawing: ReactNode }) {
  const [added, setAdded] = useState(false);
  const [editing, setEditing] = useState(false);
  const plots = spec.plots.filter((p) => p.kind !== 'hline');
  const guides = spec.plots.filter((p) => p.kind === 'hline');
  const shown = drawnAsIndicator(spec);
  return (
    <div className={shown ? 'ia-bi-split' : 'ia-bi-split is-text'}>
      <div className="ia-bi">
        <header className="ia-bi-head">
          <div className="ia-bi-name">
            <h2>{spec.title}</h2>
            <span className="meta">
              {spec.short} · {groupLabel(spec.group)} · {spec.placement === 'pane' ? 'its own pane' : 'on the price'}
            </span>
          </div>
          <div className="ia-bi-add">
            <span className="ia-bi-on" role="status">
              {chart && (added || onChart > 0) ? (
                <>
                  <Icon name="done" />
                  {onChartStatus(chartWords(chart), onChart, added)}
                </>
              ) : null}
            </span>
            {chart && settingsLayer ? (
              <>
                <Button size="s" variant="quiet" onClick={() => setEditing(true)}>
                  Settings…
                </Button>
                <StudySettingsDialog
                  chart={chart}
                  layerId={settingsLayer}
                  spec={spec}
                  open={editing}
                  onOpenChange={setEditing}
                />
              </>
            ) : null}
            <Tooltip content={chart ? `Add to ${chartWords(chart)}` : 'Open a chart first'}>
              <span>
                <Button
                  variant={onChart > 0 ? 'secondary' : 'primary'}
                  size="s"
                  disabled={!chart}
                  onClick={() => {
                    if (!chart) return;
                    addToChart({ layoutId: chart.layoutId, tileId: chart.tileId }, spec.kind);
                    setAdded(true);
                  }}
                >
                  {onChart > 0 ? 'Add another' : 'Add to chart'}
                </Button>
              </span>
            </Tooltip>
          </div>
        </header>
        <p className="ia-bi-desc">{studySummary(spec.kind)}</p>
        {spec.inputs.length > 0 ? (
          <section className="ia-bi-sec" aria-label="Inputs">
            <h3>Inputs</h3>
            <table className="ia-bi-table">
              <tbody>
                {spec.inputs.map((i) => (
                  <tr key={i.key}>
                    <th scope="row">
                      <InputLabel label={i.label} help={inputHelp(spec.kind, i.key)} />
                    </th>
                    <td className="fig">{inputDefault(i)}</td>
                    <td className="range">{inputRange(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        <section className="ia-bi-sec" aria-label="Draws">
          <h3>Draws</h3>
          <ul className="ia-bi-plots">
            {plots.map((p) => (
              <li key={p.key}>
                <span className="sw" style={{ background: colorOf(p.default.color) }} />
                {p.label}
                <span className="kind">{p.kind === 'histogram' ? 'bars' : 'line'}</span>
              </li>
            ))}
            {guides.length > 0 ? (
              <li className="guides">
                <span className="sw dash" />
                {guides.map((g) => g.label).join(', ')}
                <span className="kind">guides</span>
              </li>
            ) : null}
          </ul>
        </section>
      </div>
      {shown ? (
        <div className="ia-bi-preview">
          <div className="ia-ed-preview-head">
            <span className="where">{chartWords(preview)}</span>
          </div>
          {drawing}
        </div>
      ) : null}
    </div>
  );
}
