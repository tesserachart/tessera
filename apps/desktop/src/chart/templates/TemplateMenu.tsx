import type { ChartTemplate, ChartType } from '@tessera/protocol';
import {
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
  cx,
  useCloseMenu,
  type IconName,
} from '@tessera/ui';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { failureText, toolCode, toolReason, useHasTool } from '../../app/tools.ts';
import { openSettings } from '../../areas/settings/store.ts';
import { chartTypeOf, useChartState, useStageView } from '../../state/layouts.ts';
import { useUi } from '../../state/ui.ts';
import type { ChartRef } from '../settings/store.ts';
import { applyTemplate, renameTemplate, saveTemplate, setDefaultTemplate } from './actions.ts';
import {
  chartTemplateNow,
  chipWords,
  copyName,
  isBuiltin,
  NAME_MAX,
  ORDER_FLOW,
  renameProblem,
  templateNamed,
  templateSummary,
  type ChartTemplateNow,
} from './model.ts';
import { chartKey, clearTemplateMenuRequest, followTemplate, openTemplateMenu, useTemplates } from './store.ts';
import { noteOnChart } from '../chartNotice.ts';
import { actWithoutLeavingRow, afterOpenerTakesFocus } from '../focus.ts';

type Form = 'save-as' | 'rename' | 'copy';

function message(err: unknown): string {
  if (toolCode(err) === null) return failureText(err);
  const why = toolReason(err);
  return why.charAt(0).toUpperCase() + why.slice(1);
}

export function RowAction({
  icon,
  label,
  className,
  onAct,
  children,
}: {
  icon: IconName;
  label: string;
  className?: string;
  onAct: () => void;
  children?: string;
}) {
  return (
    <Tooltip content={label} side="right">
      <button type="button" className={cx('tpl-act', className)} aria-label={label} {...actWithoutLeavingRow(onAct)}>
        {children ?? <Icon name={icon} />}
      </button>
    </Tooltip>
  );
}

