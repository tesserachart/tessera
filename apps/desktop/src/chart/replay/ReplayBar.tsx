import { Button, IconButton, Segmented, TextInput, Tooltip } from '@tessera/ui';
import { useEffect, useState } from 'react';
import { useTool } from '../../app/tools.ts';
import { feedErrorWords } from '../../shell/deskWords.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { backToLive, controlReplay, jumpReplay, liveOf, type ChartTarget } from './actions.ts';
import { REPLAY_SPEEDS, clockText, cursorMs, dayText, earlierText, hasEnded, jumpTarget, speedOf } from './model.ts';

const SPEED_OPTIONS = REPLAY_SPEEDS.map((s) => ({
  value: String(s),
  label: `${String(s)}×`,
  title: `${String(s)} times`,
}));
const TICK_MS = 250;
const RESYNC_MS = 10_000;

function useWallClock(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);
  return now;
}

export function ReplayBar({ target, instrument }: { target: ChartTarget; instrument: string }) {
  const q = useTool('market.get_replays', { instrument }, { keepFor: Infinity, refreshEvery: RESYNC_MS });
  const state = q.data?.replays[0] ?? null;
  const now = useWallClock(state?.playing ?? false);
  const [jump, setJump] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const live = displaySymbol(liveOf(instrument, state));
  const act = (run: Promise<void>) => {
    setFailure(null);
    run.catch((e: unknown) => setFailure(feedErrorWords(e)));
  };
  const back = (
    <Button size="s" variant="quiet" onClick={() => act(backToLive(target, instrument, state))}>
      Back to {live}
    </Button>
  );
  if (!state) {
    return (
      <div className="replay-bar" role="toolbar" aria-label="Replay">
        <span className="replay-what">{q.isError ? 'This replay has closed' : 'Replay'}</span>
        <span className="replay-gap" />
        {back}
      </div>
    );
  }
  const cursor = cursorMs(state, q.dataUpdatedAt, now);
  const ended = hasEnded(state, q.dataUpdatedAt, now);
  const jumpAt = jumpTarget(state, jump);
  const earlier = earlierText(state.earlier);
  const submitJump = () => {
    if (jumpAt === null) return;
    setJump('');
    act(jumpReplay(target, state, jumpAt));
  };
  return (
    <div className="replay-bar" role="toolbar" aria-label="Replay">
      <span className="replay-what">
        Replay <b>{displaySymbol(state.contract)}</b> {dayText(state.tradeDate)}
      </span>
      {earlier ? <span className="text-t3">{earlier}</span> : null}
      <Tooltip content={state.playing && !ended ? 'Pause' : 'Play'}>
        <IconButton
          label={state.playing && !ended ? 'Pause' : 'Play'}
          icon={state.playing && !ended ? 'pause' : 'play'}
          disabled={ended}
          onClick={() => act(controlReplay(state, { playing: !state.playing }))}
        />
      </Tooltip>
      <time className="replay-clock" aria-label="Replay time" dateTime={new Date(cursor).toISOString()}>
        {clockText(cursor)}
      </time>
      <Segmented
        label="Speed"
        options={SPEED_OPTIONS}
        value={String(speedOf(state.speed))}
        onChange={(v) => act(controlReplay(state, { speed: Number(v) }))}
      />
      <TextInput
        size="s"
        className="replay-jump"
        aria-label="Jump to a time"
        aria-invalid={jump !== '' && jumpAt === null}
        placeholder="Jump to 10:30"
        value={jump}
        onChange={(e) => setJump(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitJump();
          if (e.key === 'Escape') setJump('');
        }}
      />
      {failure ? (
        <span className="replay-failure" role="status">
          {failure}
        </span>
      ) : null}
      <span className="replay-gap" />
      {back}
    </div>
  );
}
