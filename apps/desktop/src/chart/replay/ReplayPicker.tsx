import { Dialog, DialogContent, formatInt } from '@tessera/ui';
import { useMemo, useState } from 'react';
import { useTool } from '../../app/tools.ts';
import { feedErrorWords } from '../../shell/deskWords.ts';
import { useStore } from '../../app/store.ts';
import { displaySymbol, replayedContract } from '../../market/instruments.ts';
import { closeReplayPicker, replayDesk, startReplay, type ChartTarget } from './actions.ts';
import { dayChoices, dayText } from './model.ts';

export function ReplayPicker({ target, charted }: { target: ChartTarget; charted: string }) {
  const open = useStore(replayDesk, (d) => d.picker?.layoutId === target.layoutId && d.picker.tileId === target.tileId);
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : closeReplayPicker())}>
      {open ? <PickerBody target={target} charted={charted} /> : null}
    </Dialog>
  );
}

function PickerBody({ target, charted }: { target: ChartTarget; charted: string }) {
  const q = useTool('market.list_replay_days', {});
  const contract = replayedContract(charted) ?? charted;
  const days = useMemo(() => (q.data ? dayChoices(q.data, contract) : []), [q.data, contract]);
  const [failure, setFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  return (
    <DialogContent className="replay-picker" title="Replay a saved day">
      {q.isError ? <p className="replay-note">{feedErrorWords(q.error)}</p> : null}
      {q.isSuccess && days.length === 0 ? (
        <p className="replay-note">No day is saved yet. A chart saves the trades it shows.</p>
      ) : null}
      <ul className="replay-days" aria-label="Saved days">
        {days.map((d) => (
          <li key={d.key}>
            <button
              type="button"
              disabled={starting !== null}
              aria-busy={starting === d.key}
              onClick={() => {
                setStarting(d.key);
                setFailure(null);
                startReplay(target, d, charted)
                  .then(closeReplayPicker)
                  .catch((e: unknown) => setFailure(feedErrorWords(e)))
                  .finally(() => setStarting(null));
              }}
            >
              <b>{displaySymbol(d.instrument)}</b>
              <span>{dayText(d.tradeDate)}</span>
              <span className="replay-prints">{formatInt(d.prints)} prints</span>
            </button>
          </li>
        ))}
      </ul>
      {failure ? (
        <p className="replay-note" role="status">
          {failure}
        </p>
      ) : null}
    </DialogContent>
  );
}
