import type { ChartTemplate, DrawingKind, DrawingTemplate, IndicatorPreset } from '@tessera/protocol';
import {
  Button,
  ConfirmButton,
  ICON_BUTTON,
  Icon,
  SettingsRow,
  Switch,
  TextInput,
  Tooltip,
  cx,
  useLoadPending,
} from '@tessera/ui';
import { Fragment, useState, type KeyboardEvent } from 'react';
import {
  DRAWING_TOOLS,
  TOOLS,
  defaultStyle,
  styleControls,
  toolOf,
  type NewDrawingLook,
} from '../../../chart/drawings/model.ts';
import { rememberStyle, setCollapsed, setMagnet, useDrawingUi } from '../../../chart/drawings/store.ts';
import {
  deleteDrawingTemplate,
  renameDrawingTemplate,
  setNewDrawingsLook,
} from '../../../chart/drawings/templateActions.ts';
import { useDrawingTemplates } from '../../../chart/drawings/templateStore.ts';
import { lookOfNew, lookOfTemplate, lookWords, renameProblem, sameLook } from '../../../chart/drawings/templates.ts';
import { indicatorSpec } from '../../../chart/indicators.ts';
import { ColorControl, LineControl } from '../../../chart/settings/controls.tsx';
import { colorName } from '../../../chart/settings/model.ts';
import { clearDefault, deletePreset, renamePreset } from '../../../chart/presets/actions.ts';
import { usePresets } from '../../../chart/presets/store.ts';
import { deleteTemplate, renameTemplate, setDefaultTemplate } from '../../../chart/templates/actions.ts';
import { templateSummary } from '../../../chart/templates/model.ts';
import { useTemplates } from '../../../chart/templates/store.ts';
import { useCatalogLoaded, useCustomIndicators } from '../../../indicators/custom.ts';
import { Row, Section } from '../parts.tsx';
import { ChartColoursSection, LookSection } from './ChartLook.tsx';
import { NewChartsSection } from './NewCharts.tsx';
import { useSettingsNav } from '../store.ts';
import { showArea } from '../../store.ts';

function TemplateRow({ t, isDefault }: { t: ChartTemplate; isDefault: boolean }) {
  const [name, setName] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<void>) =>
    void p.then(
      () => setErr(null),
      (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
    );
  const commit = () => {
    const next = name?.trim();
    setName(null);
    if (next && next !== t.name) run(renameTemplate(t.id, next));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setName(null);
    }
  };
  return (
    <SettingsRow
      data-setting={`chart.template.${t.id}`}
      label={
        name !== null ? (
          <TextInput
            size="s"
            className="st-rename"
            aria-label={`Rename ${t.name}`}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={commit}
          />
        ) : (
          t.name
        )
      }
      help={templateSummary(t)}
      error={err}
    >
      <Switch checked={isDefault} onCheckedChange={(on) => run(setDefaultTemplate(t.id, on))}>
        New charts
      </Switch>
      <Button size="s" variant="quiet" onClick={() => setName(t.name)}>
        Rename
      </Button>
      <ConfirmButton what={t.name} question="Charts keep its indicators." onConfirm={() => run(deleteTemplate(t.id))}>
        Delete
      </ConfirmButton>
    </SettingsRow>
  );
}

function useRename(current: string, rename: (name: string) => void) {
  const [name, setName] = useState<string | null>(null);
  const commit = () => {
    const next = name?.trim();
    setName(null);
    if (next && next !== current) rename(next);
  };
  const box =
    name !== null ? (
      <TextInput
        size="s"
        className="st-rename"
        aria-label={`Rename ${current}`}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setName(null);
          }
        }}
        onBlur={commit}
      />
    ) : null;
  return { box, start: () => setName(current) };
}

function useRowError() {
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<void>) =>
    void p.then(
      () => setErr(null),
      (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
    );
  return { err, setErr, run };
}

function DrawingTemplateRow({
  t,
  all,
  entry,
}: {
  t: DrawingTemplate;
  all: readonly DrawingTemplate[];
  entry: NewDrawingLook | undefined;
}) {
  const { err, setErr, run } = useRowError();
  const tool = toolOf(t.kind);
  const look = lookOfTemplate(t);
  const isNew = sameLook(lookOfNew(t.kind, entry), look);
  const rename = useRename(t.name, (next) => {
    const problem = renameProblem(all, t, next);
    if (problem) setErr(problem);
    else run(renameDrawingTemplate(t.id, next));
  });
  return (
    <SettingsRow
      data-setting={`chart.drawingTemplate.${t.id}`}
      label={
        rename.box ?? (
          <span className="st-dtpl">
            <span className="gl" aria-hidden="true">
              <Icon name={tool.icon} />
            </span>
            {t.name}
          </span>
        )
      }
      help={`${tool.label} · ${lookWords(t.kind, look, colorName)}`}
      error={err}
    >
      <Switch checked={isNew} onCheckedChange={(on) => setNewDrawingsLook(t.kind, on ? look : null)}>
        New drawings
      </Switch>
      <Button size="s" variant="quiet" onClick={rename.start}>
        Rename
      </Button>
      <ConfirmButton
        what={t.name}
        question="Drawings keep their look."
        onConfirm={() => run(deleteDrawingTemplate(t.id))}
      >
        Delete
      </ConfirmButton>
    </SettingsRow>
  );
}

function PresetRow({ p, title }: { p: IndicatorPreset; title: string }) {
  const { err, run } = useRowError();
  const rename = useRename(p.name, (name) => run(renamePreset(p.id, name)));
  return (
    <SettingsRow data-setting={`chart.preset.${p.id}`} label={rename.box ?? p.name} help={title} error={err}>
      <Button size="s" variant="quiet" onClick={rename.start}>
        Rename
      </Button>
      <ConfirmButton what={p.name} question="Indicators keep their settings." onConfirm={() => run(deletePreset(p.id))}>
        Delete
      </ConfirmButton>
    </SettingsRow>
  );
}