/** Radix's menu typeahead takes the character keys typed anywhere inside the menu. */
export function NameForm({
  initial,
  label,
  verb,
  error,
  busy,
  onChange,
  onCommit,
}: {
  initial: string;
  label?: string;
  verb: (name: string) => string;
  error: string | null;
  busy: boolean;
  onChange: () => void;
  onCommit: (name: string) => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(
    () =>
      afterOpenerTakesFocus(() => {
        ref.current?.focus();
        ref.current?.select();
      }),
    [],
  );
  const ok = text.trim() !== '' && !busy;
  return (
    <div
      className="tpl-form"
      role="group"
      aria-label={label ?? (verb(text) === 'Rename' ? 'Rename template' : 'Save as template')}
    >
      <div className="tpl-form-row">
        <div className={cx('t-input', 'tpl-name', error && 'is-error')}>
          <input
            ref={ref}
            aria-label="Template name"
            value={text}
            maxLength={NAME_MAX}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              onChange();
            }}
            onKeyDown={(e: KeyboardEvent) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                if (ok) onCommit(text);
              }
            }}
          />
        </div>
        <button type="button" className="tpl-verb" disabled={!ok} onClick={() => onCommit(text)}>
          {verb(text)}
        </button>
      </div>
      {error ? (
        <div className="tpl-err" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function useChartTemplate(chart: ChartRef): { now: ChartTemplateNow | null; type: ChartType } {
  const templates = useTemplates((s) => s.templates);
  const followedId = useTemplates((s) => s.followed[chartKey(chart)] ?? null);
  const model = useChartState(chart.layoutId, chart.tileId);
  const type = chartTypeOf(
    useStageView(chart.layoutId),
    chart.tileId,
    useUi((s) => s.defaultChartType),
    model,
  );
  const now = model ? chartTemplateNow(templates, model.layers, type, followedId) : null;
  const shownId = now && !now.modified ? now.template.id : null;
  const { layoutId, tileId } = chart;
  useEffect(() => {
    if (shownId) followTemplate({ layoutId, tileId }, shownId);
  }, [layoutId, tileId, shownId]);
  return { now, type };
}

function TemplateMenuItems({ chart, now, type }: { chart: ChartRef; now: ChartTemplateNow | null; type: ChartType }) {
  const templates = useTemplates((s) => s.templates);
  const defaultId = useTemplates((s) => s.defaultId ?? null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeMenu = useCloseMenu();
  const all = { templates, ...(defaultId ? { defaultId } : {}) };
  const current = now?.template ?? null;
  const own = current && !isBuiltin(current) ? current : null;

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const done = (note: string) => {
    setForm(null);
    closeMenu();
    noteOnChart(chart, note);
  };
  const openForm = (f: Form) => {
    setError(null);
    setForm(f);
  };
  const saveAs = (name: string, verb: string) => {
    const n = name.trim();
    const replaces = templateNamed(all, n) !== null;
    void run(
      () => saveTemplate(chart, n, type),
      () => done(replaces ? `Replaced the template ${n}` : `${verb} ${n}`),
    );
  };
  // Radix moves the focus on a menu item's pointer move and leave unless the event is default-prevented.
  const hold = form
    ? {
        onPointerMove: (e: PointerEvent) => e.preventDefault(),
        onPointerLeave: (e: PointerEvent) => e.preventDefault(),
      }
    : {};
  const formOr = (f: Form, open: ReactNode, closed: ReactNode) => (form === f ? open : closed);

  return (
    <>
      {own && now?.modified ? (
        <MenuItem
          {...hold}
          onSelect={(e) => {
            e.preventDefault();
            if (busy) return;
            void run(
              () => saveTemplate(chart, own.name, type),
              () => done(`Saved changes to ${own.name}`),
            );
          }}
        >
          Save changes to “{own.name}”
        </MenuItem>
      ) : null}
      {formOr(
        'save-as',
        <NameForm
          initial=""
          label="Save as new template"
          verb={(name) => (templateNamed(all, name) ? 'Replace' : 'Save')}
          error={error}
          busy={busy}
          onChange={() => setError(null)}
          onCommit={(name) => saveAs(name, 'Saved the template')}
        />,
        <MenuItem
          {...hold}
          onSelect={(e) => {
            e.preventDefault();
            openForm('save-as');
          }}
        >
          Save as new template…
        </MenuItem>,
      )}
      {own
        ? formOr(
            'rename',
            <NameForm
              initial={own.name}
              label="Rename template"
              verb={() => 'Rename'}
              error={error}
              busy={busy}
              onChange={() => setError(null)}
              onCommit={(name) => {
                if (name.trim() === own.name) return setForm(null);
                const problem = renameProblem(all, own.id, name);
                if (problem) return setError(problem);
                void run(
                  () => renameTemplate(own.id, name.trim()),
                  () => done(`Renamed the template ${name.trim()}`),
                );
              }}
            />,
            <MenuItem
              {...hold}
              onSelect={(e) => {
                e.preventDefault();
                openForm('rename');
              }}
            >
              Rename…
            </MenuItem>,
          )
        : null}
      {current && !now?.modified
        ? formOr(
            'copy',
            <NameForm
              initial={copyName(all, current.name)}
              label="Copy template"
              verb={(name) => (templateNamed(all, name) ? 'Replace' : 'Copy')}
              error={error}
              busy={busy}
              onChange={() => setError(null)}
              onCommit={(name) => saveAs(name, 'Copied the template as')}
            />,
            <MenuItem
              {...hold}
              onSelect={(e) => {
                e.preventDefault();
                openForm('copy');
              }}
            >
              Make a copy…
            </MenuItem>,
          )
        : null}
      <MenuSeparator />
      {[...templates, ORDER_FLOW].map((t) => (
        <TemplateRow
          key={t.id}
          t={t}
          current={current?.id === t.id}
          isDefault={t.id === defaultId}
          hold={hold}
          onApply={() => {
            if (busy) return;
            void applyTemplate(chart, t.id).catch((err: unknown) => {
              console.warn(`[templates] ${t.name} not applied`, err);
            });
          }}
          onDefault={() => void run(() => setDefaultTemplate(t.id, t.id !== defaultId))}
        />
      ))}
      <MenuSeparator />
      <MenuItem {...hold} onSelect={() => openSettings('chart.templates')}>
        Manage templates…
      </MenuItem>
      {error && !form ? (
        <div className="tpl-err" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}

function TemplateRow({
  t,
  current,
  isDefault,
  hold,
  onApply,
  onDefault,
}: {
  t: ChartTemplate;
  current: boolean;
  isDefault: boolean;
  hold: Partial<Record<'onPointerMove' | 'onPointerLeave', (e: PointerEvent) => void>>;
  onApply: () => void;
  onDefault: () => void;
}) {
  return (
    <MenuItem
      {...hold}
      className="tpl-row"
      current={current}
      detail={templateSummary(t)}
      hint={
        isBuiltin(t) ? undefined : (
          <RowAction
            icon="star"
            label={isDefault ? 'Stop starting new charts with it' : 'Default for new charts'}
            className={cx('tpl-star', isDefault && 'on')}
            onAct={onDefault}
          />
        )
      }
      onSelect={onApply}
    >
      {t.name}
    </MenuItem>
  );
}

export function TemplateChip({ chart }: { chart: ChartRef }) {
  const canList = useHasTool('chart.list_templates');
  const asked = useTemplates((s) => s.menuFor === chartKey(chart));
  const [open, setOpen] = useState(false);
  const { now, type } = useChartTemplate(chart);
  if (!canList) return null;
  const words = chipWords(now);
  return (
    <Menu
      open={open || asked}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o && asked) clearTemplateMenuRequest();
      }}
    >
      <Tooltip content="Chart template">
        <MenuTrigger asChild>
          <button type="button" className="ctl-word ctl-tpl" aria-label={`Template: ${words}`}>
            <span className="k">Template:</span>
            <span className="v">{now?.template.name ?? words}</span>
            {now?.modified ? <span className="m">· modified</span> : null}
            <Icon name="chevron-down" className="chev" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="start" className="tpl-menu">
        <TemplateMenuItems chart={chart} now={now} type={type} />
      </MenuContent>
    </Menu>
  );
}

export function TemplateMenuRow({ chart }: { chart: ChartRef }) {
  const canList = useHasTool('chart.list_templates');
  const { now } = useChartTemplate(chart);
  if (!canList) return null;
  return (
    <MenuItem hint={chipWords(now)} onSelect={() => setTimeout(() => openTemplateMenu(chart), 0)}>
      Template…
    </MenuItem>
  );
}
