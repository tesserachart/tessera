import { waitingToRetry } from '@tessera/protocol';
import { StatusLine } from '@tessera/ui';
import { retryNow } from '../app/connection.ts';
import { useHoldings } from '../app/portfolio.ts';
import { useConnection } from '../app/runtimeContext.ts';
import { displaySymbol } from '../market/instruments.ts';
import { useClosedNote } from '../markets/sessions.ts';
import { openConnection } from '../accounts/navigate.ts';
import { useActiveChart, useWorkspace } from '../state/workspace.ts';
import { resetWorkspaceLayout } from '../workspace/controller.ts';
import { useShellData } from './shellData.ts';
import { exposedPositions, healthProblems } from './health.ts';

export function Annunciator() {
  const conn = useConnection();
  const { providers, accounts, accountId } = useShellData();
  const holdings = useHoldings();
  const blocked = useWorkspace((s) => s.blockedLayout);
  const problems = healthProblems(conn, providers);
  const first = problems[0];
  const charted = useActiveChart()?.instrument ?? null;
  const closed = useClosedNote(first || blocked ? null : charted);

  if (!first) {
    if (closed && charted) {
      return (
        <div className="t-annun-slot">
          <StatusLine
            kind="info"
            src={displaySymbol(charted)}
            fact={<span className="t-annun-message">{closed}</span>}
            aria-label="Status"
            className="h-full min-h-0 gap-2 px-3 py-0 [&_.src]:flex-none [&_.src]:max-w-[30%] [&_.src]:overflow-hidden [&_.src]:text-ellipsis"
            title={`${displaySymbol(charted)}: ${closed}`}
          />
        </div>
      );
    }
    if (!blocked) return null;
    const text = `${blocked} could not be loaded by this build. Showing the default; the saved one is kept.`;
    return (
      <div className="t-annun-slot">
        <StatusLine
          kind="info"
          src="Layout"
          fact={<span className="t-annun-message">{text}</span>}
          action={{ label: 'Reset layout', onClick: () => resetWorkspaceLayout() }}
          aria-label="Status"
          className="h-full min-h-0 gap-2 px-3 py-0 [&_.do]:flex-none [&_.more]:flex-none [&_.src]:flex-none [&_.src]:max-w-[30%] [&_.src]:overflow-hidden [&_.src]:text-ellipsis"
          title={text}
        />
      </div>
    );
  }

  const held = (holdings ?? []).filter((p) => accountId === null || p.accountId === accountId);
  const atRisk = exposedPositions(first.key === 'runtime', providers, held, accounts);
  const exposed = atRisk.length > 0;
  const position = atRisk[0];
  const more = problems.length - 1 + (blocked ? 1 : 0);
  const exposure =
    exposed && position
      ? `${position.qty > 0 ? 'Long' : 'Short'} ${String(Math.abs(position.qty))} ${displaySymbol(position.instrument)} open.`
      : null;
  const details = [
    ...problems.map((p) => p.text),
    exposure,
    blocked ? `${blocked} could not be loaded; the saved layout is kept.` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const action =
    first.action === 'retry'
      ? waitingToRetry(conn)
        ? { label: 'Retry now', onClick: retryNow }
        : null
      : first.action === 'connections'
        ? { label: 'Connections', onClick: () => openConnection(first.key) }
        : null;
  return (
    <div className="t-annun-slot">
      <StatusLine
        kind={exposed ? 'exposure' : 'caution'}
        src={first.src}
        fact={<span className="t-annun-message">{first.fact}</span>}
        exposure={exposure ?? undefined}
        next={first.next}
        more={more > 0 ? more : undefined}
        action={action}
        aria-label="Status"
        className="h-full min-h-0 gap-2 px-3 py-0 [&_.do]:flex-none [&_.more]:flex-none [&_.src]:flex-none [&_.src]:max-w-[30%] [&_.src]:overflow-hidden [&_.src]:text-ellipsis"
        data-severity={first.severity}
        title={details}
      />
    </div>
  );
}
