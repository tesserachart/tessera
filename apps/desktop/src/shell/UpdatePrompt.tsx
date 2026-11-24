import type { UpdateFound } from '@tessera/bridge';
import { Button, cx } from '@tessera/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { askToUpdate, dismissUpdateError, promptView, retryUpdate, updateLater, useUpdate } from '../app/updates.ts';

const CARD =
  'absolute right-3 bottom-[calc(var(--control-h)+var(--spacing)*3)] z-(--z-sticky) flex w-[320px] max-w-[calc(100%-var(--spacing)*6)] flex-col gap-2 border border-line-2 bg-panel p-3 [--overlay-from:0_6px] motion-safe:animate-[t-overlay-in_var(--dur-panel-in)_var(--ease-out-strong)]';

function Available({ update }: { update: UpdateFound }) {
  const notes = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  const [all, setAll] = useState(false);
  useLayoutEffect(() => {
    const node = notes.current;
    if (node && !all) setClamped(node.scrollHeight > node.clientHeight + 1);
  }, [update.notes, all]);
  return (
    <section role="region" aria-label="Update" className={CARD}>
      <p className="text-body text-t1">Tessera {update.version} is available</p>
      {update.notes ? (
        <p
          ref={notes}
          className={cx('whitespace-pre-line text-meta text-t2', all ? 'max-h-48 overflow-auto' : 'line-clamp-2')}
        >
          {update.notes}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {clamped && !all ? (
          <Button variant="quiet" className="mr-auto" onClick={() => setAll(true)}>
            Show all
          </Button>
        ) : null}
        <Button variant="quiet" onClick={updateLater}>
          Later
        </Button>
        <Button variant="primary" onClick={askToUpdate}>
          Update
        </Button>
      </div>
    </section>
  );
}

export function UpdatePrompt() {
  const view = promptView(useUpdate());
  if (!view) return null;
  if (view.kind === 'check_failed') {
    return (
      <section role="region" aria-label="Update" className={CARD}>
        <p className="text-body text-t1">Couldn’t check for updates.</p>
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={dismissUpdateError}>
            Dismiss
          </Button>
          <Button onClick={() => void retryUpdate()}>Try again</Button>
        </div>
      </section>
    );
  }
  return <Available key={view.update.version} update={view.update} />;
}
