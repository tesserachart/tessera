import type { FunctionComponent } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { useTileFacts } from '../dock/tileSettingsUi.ts';

export function flowTitle(symbol: string, word: string): string {
  return symbol ? `${symbol} · ${word}` : word;
}

export function flowTab(word: string): FunctionComponent<IDockviewPanelHeaderProps> {
  function FlowTab({ api }: IDockviewPanelHeaderProps) {
    const note = useTileFacts(api.id).note ?? null;
    const title = api.title ?? word;
    const tail = ` · ${word}`;
    const approx = note ? (
      <span className="dock-tab-note" title={`≈ ${note}`} aria-label={note}>
        ≈
      </span>
    ) : null;
    if (!title.endsWith(tail))
      return (
        <span className="dock-tab-title">
          {title}
          {approx}
        </span>
      );
    return (
      <span className="dock-tab-title" title={title}>
        <b>{title.slice(0, -tail.length)}</b>
        <span className="sep">{' · '}</span>
        {word}
        {approx}
      </span>
    );
  }
  FlowTab.displayName = `FlowTab(${word})`;
  return FlowTab;
}
