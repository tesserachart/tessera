import {
  normalizeEpochMs,
  type CustomIndicator,
  type IndicatorInput,
  type IndicatorSpec,
  type Timeframe,
} from '@tessera/protocol';
import {
  Button,
  Icon,
  IconButton,
  Loaded,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tooltip,
  cx,
} from '@tessera/ui';
import { useEffect, useEffectEvent, useId, useMemo, useState, type ReactNode } from 'react';
import { useClock } from '../../app/clock.ts';
import { addCustomToChart } from '../../chart/settings/actions.ts';
import {
  Check,
  ColorControl,
  NumberInput,
  SelectField,
  SessionHoursInput,
  StudyTimeInput,
  TimeZoneSelect,
} from '../../chart/settings/controls.tsx';
import { SOURCE_OPTIONS } from '../../chart/settings/model.ts';
import { askAnalyst } from '../../shell/tradeActions.ts';
import type { ActiveChart } from '../../state/workspace.ts';
import { showArea } from '../store.ts';
import { CodeEditor, CodeSample } from './CodeEditor.tsx';
import {
  byWords,
  chartWords,
  codeOf,
  duplicate,
  edit,
  isDirty,
  load,
  NEW_INDICATOR_CODE,
  remove,
  restore,
  run,
  save,
  setPreviewInput,
  usePage,
  type RunState,
} from './model.ts';
import { PreviewChart } from './PreviewChart.tsx';
import { PreviewFrame } from './PreviewFrame.tsx';
import { zonedFormat } from '../../state/timeZone.ts';

const RUN_AFTER_TYPING_MS = 700;

const SAVED_DAY = zonedFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const SAVED_TIME = zonedFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const SAVED_DATE = zonedFormat('en-GB', { day: 'numeric', month: 'short' });

function savedAt(ns: number, nowMs: number): string {
  const at = normalizeEpochMs(ns);
  return SAVED_DAY().format(nowMs) === SAVED_DAY().format(at) ? SAVED_TIME().format(at) : SAVED_DATE().format(at);
}

type EditorProps = {
  id: string;
  indicator: CustomIndicator | null;
  chart: ActiveChart | null;
  preview: { instrument: string; tf: Timeframe };
  unavailable: string | null;
};

export function CustomEditor(props: EditorProps) {
  const loaded = usePage((s) => props.id === 'new' || props.id in s.saved);
  return (
    <Loaded
      label="Loading the indicator"
      pending={!loaded}
      sample={<EditorSample title={props.indicator?.spec.title ?? 'Custom indicator'} preview={props.preview} />}
    >
      <EditorBody {...props} />
    </Loaded>
  );
}

function EditorHead({ title, meta, children }: { title: string; meta: string; children: ReactNode }) {
  return (
    <header className="ia-ed-head">
      <div className="ia-ed-name">
        <h2>{title}</h2>
        <span className="meta">{meta}</span>
      </div>
      <div className="ia-ed-actions">{children}</div>
    </header>
  );
}

function PreviewHead({ preview }: { preview: { instrument: string; tf: Timeframe } }) {
  return (
    <div className="ia-ed-preview-head">
      <span className="where">
        {preview.instrument} · {preview.tf}
      </span>
    </div>
  );
}

export function EditorSample({ title, preview }: { title: string; preview: { instrument: string; tf: Timeframe } }) {
  return (
    <div className="ia-ed">
      <EditorHead title={title} meta="v3 · saved 14:20 by you">
        <Button size="s" shortcut="mod+enter">
          Run
        </Button>
        <Button size="s" variant="secondary" shortcut="mod+s">
          Save
        </Button>
        <Button size="s">Add to chart</Button>
        <Button size="s" variant="quiet" className="text-aqua">
          Ask the analyst
        </Button>
        <IconButton label="More" icon="more" />
      </EditorHead>
      <div className="ia-ed-body">
        <div className="ia-ed-code">
          <CodeSample code={NEW_INDICATOR_CODE} />
          <div className="ia-ed-status">
            <span className="quiet">1,200 bars in 4 ms</span>
          </div>
        </div>
        <div className="ia-ed-side">
          <PreviewHead preview={preview} />
          <PreviewFrame />
        </div>
      </div>
    </div>
  );
}

