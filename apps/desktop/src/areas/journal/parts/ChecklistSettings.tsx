import { valueOf } from '../../../app/tools.ts';
import type { ChecklistItemInput } from '@tessera/protocol';
import { Button, Dialog, DialogContent, IconButton, Switch, TextInput, cx } from '@tessera/ui';
import { useRef, useState, type PointerEvent } from 'react';
import { useCatalog, useJournalAction } from '../data.ts';
import { journalDrafts } from '../drafts.ts';
import { useDraft } from '../../../app/overlay.ts';

export function ChecklistSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const cat = valueOf(useCatalog());
  const act = useJournalAction();
  const draft = useDraft<ChecklistItemInput[]>(journalDrafts, cat ? 'checklist' : null, cat?.checklist ?? []);
  const items = draft.value;
  const [text, setText] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const save = (next: ChecklistItemInput[]) => draft.save(next, (v) => act('journal.save_checklist', { items: v }));
  const over = (y: number): number => {
    const rows = Array.from(list.current?.children ?? []);
    const i = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    return i < 0 ? rows.length - 1 : i;
  };
  const onMove = (e: PointerEvent) => {
    if (drag === null) return;
    const to = over(e.clientY);
    if (to === drag) return;
    const next = [...items];
    const [it] = next.splice(drag, 1);
    if (it) next.splice(to, 0, it);
    draft.edit(next);
    setDrag(to);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="jk-dialog"
        title="Checklist settings"
        description="An item turned off stays on the days it was ticked."
      >
        <ol className="jk-sortable" ref={list} onPointerMove={onMove}>
          {items.map((it, i) => (
            <li key={it.id ?? `new-${String(i)}`} className={cx(drag === i && 'is-dragging')}>
              <span
                className="jk-grip"
                role="button"
                tabIndex={0}
                aria-label="Drag to reorder"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag(i);
                }}
                onPointerUp={() => {
                  setDrag(null);
                  save(items);
                }}
                onKeyDown={(e) => {
                  const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : -1;
                  if (to < 0 || to >= items.length) return;
                  e.preventDefault();
                  const next = [...items];
                  const [x] = next.splice(i, 1);
                  if (x) next.splice(to, 0, x);
                  save(next);
                }}
              >
                ⋮⋮
              </span>
              <TextInput
                size="s"
                defaultValue={it.text}
                aria-label="Item"
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value !== it.text &&
                  save(items.map((x, j) => (j === i ? { ...x, text: e.target.value.trim() } : x)))
                }
              />
              <Switch
                label="In use"
                checked={it.active ?? true}
                onCheckedChange={(v) => save(items.map((x, j) => (j === i ? { ...x, active: v } : x)))}
              />
              <IconButton label="Remove" icon="remove" onClick={() => save(items.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ol>
        {!items.length ? <p className="text-t3 jk-sortable-empty">No items yet.</p> : null}
        <form
          className="jk-sortable-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            save([...items, { text: text.trim(), active: true }]);
            setText('');
          }}
        >
          <TextInput
            size="s"
            value={text}
            placeholder="Add new checklist item…"
            aria-label="Add new checklist item"
            onChange={(e) => setText(e.target.value)}
          />
          <Button size="s" type="submit" disabled={!text.trim()}>
            Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
