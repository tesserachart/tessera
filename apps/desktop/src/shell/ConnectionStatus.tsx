import { StatusDot, Tooltip } from '@tessera/ui';
import { connectionItem } from '../accounts/connections.ts';
import { addConnection, openConnection } from '../accounts/navigate.ts';
import { useHasUserConnectionTools, useListedConnections } from '../accounts/useConnections.ts';
import { dotFor } from './health.ts';
import { useShellData } from './shellData.ts';

const ms = (n: number) => `${String(Math.round(n))} ms`;

export function ConnectionStatus() {
  const can = useHasUserConnectionTools();
  const listed = useListedConnections();
  const { accounts } = useShellData();
  if (!can) return null;
  const items = listed.map((l) => connectionItem(l, accounts)).filter((i) => i.shownInChrome);
  return (
    <nav className="t-conns" aria-label="Connection status">
      {items.length === 0 ? (
        <button type="button" className="t-conn" aria-label="Connect Rithmic" onClick={() => addConnection()}>
          <StatusDot state="off" />
          <span className="nm">Connect Rithmic</span>
        </button>
      ) : (
        items.map((i) => (
          <Tooltip key={i.id} content={`${i.name} · ${i.state}`} side="top">
            <button
              type="button"
              className="t-conn"
              data-status={i.status}
              aria-label={`${i.name}: ${i.state}`}
              onClick={() => openConnection(i.id)}
            >
              <StatusDot state={dotFor(i.status)} />
              <span className="nm">{i.short}</span>
              {i.latencyMs !== null ? <span className="ms">{ms(i.latencyMs)}</span> : null}
            </button>
          </Tooltip>
        ))
      )}
    </nav>
  );
}
