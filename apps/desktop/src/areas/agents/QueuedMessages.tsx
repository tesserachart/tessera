import type { QueuedMessage } from '@tessera/protocol';
import { Icon, Tooltip, cx } from '@tessera/ui';
import { useId, useState } from 'react';
import type { QueueView } from './useChat.ts';

const words = (q: QueuedMessage) => q.text.trim() || q.attachments.map((a) => a.label).join(', ') || 'Attachments';

export function QueuedMessages({ queue }: { queue: QueueView }) {
  const [open, setOpen] = useState(true);
  const list = useId();
  const n = queue.items.length;
  if (n === 0) return null;
  return (
    <section
      className="ag-queue"
      aria-label={`${String(n)} queued message${n === 1 ? '' : 's'}`}
      aria-live="polite"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="ag-queue-head"
        aria-expanded={open}
        aria-controls={list}
        aria-label={open ? 'Collapse queued messages' : 'Expand queued messages'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="queue" />
        <span className="tt">{queue.held ? 'Queued, paused' : 'Queued'}</span>
        <span className="n">{n}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-up'} className="cv" />
      </button>
      {open ? (
        <ol id={list} className="ag-queue-list">
          {queue.items.map((q) => {
            const editing = queue.editing === q.id;
            return (
              <li key={q.id} className={cx('ag-queued', editing && 'is-editing')} aria-current={editing || undefined}>
                <Tooltip content={words(q)} side="top">
                  <span className="tx">
                    {editing ? <span className="sr-only">Editing queued message: </span> : null}
                    {words(q)}
                  </span>
                </Tooltip>
                {q.attachments.length > 0 && q.text.trim() ? (
                  <span className="att" aria-label={`${String(q.attachments.length)} attached`}>
                    <Icon name="attach" />
                    {q.attachments.length}
                  </span>
                ) : null}
                {editing ? (
                  <button
                    type="button"
                    className="ag-queued-cancel"
                    aria-label="Cancel editing queued message"
                    onClick={queue.cancelEdit}
                  >
                    Cancel
                  </button>
                ) : (
                  <>
                    <Tooltip content="Edit in the composer" side="top">
                      <button
                        type="button"
                        className="ag-queued-act"
                        aria-label="Edit queued message"
                        onClick={() => queue.edit(q.id)}
                      >
                        <Icon name="edit" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Remove from queue" side="top">
                      <button
                        type="button"
                        className="ag-queued-act"
                        aria-label="Remove queued message"
                        onClick={() => queue.remove(q.id)}
                      >
                        <Icon name="remove" />
                      </button>
                    </Tooltip>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
