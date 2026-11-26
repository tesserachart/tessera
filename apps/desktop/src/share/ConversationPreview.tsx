import type { SharedConversation, SharedTurn } from '@tessera/protocol';
import { Icon, ScrollArea } from '@tessera/ui';
import { Markdown } from '../areas/agents/Markdown.tsx';
import { toolIcon } from '../areas/agents/toolIcon.ts';
import { Result } from '../shell/AgentTranscript.tsx';
import { filesWords, workMeta, workWords } from './conversation.ts';
import '../areas/agents/agents.css';

function Turn({ turn }: { turn: SharedTurn }) {
  if (turn.role === 'user') {
    const files = filesWords(turn.files);
    return (
      <div className="ag-you">
        {turn.text ? <div className="bubble">{turn.text}</div> : null}
        {files ? <p className="sh-files">{files}</p> : null}
      </div>
    );
  }
  return (
    <div className="ag-say">
      {turn.work.length > 0 ? (
        <details className="sh-work">
          <summary className="ag-line">
            <span className="lb">{workWords(turn)}</span>
          </summary>
          {turn.work.map((w, i) => {
            const meta = workMeta(w);
            return (
              <div key={i} className="ag-entry" data-depth={1} data-tone={w.failed ? 'failed' : undefined}>
                <div className="ag-line">
                  <Icon name={toolIcon(w.ns)} className="gl" />
                  <span className="lb">{w.label}</span>
                  {meta ? <span className="mt">{meta}</span> : null}
                </div>
              </div>
            );
          })}
        </details>
      ) : null}
      {turn.answer ? <Markdown text={turn.answer} /> : null}
      {turn.blocks.map((b, i) => (
        <Result key={i} block={{ ...b, sourceCallId: null }} />
      ))}
    </div>
  );
}

export function ConversationPreview({ page }: { page: SharedConversation | null }) {
  if (!page) return <div className="sh-convo is-taking" aria-hidden="true" />;
  return (
    <ScrollArea className="sh-convo" role="region" aria-label="The conversation as it is shared">
      <div className="sh-convo-page">
        <p className="sh-convo-title">{page.title}</p>
        {page.turns.map((turn, i) => (
          <Turn key={i} turn={turn} />
        ))}
      </div>
    </ScrollArea>
  );
}
