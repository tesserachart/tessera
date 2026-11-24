import { Icon } from '@tessera/ui';
import type { ReactNode } from 'react';
import { RowCtx, type RowContext } from '../areas/agents/rowContext.ts';
import { TimelineRow } from '../areas/agents/Rows.tsx';
import type { Row } from '../areas/agents/timeline.ts';

const SAMPLE_ROWS: readonly Row[] = [
  {
    kind: 'user',
    key: 'ask',
    text: 'Where is the gamma flip today, and is price trading above it?',
    attachments: [],
  },
  {
    kind: 'assistant',
    key: 'answer',
    text:
      'The flip sits near 20,100, about forty points under the last trade, so price is above it and dealers are long gamma.\n\n' +
      'That usually means tighter ranges: rallies into the call wall at 20,250 tend to stall, and dips toward the flip tend to get bought until it breaks.',
    blocks: [],
    streaming: false,
    answer: false,
  },
  {
    kind: 'user',
    key: 'follow',
    text: 'What would change that read?',
    attachments: [],
  },
];

const SAMPLE_CTX: RowContext = {
  toggle: () => undefined,
  renderApproval: () => null,
  onFollowUp: () => undefined,
  onRetry: undefined,
  retryKey: null,
  tools: null,
};

function ComposerSample() {
  return (
    <div className="ag-compose is-narrow">
      <textarea rows={1} placeholder="Ask, or type an order" readOnly tabIndex={-1} />
      <div className="ag-compose-foot">
        <button type="button" className="ag-attach" tabIndex={-1}>
          <Icon name="attach" />
        </button>
        <button type="button" className="ag-ctl ag-model" tabIndex={-1}>
          <span className="tt">GPT-5 Codex</span>
          <Icon name="chevron-down" className="cv" />
        </button>
        <button type="button" className="ag-ctl ag-effort" tabIndex={-1}>
          <span className="tt">Medium</span>
          <Icon name="chevron-down" className="cv" />
        </button>
        <button type="button" className="ag-send" tabIndex={-1}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}

export function AnalystSample({ head }: { head?: ReactNode }) {
  return (
    <section className="an">
      {head}
      <div className="an-body">
        <div className="ag-conv is-narrow">
          <div className="ag-history">
            <div className="ag-scroll">
              <RowCtx.Provider value={SAMPLE_CTX}>
                {SAMPLE_ROWS.map((row) => (
                  <div key={row.key} className="ag-lane">
                    <TimelineRow row={row} />
                  </div>
                ))}
              </RowCtx.Provider>
            </div>
          </div>
        </div>
      </div>
      <ComposerSample />
    </section>
  );
}
