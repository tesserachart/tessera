import type { AgentSessionSummary } from '@tessera/protocol';
import { normalizeEpochMs } from '@tessera/protocol';
import { useNow } from '../app/runtimeContext.ts';
import { focusComposer } from '../shell/composer.ts';
import { relTime } from '../shell/sessions.ts';
import { setComposerDraft } from '../state/ui.ts';
import { briefLabel, briefPrompt, resumable, starters, tradingDayStart } from './activity.ts';
import { useAnalyst, selectSession } from './analystStore.ts';
import { useChartSight } from './sight.ts';
import { zonedFormat } from '../state/timeZone.ts';

export function ChartOpening({ session }: { session: AgentSessionSummary | null }) {
  const sight = useChartSight();
  return (
    <Opening
      symbol={sight.symbol}
      tf={sight.tf}
      words={sight.words}
      last={session ? normalizeEpochMs(session.updatedAt) : null}
      levels={sight.levels}
      current={session?.id ?? null}
    />
  );
}

const DAY = zonedFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function dayWords(ms: number): string {
  return DAY().format(ms).replace(',', '');
}

export function Brief({ symbol, last }: { symbol: string | null; last: number | null }) {
  const now = useNow();
  const label = briefLabel(symbol, last, tradingDayStart(now));
  if (!label || !symbol) return null;
  return (
    <div className="cx-follow" role="list" aria-label="Follow-ups">
      <button
        type="button"
        role="listitem"
        onClick={() => {
          setComposerDraft(briefPrompt(symbol));
          focusComposer();
        }}
      >
        {label}
      </button>
    </div>
  );
}

function Opening({
  symbol,
  tf,
  words,
  last,
  levels,
  current,
}: {
  symbol: string | null;
  tf: string | null;
  words: readonly string[];
  last: number | null;
  levels: boolean;
  current: string | null;
}) {
  const now = useNow();
  const sessions = useAnalyst((s) => s.sessions);
  const list = starters(symbol, { brief: briefLabel(symbol, last, tradingDayStart(now)) !== null, levels });
  const recent = resumable(sessions, current);
  if (list.length === 0 && recent.length === 0) return null;
  return (
    <div className="an-open">
      {symbol ? (
        <header className="an-open-head">
          <h2 className="m-0 overflow-hidden text-ellipsis font-serif text-nav normal-nums text-t1 whitespace-nowrap">
            {dayWords(now)}
            <span className="text-t3"> · </span>
            {symbol}
            {tf ? ` ${tf}` : null}
          </h2>
          {words.length > 0 ? <p>{words.join(' · ')}</p> : null}
        </header>
      ) : null}
      {list.length > 0 ? (
        <ul className="an-starters" aria-label="Ask the analyst">
          {list.map((st) => (
            <li key={st.label}>
              <button
                type="button"
                onClick={() => {
                  setComposerDraft(st.prompt);
                  focusComposer();
                }}
              >
                <span className="q">{st.label}</span>
                <span className="n">{st.note}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {recent.length > 0 ? (
        <section className="an-recent" aria-label="Recent sessions">
          <h3>Recent</h3>
          <ul>
            {recent.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => selectSession(s.id)}>
                  <span className="q">{s.title}</span>
                  <span className="n">{relTime(s.updatedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
