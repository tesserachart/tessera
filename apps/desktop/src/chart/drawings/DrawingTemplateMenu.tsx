import type { Drawing } from '@tessera/protocol';
import { ICON_BUTTON, Icon, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip, cx } from '@tessera/ui';
import { useState, type PointerEvent } from 'react';
import { useHasTool } from '../../app/tools.ts';
import type { ChartRef } from '../settings/store.ts';
import { NameForm, RowAction } from '../templates/TemplateMenu.tsx';
import { toolOf } from './model.ts';
import { useDrawingUi } from './store.ts';
import { applyLook, reason, saveDrawingTemplate, setNewDrawingsLook } from './templateActions.ts';
import { useDrawingTemplates } from './templateStore.ts';
import {
  builtInLook,
  lookOfDrawing,
  lookOfNew,
  lookOfTemplate,
  sameLook,
  templateNamed,
  templatesOf,
  type DrawingLook,
} from './templates.ts';

export function DrawingTemplateMenu({ chart, drawing: d }: { chart: ChartRef; drawing: Drawing }) {
  const canSave = useHasTool('chart.save_drawing_template');
  const all = useDrawingTemplates((s) => s.templates);
  const entry = useDrawingUi((s) => s.styleByKind[d.kind]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = templatesOf(all, d.kind);
  const look = lookOfDrawing(d);
  const forNew = lookOfNew(d.kind, entry);
  const builtIn = builtInLook(d.kind);
  const kindName = toolOf(d.kind).label;
  // Radix moves the focus on a menu item's pointer move and leave unless the event is default-prevented.
  const hold = saving
    ? {
        onPointerMove: (e: PointerEvent) => e.preventDefault(),
        onPointerLeave: (e: PointerEvent) => e.preventDefault(),
      }
    : {};
  const row = (key: string, name: string, l: DrawingLook, builtin: boolean) => {
    const isNew = sameLook(forNew, l);
    return (
      <MenuItem
        key={key}
        {...hold}
        className={cx('tpl-mi', builtin && 'dsb-tpl-builtin')}
        current={sameLook(look, l)}
        hint={isNew ? 'default' : undefined}
        onSelect={(e) => {
          if (busy) return e.preventDefault();
          applyLook(chart, d.id, l);
        }}
      >
        <span className="nm">{name}</span>
        <span className="tpl-acts">
          <RowAction
            icon="plus"
            label={isNew ? 'New drawings take it' : 'Apply to new drawings'}
            className={isNew ? 'on' : undefined}
            onAct={() => setNewDrawingsLook(d.kind, isNew || builtin ? null : l)}
          />
        </span>
      </MenuItem>
    );
  };
  return (
    <Menu
      modal={false}
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setSaving(false);
          setError(null);
        }
      }}
    >
      <Tooltip content="Template">
        <MenuTrigger asChild>
          <button type="button" className={cx(ICON_BUTTON, 'w-7 h-7')} aria-label={`${kindName} templates`}>
            <Icon name="layers" className="text-inherit" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent
        align="start"
        className="ind-menu tpl-menu dsb-tpl"
        onEscapeKeyDown={(e) => {
          if (!saving) return;
          e.preventDefault();
          setSaving(false);
          setError(null);
        }}
      >
        {canSave ? (
          saving ? (
            <NameForm
              initial=""
              verb={(name) => (templateNamed(all, d.kind, name) ? 'Replace' : 'Save')}
              error={error}
              busy={busy}
              onChange={() => setError(null)}
              onCommit={(name) => {
                setBusy(true);
                setError(null);
                saveDrawingTemplate(d, name.trim())
                  .then(() => {
                    setSaving(false);
                    setOpen(false);
                  })
                  .catch((err: unknown) => setError(reason(err)))
                  .finally(() => setBusy(false));
              }}
            />
          ) : (
            <MenuItem
              onSelect={(e) => {
                e.preventDefault();
                setError(null);
                setSaving(true);
              }}
            >
              Save as template…
            </MenuItem>
          )
        ) : null}
        {mine.length > 0 ? <MenuSeparator /> : null}
        {mine.map((t) => row(t.id, t.name, lookOfTemplate(t), false))}
        {canSave || mine.length > 0 ? <MenuSeparator /> : null}
        {row('built-in', 'Built-in style', builtIn, true)}
      </MenuContent>
    </Menu>
  );
}
