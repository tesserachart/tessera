import { Button, Dialog, DialogContent } from '@tessera/ui';
import { useEffect, useRef, useState, type Ref } from 'react';
import { hasWarnings, restartWords, useRestartWarnings } from '../app/restartWarnings.ts';
import {
  dialogView,
  dismissUpdateError,
  downloadingWords,
  notNow,
  restartAndUpdate,
  retryUpdate,
  useUpdate,
  type DialogView,
} from '../app/updates.ts';

const LEAD = 'Tessera will restart to install it.';

function Progress({ version, fraction }: { version: string; fraction: number | null }) {
  return (
    <div className="mr-auto flex min-w-[200px] flex-col gap-1.5">
      <span className="text-body tabular-nums text-t2" role="status">
        {downloadingWords(version, fraction)}
      </span>
      <div className="h-0.5 overflow-hidden bg-line-2" role="presentation">
        <div
          className="h-full origin-left bg-mist [transition:transform_200ms_var(--ease-out)] motion-reduce:[transition:none]"
          style={{ transform: `scaleX(${String(fraction ?? 0)})` }}
        />
      </div>
    </div>
  );
}

interface BodyProps {
  view: DialogView;
  words: readonly string[];
  onSafe: () => void;
  safe: Ref<HTMLButtonElement>;
  primary: Ref<HTMLButtonElement>;
}

function Body({ view, words, onSafe, safe, primary }: BodyProps) {
  const { phase, update } = view;
  if (phase === 'download_failed' || phase === 'install_failed') {
    return (
      <div className="ui-dialog-body flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-body text-t1">
            {phase === 'download_failed' ? 'The update couldn’t be downloaded.' : 'The update couldn’t be installed.'}
          </p>
          {view.reason ? <p className="text-meta text-t3">{view.reason}</p> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button ref={safe} onClick={onSafe}>
            Close
          </Button>
          <Button ref={primary} variant="primary" onClick={() => void retryUpdate()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const installing = phase === 'installing';
  if (phase === 'downloading') {
    return (
      <div className="ui-dialog-body flex flex-col gap-3">
        <div className="flex items-center justify-end gap-2">
          <Progress version={update.version} fraction={view.fraction} />
          <Button ref={safe} onClick={onSafe}>
            Hide
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="ui-dialog-body flex flex-col gap-3">
      {phase === 'confirm' || phase === 'ready'
        ? words.map((line) => (
            <p key={line} className="text-body text-t2">
              {line}
            </p>
          ))
        : null}
      {installing ? (
        <p className="text-body text-t2">Installing {update.version}. Tessera restarts in a moment.</p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button ref={safe} disabled={installing} onClick={onSafe}>
          Not now
        </Button>
        <Button ref={primary} variant="primary" disabled={installing} onClick={() => void restartAndUpdate()}>
          Restart and update
        </Button>
      </div>
    </div>
  );
}

export function UpdateDialog() {
  const state = useUpdate();
  const live = dialogView(state);
  const warnings = useRestartWarnings();
  const warned = hasWarnings(warnings);
  const [heldState, setHeldState] = useState(state);
  if (live && state !== heldState) setHeldState(state);
  const held = dialogView(heldState);
  const safe = useRef<HTMLButtonElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const phase = live?.phase ?? null;
  useEffect(() => {
    if (phase === 'downloading') safe.current?.focus();
  }, [phase]);
  const leave = () => {
    if (!live || live.phase === 'installing') return;
    if (live.phase === 'download_failed' || live.phase === 'install_failed') dismissUpdateError();
    else notNow();
  };
  return (
    <Dialog open={live !== null} onOpenChange={(open) => (open ? undefined : leave())}>
      {held ? (
        <DialogContent
          className="ui-confirm"
          title={`Update to Tessera ${held.update.version}`}
          description={LEAD}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (warned || !primary.current ? safe : primary).current?.focus();
          }}
        >
          <Body view={held} words={restartWords(warnings)} onSafe={leave} safe={safe} primary={primary} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
