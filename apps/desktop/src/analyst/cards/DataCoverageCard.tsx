import type { DataCoverage } from '@tessera/protocol';
import { ChatCard, ChatCardRow } from '@tessera/ui';
import type { ReactNode } from 'react';
import {
  count,
  dayTitle,
  downloadState,
  downloadWords,
  gaps,
  laneMark,
  laneWords,
  runWords,
  spanWords,
  type Lane,
} from './coverage.ts';

const LANES: readonly { lane: Lane; label: string }[] = [
  { lane: 'prints', label: 'Prints' },
  { lane: 'bars', label: 'Bars' },
];

function Days({ body, lane }: { body: DataCoverage; lane: Lane }) {
  return (
    <span className="cc-days" aria-hidden="true">
      {body.days.map((d) => (
        <i key={d.date} data-held={d[lane]} title={dayTitle(d)} />
      ))}
    </span>
  );
}

export function DataCoverageCard({ body, actions }: { body: DataCoverage; actions: ReactNode }) {
  const missing = LANES.flatMap(({ lane, label }) => gaps(body.days, lane).map((r) => ({ lane, label, r })));
  return (
    <ChatCard
      className="cc-coverage"
      state={downloadState(body.download)}
      title={`${body.symbol} saved data`}
      meta={spanWords(body)}
      progress={body.download ? downloadWords(body.download) : undefined}
      detail={
        missing.length ? (
          <ul className="cc-gaps">
            {missing.map(({ lane, label, r }) => (
              <li key={`${lane}:${r.from}`}>
                <span>{label}</span> {runWords(r)}
              </li>
            ))}
          </ul>
        ) : undefined
      }
      detailLabel="Missing days"
      actions={actions}
    >
      {LANES.map(({ lane, label }) => {
        const c = count(body.days, lane);
        const fetching = lane === 'prints' && body.download?.state === 'running';
        return (
          <ChatCardRow key={lane} mark={fetching ? 'running' : laneMark(c)} label={label} value={laneWords(c)}>
            <Days body={body} lane={lane} />
          </ChatCardRow>
        );
      })}
    </ChatCard>
  );
}
