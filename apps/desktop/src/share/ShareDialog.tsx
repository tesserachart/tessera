import { Button, Dialog, DialogContent, TextInput } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { openExternal } from '../app/host.ts';
import { closeShare, createLink, useShareFlow, type ShareFlow } from './store.ts';

const TITLE = 'Share chart';

export const LEFT_OUT_WORDS = 'Orders, positions and P/L are left out. Nothing is shared until you create a link.';

function Preview({ src }: { src: string | null }) {
  return src ? (
    <img className="sh-preview" src={src} alt="The picture of the chart that is shared" />
  ) : (
    <div className="sh-preview is-taking" aria-hidden="true" />
  );
}

function Shared({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sh-link" data-share-link={url}>
      <TextInput readOnly value={url} aria-label="Link" onFocus={(e) => e.currentTarget.select()} />
      <Button
        size="s"
        onClick={() =>
          void navigator.clipboard
            .writeText(url)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
      >
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <Button size="s" variant="quiet" onClick={() => void openExternal(url)}>
        Open
      </Button>
    </div>
  );
}

interface Body {
  preview: string | null;
  line: string;
  actions: ReactNode;
}

const cancel = (
  <Button variant="quiet" onClick={closeShare}>
    Cancel
  </Button>
);

function body(flow: Exclude<ShareFlow, { kind: 'closed' }>): Body {
  switch (flow.kind) {
    case 'taking':
      return { preview: null, line: 'Picturing the chart…', actions: cancel };
    case 'ready':
      return {
        preview: flow.preview,
        line: LEFT_OUT_WORDS,
        actions: (
          <>
            {cancel}
            <Button variant="primary" autoFocus onClick={() => void createLink()}>
              Create link
            </Button>
          </>
        ),
      };
    case 'sending':
      return { preview: flow.preview, line: 'Making a link…', actions: null };
    case 'shared':
      return {
        preview: flow.preview,
        line: 'Anyone with the link can see this picture. It isn’t listed anywhere. Delete it in Settings › App.',
        actions: (
          <Button variant="primary" onClick={closeShare}>
            Done
          </Button>
        ),
      };
    case 'failed':
      return {
        preview: null,
        line: flow.why,
        actions: (
          <Button variant="primary" onClick={closeShare}>
            Close
          </Button>
        ),
      };
  }
}

export function ShareDialog() {
  const flow = useShareFlow();
  if (flow.kind === 'closed') return null;
  const { preview, line, actions } = body(flow);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeShare())}>
      <DialogContent className="sh-dialog" title={TITLE} data-share-flow={flow.kind}>
        <div className="ui-dialog-body sh-body">
          {flow.kind === 'failed' ? null : <Preview src={preview} />}
          <p className="sh-line" role="status">
            {line}
          </p>
          {flow.kind === 'shared' ? <Shared url={flow.link.url} /> : null}
          {actions ? <div className="sh-acts">{actions}</div> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
