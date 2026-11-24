import type { TradingSessionReport } from '@tessera/protocol';
import { Button, ChatCard, ChatCardRow } from '@tessera/ui';
import type { ReactNode } from 'react';
import { openExternal } from '../../app/host.ts';
import { Markdown } from '../../areas/agents/Markdown.tsx';
import { issueWords, sessionMeta, sessionTitle, tradeLabel, tradeMark, tradeWords } from './session.ts';

export function TradingSessionCard({ body, actions }: { body: TradingSessionReport; actions: ReactNode }) {
  return (
    <ChatCard
      className="cc-session"
      state="done"
      title={sessionTitle(body)}
      meta={sessionMeta(body)}
      detail={<Markdown text={body.log} />}
      detailLabel="Its log"
      actions={actions}
    >
      {body.trades.map((t) => (
        <ChatCardRow key={t.id} mark={tradeMark(t)} label={tradeLabel(t)} value={tradeWords(t)} />
      ))}
      {body.issues.map((i) => (
        <ChatCardRow
          key={i.title}
          mark="failed"
          label={i.title}
          value={
            i.url ? (
              <Button size="s" variant="quiet" onClick={() => void openExternal(i.url!)}>
                {issueWords(i)}
              </Button>
            ) : (
              issueWords(i)
            )
          }
        />
      ))}
    </ChatCard>
  );
}