function EditorBody({ id, indicator, chart, preview, unavailable }: EditorProps) {
  const clock = useClock();
  const isNew = id === 'new';
  const code = usePage((s) => codeOf(s, id));
  const dirty = usePage((s) => isDirty(s, id));
  const runState = usePage((s) => s.runs[id] ?? null);
  const inputs = usePage((s) => s.inputs[id]);
  const busy = usePage((s) => s.busy[id] ?? null);
  const saveProblem = usePage((s) => s.saveProblems[id] ?? null);
  const savedDetail = usePage((s) => s.saved[id]?.detail ?? null);
  const loaded = usePage((s) => isNew || id in s.saved);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!isNew && !loaded) void load(id).catch(() => undefined);
  }, [id, isNew, loaded]);

  const runCode = () => {
    if (unavailable || !loaded) return;
    void run(id, preview.instrument, preview.tf);
  };
  const runNow = useEffectEvent(runCode);
  const typingDelay = useEffectEvent(() => (runState && runState.code !== code ? RUN_AFTER_TYPING_MS : 0));
  const inputsKey = JSON.stringify(inputs ?? {});
  useEffect(() => {
    if (!loaded || code === '') return;
    const t = setTimeout(() => runNow(), typingDelay());
    return () => clearTimeout(t);
  }, [code, loaded, preview.instrument, preview.tf, inputsKey]);

  const onSave = () => {
    if (!dirty || busy || unavailable) return;
    void save(id);
  };
  const problem = runState?.status === 'error' ? runState.problem : saveProblem;
  const spec = runState?.series?.spec ?? indicator?.spec ?? null;
  const title = spec?.title ?? (isNew ? 'New indicator' : 'Custom indicator');
  const versions = savedDetail?.versions ?? [];

  return (
    <div className="ia-ed">
      <EditorHead
        title={title}
        meta={
          isNew
            ? 'Not saved'
            : indicator
              ? `v${String(indicator.latest)} · saved ${savedAt(indicator.updatedAt, clock.now())} by ${byWords(versions[0]?.createdBy ?? indicator.createdBy)}${dirty ? ' · edited' : ''}`
              : ''
        }
      >
        <Button size="s" shortcut="mod+enter" disabled={!!unavailable} onClick={runCode}>
          Run
        </Button>
        <Button
          size="s"
          variant={dirty ? 'primary' : 'secondary'}
          shortcut="mod+s"
          disabled={!dirty || !!busy || !!unavailable}
          onClick={onSave}
        >
          {busy === 'saving' ? 'Saving' : 'Save'}
        </Button>
        <Tooltip
          content={isNew || dirty ? 'Save it first' : chart ? `Add to ${chartWords(chart)}` : 'Open a chart first'}
        >
          <span>
            <Button
              size="s"
              disabled={isNew || dirty || !chart}
              onClick={() => {
                if (chart && !isNew) addCustomToChart({ layoutId: chart.layoutId, tileId: chart.tileId }, id);
              }}
            >
              Add to chart
            </Button>
          </span>
        </Tooltip>
        <Button
          size="s"
          variant="quiet"
          className="text-aqua"
          onClick={() => {
            showArea('desk');
            askAnalyst(
              isNew || !indicator
                ? 'Write a custom indicator that '
                : `Change my custom indicator ${indicator.spec.title} (${indicator.id}) so that `,
            );
          }}
        >
          Ask the analyst
        </Button>
        {!isNew && indicator ? (
          <Menu>
            <Tooltip content="More">
              <MenuTrigger asChild>
                <IconButton label="More" icon="more" />
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="end" style={{ width: 260 }}>
              <MenuItem disabled={!!busy} onSelect={() => void duplicate(indicator)}>
                Duplicate
              </MenuItem>
              {versions.length > 1 ? (
                <MenuSub>
                  <MenuSubTrigger>Earlier versions</MenuSubTrigger>
                  <MenuSubContent style={{ width: 280 }}>
                    {versions.slice(1).map((v) => (
                      <MenuItem
                        key={v.version}
                        hint={`${savedAt(v.createdAt, clock.now())} · ${byWords(v.createdBy)}`}
                        onSelect={() => void restore(id, v.version)}
                      >
                        {`v${String(v.version)}${v.note ? ` · ${v.note}` : ''}`}
                      </MenuItem>
                    ))}
                  </MenuSubContent>
                </MenuSub>
              ) : null}
              <MenuSeparator />
              <MenuItem onSelect={() => setConfirmDelete(true)}>Delete…</MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
      </EditorHead>
      {confirmDelete && indicator ? (
        <div className="ia-ed-confirm" role="alertdialog" aria-label="Delete">
          <span>
            Delete {indicator.spec.title} and its{' '}
            {indicator.latest === 1 ? 'one version' : `${String(indicator.latest)} versions`}? Charts that draw it will
            say it is gone.
          </span>
          <Button size="s" variant="destructive" what={indicator.spec.title} onClick={() => void remove(id)}>
            Delete
          </Button>
          <Button size="s" variant="quiet" onClick={() => setConfirmDelete(false)}>
            Keep
          </Button>
        </div>
      ) : null}
      {unavailable ? <p className="ia-ed-unavailable">{unavailable}</p> : null}
      <div className="ia-ed-body">
        <div className="ia-ed-code">
          {loaded ? (
            <CodeEditor
              value={code}
              label={`${title} code`}
              problem={problem}
              onChange={(c) => edit(id, c)}
              onRun={runCode}
              onSave={onSave}
            />
          ) : null}
          <Status run={runState} problem={problem} />
        </div>
        <div className="ia-ed-side">
          <PreviewHead preview={preview} />
          <PreviewChart instrument={preview.instrument} tf={preview.tf} series={runState?.series ?? null} />
          {spec && spec.inputs.length > 0 ? <PreviewInputs id={id} spec={spec} values={inputs ?? {}} /> : null}
          {runState?.logs ? (
            <section className="ia-ed-logs" aria-label="Printed">
              <h3>Printed</h3>
              <pre>{runState.logs}</pre>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Status({ run: r, problem }: { run: RunState | null; problem: RunState['problem'] }) {
  let body: ReactNode = null;
  if (problem) {
    body = (
      <>
        <Icon name="attention" />
        <span className="msg" data-selectable>
          {problem.message}
        </span>
      </>
    );
  } else if (r?.status === 'running') {
    body = <span className="quiet">Running</span>;
  } else if (r?.status === 'ok' && r.series) {
    body = (
      <span className="quiet">
        {`${String(r.series.bars)} bars in ${r.series.computeMs < 1 ? '<1' : r.series.computeMs.toFixed(0)} ms`}
      </span>
    );
  }
  return (
    <div className={cx('ia-ed-status', problem && 'is-problem')} role={problem ? 'alert' : undefined}>
      {body}
    </div>
  );
}

function PreviewInputs({
  id,
  spec,
  values,
}: {
  id: string;
  spec: IndicatorSpec;
  values: Readonly<Record<string, number | string | boolean>>;
}) {
  const uid = useId();
  const rows = useMemo(() => spec.inputs, [spec]);
  const control = (i: IndicatorInput): ReactNode => {
    const v = values[i.key] ?? i.default;
    const set = (x: number | string | boolean) => setPreviewInput(id, i.key, x);
    switch (i.type) {
      case 'int':
      case 'number':
        return (
          <NumberInput
            id={`${uid}-${i.key}`}
            label={i.label}
            value={typeof v === 'number' ? v : Number(i.default)}
            min={i.min}
            max={i.max}
            step={i.step}
            integer={i.type === 'int'}
            onChange={set}
          />
        );
      case 'source':
        return <SelectField value={String(v)} options={SOURCE_OPTIONS} label={i.label} onChange={set} />;
      case 'enum':
        return <SelectField value={String(v)} options={i.options ?? []} label={i.label} onChange={set} />;
      case 'bool':
        return <Check checked={v === true} label={i.label} onChange={set} />;
      case 'color':
        return <ColorControl color={String(v)} label={i.label} onChange={(c) => set(c.color)} />;
      case 'session':
        return <SessionHoursInput id={`${uid}-${i.key}`} label={i.label} value={String(v)} onChange={set} />;
      case 'timezone':
        return <TimeZoneSelect id={`${uid}-${i.key}`} label={i.label} value={String(v)} onChange={set} />;
      case 'time':
        return <StudyTimeInput id={`${uid}-${i.key}`} label={i.label} value={String(v)} onChange={set} />;
    }
  };
  return (
    <section className="ia-ed-inputs ind-rows" aria-label="Inputs">
      {rows.map((i) =>
        i.type === 'bool' ? (
          <div key={i.key} className="ind-row">
            {control(i)}
          </div>
        ) : (
          <div key={i.key} className="ind-row">
            <label className="lab" htmlFor={`${uid}-${i.key}`}>
              {i.label}
            </label>
            {control(i)}
          </div>
        ),
      )}
    </section>
  );
}
