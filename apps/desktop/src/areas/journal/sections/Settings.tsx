import { valueOf } from '../../../app/tools.ts';
import type { SessionDef, Tag } from '@tessera/protocol';
import {
  Button,
  ColorPicker,
  Combobox,
  ConfirmButton,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  Loaded,
  Table,
  TBody,
  Td,
  TextInput,
  Th,
  THead,
  cx,
  formatMoney,
} from '@tessera/ui';
import { useState } from 'react';
import { useCatalog, useJournalAction } from '../data.ts';
import { journalDrafts } from '../drafts.ts';
import { useDraft } from '../../../app/overlay.ts';
import { Badge, Empty, PageHead, Panel } from '../kit/index.ts';
import { plural, tone } from '../model/format.ts';
import { ChecklistSettings } from '../parts/ChecklistSettings.tsx';
import { isTimeZone, TIME_ZONE_OPTIONS, useDisplayZone, zoneLabel } from '../../../state/timeZone.ts';
import './settings.css';

export function Settings() {
  return (
    <Loaded label="Loading settings">
      <div className="js-page">
        <PageHead title="Settings" />
        <div className="js-body">
          <Tags />
          <ChecklistPanel />
          <Reading />
        </div>
      </div>
    </Loaded>
  );
}

function Tags() {
  const cat = valueOf(useCatalog());
  const act = useJournalAction();
  const [editing, setEditing] = useState<Tag | 'new' | null>(null);
  const tags = cat?.tags ?? [];
  return (
    <Panel
      chrome="tags"
      title="Tags"
      description="The analytics compare the tags within a group (Mistake, Context)."
      actions={
        <Button size="s" onClick={() => setEditing('new')}>
          New tag
        </Button>
      }
      flush
    >
      {tags.length ? (
        <Table className="jr-table">
          <THead>
            <tr>
              <Th>Tag</Th>
              <Th>Group</Th>
              <Th align="right">Trades</Th>
              <Th align="right">Net</Th>
              <Th align="right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {tags.map((t) => (
              <tr key={t.id}>
                <Td>
                  <Badge color={t.color}>{t.name}</Badge>
                </Td>
                <Td className="t3">{t.group || '—'}</Td>
                <Td align="right">{t.uses}</Td>
                <Td align="right" className={tone(t.net)}>
                  {t.uses ? formatMoney(t.net, { signed: true }) : '—'}
                </Td>
                <Td align="right" className="js-acts">
                  <Button size="s" variant="quiet" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <ConfirmButton
                    what={`the tag ${t.name}`}
                    question={t.uses ? `Take it off ${plural(t.uses, 'trade')}?` : 'Delete it?'}
                    onConfirm={() => void act('journal.delete_tag', { id: t.id })}
                  >
                    Delete
                  </ConfirmButton>
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      ) : (
        <Empty compact icon="journal" title="No tags yet">
          e.g. Breakout, News trade, A+ setup.
        </Empty>
      )}
      <TagDialog tag={editing} onClose={() => setEditing(null)} />
    </Panel>
  );
}

