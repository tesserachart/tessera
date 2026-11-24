import { Button, Dialog, DialogContent } from '@tessera/ui';
import { useEffect } from 'react';
import { appHost } from '../app/services.ts';
import { useHasTool } from '../app/tools.ts';
import { useStore } from '../app/store.ts';
import { arrivalStore } from '../shell/arrival.ts';
import {
  answerLeave,
  checkRecovered,
  confirmQuit,
  documentStore,
  keepRecovered,
  leaveWords,
  recoveredWords,
  revertRecovered,
} from '../workspace/document.ts';

function LeaveDialog() {
  const ask = useStore(documentStore, (s) => s.ask);
  const words = ask ? leaveWords(ask) : null;
  return (
    <Dialog open={ask !== null} onOpenChange={(o) => (o ? undefined : answerLeave('cancel'))}>
      {words ? (
        <DialogContent className="ws-dialog" title={words.title} description={words.description}>
          <div className="ui-dialog-body ws-acts ws-acts-split">
            <Button variant="quiet" onClick={() => answerLeave('discard')}>
              Don’t save
            </Button>
            <span className="ws-acts-end">
              <Button variant="quiet" onClick={() => answerLeave('cancel')}>
                Cancel
              </Button>
              <Button variant="primary" autoFocus onClick={() => answerLeave('save')}>
                Save
              </Button>
            </span>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function RecoveredDialog() {
  const arrived = useStore(arrivalStore, (s) => s.arrived);
  const recovered = useStore(documentStore, (s) => (arrived ? s.recovered : null));
  const words = recovered ? recoveredWords(recovered) : null;
  const canList = useHasTool('layout.list');
  useEffect(() => {
    if (canList) void checkRecovered();
  }, [canList]);
  return (
    <Dialog open={recovered !== null} onOpenChange={(o) => (o ? undefined : keepRecovered())}>
      {words ? (
        <DialogContent className="ws-dialog" title={words.title} description={words.description}>
          <div className="ui-dialog-body ws-acts">
            <Button
              variant="quiet"
              onClick={() =>
                void revertRecovered().catch((err: unknown) => console.warn('[workspace] not reverted', err))
              }
            >
              Revert to saved
            </Button>
            <Button variant="primary" autoFocus onClick={keepRecovered}>
              Keep changes
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function WorkspaceDialogs() {
  useEffect(() => appHost().guardClose(confirmQuit), []);
  return (
    <>
      <LeaveDialog />
      <RecoveredDialog />
    </>
  );
}
