import type { AttachmentInfo, Tag } from '@tessera/protocol';
import {
  Button,
  IconButton,
  Loaded,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  TextInput,
  Tooltip,
  cx,
} from '@tessera/ui';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import { useJournalAction } from '../data.ts';
import { useAttachmentUrl } from './hooks.ts';

export interface StatCell {
  label: string;
  value: ReactNode;
  tone?: 'up' | 'down' | undefined;
  hint?: string;
  sub?: ReactNode;
}

export function StatStrip({ cells, focal = 0 }: { cells: readonly StatCell[]; focal?: number | null }) {
  return (
    <div className="jr-strip" role="group" aria-label="Statistics">
      {cells.map((c, i) => {
        const body = (
          <div className={cx('jr-cell', i === focal && 'is-focal')} tabIndex={c.hint ? 0 : undefined}>
            <span className={cx('v', c.tone)}>{c.value}</span>
            <span className="l">
              {c.label}
              {c.sub ? <span className="s"> {c.sub}</span> : null}
            </span>
          </div>
        );
        return c.hint ? (
          <Tooltip key={c.label} content={c.hint}>
            {body}
          </Tooltip>
        ) : (
          <Fragment key={c.label}>{body}</Fragment>
        );
      })}
    </div>
  );
}

const STAR = 'M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.3-3 4.4-.5z';

export function Rating({
  value,
  onChange,
  size = 'md',
}: {
  value: number | null;
  onChange?: (v: number | null) => void;
  size?: 'md' | 's';
}) {
  return (
    <span
      className={cx('jr-rating', size === 's' && 's')}
      role="group"
      aria-label={`Rating ${value ? String(value) : 'none'}`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          type="button"
          key={n}
          className={cx((value ?? 0) >= n && 'is-on')}
          aria-label={`${String(n)} of 5`}
          aria-pressed={(value ?? 0) >= n}
          disabled={!onChange}
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(value === n ? null : n);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d={STAR} />
          </svg>
        </button>
      ))}
    </span>
  );
}

const GROUPS = ['', 'Mistake', 'Context', 'Exit'];
const NO_GROUP = 'none';

export function TagPicker({
  tags,
  value,
  onChange,
  trigger,
}: {
  tags: readonly Tag[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  trigger?: ReactNode;
}) {
  const act = useJournalAction();
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const groups = Array.from(new Set(['', ...tags.map((t) => t.group)]));
  const make = async () => {
    const n = name.trim();
    if (!n) return;
    const tag = await act('journal.save_tag', { name: n, ...(group ? { group } : {}) });
    setName('');
    onChange([...value, tag.id]);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button size="s" variant="quiet">
            Tags
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="jr-tagpick" align="start">
        {groups.map((g) => {
          const mine = tags.filter((t) => t.group === g);
          if (!mine.length) return null;
          return (
            <div key={g} className="jr-tagpick-group">
              <span className="jr-label">{g || 'Tags'}</span>
              <div className="jr-tagpick-list">
                {mine.map((t) => {
                  const on = value.includes(t.id);
                  return (
                    <button
                      type="button"
                      key={t.id}
                      className={cx('jr-tag', 'is-pick', on && 'is-on', t.group && 'is-grouped')}
                      style={{ ['--tag' as string]: t.color }}
                      aria-pressed={on}
                      onClick={() => onChange(on ? value.filter((v) => v !== t.id) : [...value, t.id])}
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <form
          className="jr-tagpick-new"
          onSubmit={(e) => {
            e.preventDefault();
            void make();
          }}
        >
          <TextInput
            size="s"
            value={name}
            placeholder="New tag"
            aria-label="New tag"
            onChange={(e) => setName(e.target.value)}
          />
          <Select
            size="s"
            label="Group"
            value={group || NO_GROUP}
            onValueChange={(g) => setGroup(g === NO_GROUP ? '' : g)}
            options={Array.from(new Set([...GROUPS, ...groups])).map((g) => ({
              value: g || NO_GROUP,
              label: g || 'No group',
            }))}
          />
          <Button size="s" type="submit" disabled={!name.trim()}>
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function Thumb({ a, onRemove }: { a: AttachmentInfo; onRemove?: () => void }) {
  return (
    <Loaded alone label="Loading the screenshot">
      <ThumbFigure a={a} {...(onRemove ? { onRemove } : {})} />
    </Loaded>
  );
}

function ThumbFigure({ a, onRemove }: { a: AttachmentInfo; onRemove?: () => void }) {
  const url = useAttachmentUrl(a.mediaType.startsWith('image/') ? a.id : null);
  return (
    <figure className="jr-thumb group/thumb">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer noopener" title={a.filename}>
          <img src={url} alt={a.caption ?? a.filename} />
        </a>
      ) : (
        <span className="jr-thumb-file">{a.filename}</span>
      )}
      {onRemove ? (
        <IconButton
          className="absolute top-0 right-0 opacity-0 bg-ink-86 group-hover/thumb:opacity-100 focus-visible:opacity-100"
          label="Remove"
          icon="remove"
          onClick={onRemove}
        />
      ) : null}
    </figure>
  );
}

export function Filmstrip({
  items,
  onAdd,
  onRemove,
}: {
  items: readonly AttachmentInfo[];
  onAdd: (f: File) => Promise<unknown>;
  onRemove: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const add = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) void onAdd(f);
  };
  return (
    <div
      className={cx('jr-film', over && 'is-over')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        add(e.dataTransfer.files);
      }}
    >
      {items.map((a) => (
        <Thumb key={a.id} a={a} onRemove={() => onRemove(a.id)} />
      ))}
      <button type="button" className="jr-film-add" onClick={() => input.current?.click()}>
        {items.length ? 'Add' : 'Drop screenshots here, or pick them'}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export function Head({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="jr-head">
      <h2 className="jr-h">{title}</h2>
      {children ? <div className="jr-head-r">{children}</div> : null}
    </div>
  );
}