function TagDialog({ tag, onClose }: { tag: Tag | 'new' | null; onClose: () => void }) {
  const act = useJournalAction();
  const t = tag === 'new' || tag === null ? null : tag;
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [color, setColor] = useState(SWATCHES[0]!);
  const [seen, setSeen] = useState<Tag | 'new' | null>(null);
  if (tag !== seen) {
    setSeen(tag);
    setName(t?.name ?? '');
    setGroup(t?.group ?? '');
    setColor(t?.color ?? SWATCHES[0]!);
  }
  return (
    <Dialog open={tag !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="jk-dialog" title={t ? 'Edit tag' : 'New tag'}>
        <form
          className="js-tagform"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void act('journal.save_tag', {
              ...(t ? { id: t.id } : {}),
              name: name.trim(),
              group: group.trim(),
              color,
            }).then(onClose);
          }}
        >
          <Field label="Name">
            <TextInput
              autoFocus
              value={name}
              placeholder="e.g. Breakout, News trade, A+ setup"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Group">
            <TextInput value={group} placeholder="Mistake, Context, Exit…" onChange={(e) => setGroup(e.target.value)} />
          </Field>
          <Field label="Colour" className="js-colour">
            <ColorPicker label="Colour" value={color} swatches={TAG_SWATCHES} align="start" onChange={setColor} />
          </Field>
          <div className="js-formacts">
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={!name.trim()}>
              {t ? 'Save' : 'Create tag'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChecklistPanel() {
  const cat = valueOf(useCatalog());
  const [open, setOpen] = useState(false);
  const items = cat?.checklist ?? [];
  return (
    <Panel
      chrome="daily-checklist"
      title="Daily checklist"
      description="An item turned off stays on the days it was ticked."
      actions={
        <Button size="s" onClick={() => setOpen(true)}>
          Edit checklist
        </Button>
      }
    >
      {items.length ? (
        <ol className="js-checklist">
          {items.map((it) => (
            <li key={it.id} className={cx(!it.active && 'text-t4')}>
              {it.text}
              {!it.active ? <span className="text-t4"> · off</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <Empty compact icon="done" title="No checklist yet" />
      )}
      <ChecklistSettings open={open} onOpenChange={setOpen} />
    </Panel>
  );
}

const SWATCHES = ['#7f9fbf', '#a597cf', '#9bab78', '#b98f7a', '#6fa8a0', '#c4a46b', '#b07f9a', '#8c96a8'];
const TAG_SWATCHES = SWATCHES.map((color) => ({ color, name: color }));

function Reading() {
  const cat = valueOf(useCatalog());
  const act = useJournalAction();
  const zone = useDisplayZone();
  const s = cat?.settings;
  const draft = useDraft<SessionDef[]>(journalDrafts, s ? 'sessions' : null, s?.sessions ?? []);
  const sessions = draft.value;
  if (!s) return null;
  const saveSessions = (next: SessionDef[]) => {
    if (
      next.every(
        (x) =>
          x.name.trim() && /^\d{1,2}:\d{2}$/.test(x.start) && /^\d{1,2}:\d{2}$/.test(x.end) && isTimeZone(x.timezone),
      )
    )
      draft.save(next, (v) => act('journal.set_settings', { sessions: v }));
    else draft.edit(next);
  };
  return (
    <Panel
      chrome="trading-preferences"
      title="How trades are read"
      description={`Times are in your time zone, ${zoneLabel(zone)} (Settings › App). Each session keeps its own market’s.`}
    >
      <div className="jr-settings-grid">
        <Field
          label="Breakeven band"
          htmlFor="jr-be"
          help="Within ± this a trade is breakeven: counted, but not in the win rate."
        >
          <TextInput
            id="jr-be"
            size="s"
            inputMode="decimal"
            unit="$"
            defaultValue={s.breakevenThreshold}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v !== s.breakevenThreshold)
                void act('journal.set_settings', { breakevenThreshold: v });
            }}
          />
        </Field>
      </div>
      <h3 className="jr-sub">Sessions</h3>
      <ol className="jr-sessions">
        {sessions.map((x, i) => (
          <li key={i}>
            <TextInput
              size="s"
              defaultValue={x.name}
              aria-label="Name"
              onBlur={(e) => saveSessions(sessions.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))}
            />
            <TextInput
              size="s"
              type="time"
              defaultValue={x.start}
              aria-label="Start"
              onBlur={(e) => saveSessions(sessions.map((y, j) => (j === i ? { ...y, start: e.target.value } : y)))}
            />
            <TextInput
              size="s"
              type="time"
              defaultValue={x.end}
              aria-label="End"
              onBlur={(e) => saveSessions(sessions.map((y, j) => (j === i ? { ...y, end: e.target.value } : y)))}
            />
            <Combobox
              size="s"
              label={`Time zone of ${x.name}`}
              value={x.timezone}
              onValueChange={(zone) => saveSessions(sessions.map((y, j) => (j === i ? { ...y, timezone: zone } : y)))}
              options={TIME_ZONE_OPTIONS}
            />
            <IconButton
              label="Remove session"
              icon="remove"
              onClick={() => saveSessions(sessions.filter((_, j) => j !== i))}
            />
          </li>
        ))}
      </ol>
      <Button
        size="s"
        variant="quiet"
        onClick={() => draft.edit([...sessions, { name: 'Session', start: '09:30', end: '11:30', timezone: zone }])}
      >
        Add a session
      </Button>
    </Panel>
  );
}