function DefaultRow({ indicator, title }: { indicator: string; title: string }) {
  const { err, run } = useRowError();
  return (
    <SettingsRow data-setting={`chart.indicatorDefault.${indicator}`} label="Default" help={title} error={err}>
      <ConfirmButton
        what={`${title} default`}
        question="New ones start from its own defaults."
        onConfirm={() => run(clearDefault(indicator))}
      >
        Clear
      </ConfirmButton>
    </SettingsRow>
  );
}

function IndicatorPresets() {
  const presets = usePresets((s) => s.presets);
  const defaults = usePresets((s) => s.defaults);
  const custom = useCustomIndicators();
  useLoadPending(!useCatalogLoaded());
  const titleOf = (indicator: string) =>
    indicatorSpec(indicator)?.title ?? custom.find((c) => c.id === indicator)?.spec.title ?? indicator;
  const indicators = [...new Set([...Object.keys(defaults), ...presets.map((p) => p.indicator)])].sort((a, b) =>
    titleOf(a).localeCompare(titleOf(b)),
  );
  return (
    <>
      {indicators.map((i) => (
        <Fragment key={i}>
          {i in defaults ? <DefaultRow indicator={i} title={titleOf(i)} /> : null}
          {presets
            .filter((p) => p.indicator === i)
            .map((p) => (
              <PresetRow key={p.id} p={p} title={titleOf(i)} />
            ))}
        </Fragment>
      ))}
    </>
  );
}

function ToolStyles() {
  const styles = useDrawingUi((s) => s.styleByKind);
  const remember = (kind: DrawingKind, patch: NewDrawingLook) => rememberStyle(kind, patch);
  return (
    <div className="st-tools">
      {DRAWING_TOOLS.map((t) => {
        const style = defaultStyle(t.kind, styles[t.kind]);
        const can = styleControls({ kind: t.kind, namespace: 'user' });
        return (
          <div key={t.kind} className="st-tool" data-setting={`chart.tool.${t.kind}`}>
            <span className="gl" aria-hidden="true">
              <Icon name={t.icon} />
            </span>
            <span className="nm">{t.label}</span>
            {can.color ? (
              <ColorControl
                color={style.color}
                label={`${t.label} colour`}
                onChange={(c) => remember(t.kind, { color: c.color })}
              />
            ) : (
              <span className="none" />
            )}
            {can.line ? (
              <LineControl
                width={style.width}
                line={style.line}
                label={`${t.label} line`}
                onChange={(l) => remember(t.kind, l)}
              />
            ) : (
              <span className="none" />
            )}
            {styles[t.kind] ? (
              <Tooltip content="Built-in style">
                <button
                  type="button"
                  className={cx(ICON_BUTTON, 'w-hit h-hit min-w-hit')}
                  aria-label={`${t.label}: the built-in style for new drawings`}
                  onClick={() => setNewDrawingsLook(t.kind, null)}
                >
                  <Icon name="reset" className="text-inherit" />
                </button>
              </Tooltip>
            ) : (
              <span className="none" />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Chart() {
  const magnet = useDrawingUi((s) => s.magnet);
  const folded = useDrawingUi((s) => s.collapsed);
  const styles = useDrawingUi((s) => s.styleByKind);
  const templates = useTemplates((s) => s.templates);
  const defaultId = useTemplates((s) => s.defaultId ?? null);
  const drawingTemplates = useDrawingTemplates((s) => s.templates);
  const hasPresets = usePresets((s) => s.presets.length > 0 || Object.keys(s.defaults).length > 0);
  const target = useSettingsNav((s) => s.target?.id);
  const byKind = TOOLS.flatMap((tool) => drawingTemplates.filter((x) => x.kind === tool.kind));
  return (
    <>
      <NewChartsSection />
      <LookSection />
      <Section id="chart.drawing">
        <Row id="chart.magnet">
          <Switch label="Magnet" checked={magnet} onCheckedChange={(on) => setMagnet(on)} />
        </Row>
        <Row id="chart.railFolded">
          <Switch label="Fold the drawing rail" checked={folded} onCheckedChange={(on) => setCollapsed(on)} />
        </Row>
        <Row id="chart.drawingStyles" layout="stack">
          <ToolStyles />
        </Row>
      </Section>
      {byKind.length > 0 || target === 'chart.drawingTemplates' ? (
        <Section id="chart.drawingTemplates">
          {byKind.length > 0 ? (
            byKind.map((t) => <DrawingTemplateRow key={t.id} t={t} all={drawingTemplates} entry={styles[t.kind]} />)
          ) : (
            <p className="st-empty">No drawing templates saved.</p>
          )}
        </Section>
      ) : null}
      {templates.length > 0 || target === 'chart.templates' ? (
        <Section id="chart.templates">
          {templates.length > 0 ? (
            templates.map((t) => <TemplateRow key={t.id} t={t} isDefault={t.id === defaultId} />)
          ) : (
            <p className="st-empty">No chart templates saved.</p>
          )}
        </Section>
      ) : null}
      {hasPresets || target === 'chart.indicatorPresets' ? (
        <Section id="chart.indicatorPresets">
          {hasPresets ? <IndicatorPresets /> : <p className="st-empty">No indicator presets saved.</p>}
        </Section>
      ) : null}
      <Section id="chart.indicators">
        <Row id="chart.indicatorsLink">
          <Button size="s" onClick={() => showArea('indicators')}>
            Open Indicators
          </Button>
        </Row>
      </Section>
      <ChartColoursSection />
    </>
  );
}
