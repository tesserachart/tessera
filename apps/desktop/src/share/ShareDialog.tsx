import type { ShareImageInput } from '@tessera/protocol';
import { Button, Dialog, DialogContent, Switch, TextInput, Tooltip } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { useAccount } from '../account/account.ts';
import { openExternal } from '../app/host.ts';
import { ConversationPreview } from './ConversationPreview.tsx';
import { canShare } from './model.ts';
import { copyPicture } from './picture.ts';
import { closeShare, createLink, showPnl, useShareFlow, type Share, type ShareFlow } from './store.ts';
import { flowLines, shareTitle, waitWords } from './words.ts';

type OpenFlow = Exclude<ShareFlow, { step: 'closed' }>;

function Preview({ src }: { src: string | null }) {
  return src ? (
    <img className="sh-preview" src={src} alt="The picture of the chart that is shared" />
  ) : (
    <div className="sh-preview is-taking" aria-hidden="true" />
  );
}

function LinkRow({ url }: { url: string }) {
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

function CopyPicture({ image, primary, why }: { image: ShareImageInput | null; primary: boolean; why: string | null }) {
  const [said, setSaid] = useState<'Copy picture' | 'Copied' | 'Couldn’t copy'>('Copy picture');
  return (
    <Waits why={image ? null : why}>
      <Button
        variant={primary ? 'primary' : 'secondary'}
        disabled={!image}
        onClick={() => {
          if (!image) return;
          copyPicture(image).then(
            () => setSaid('Copied'),
            () => setSaid('Couldn’t copy'),
          );
        }}
      >
        {said}
      </Button>
    </Waits>
  );
}

function Waits({ why, children }: { why: string | null; children: ReactNode }) {
  return why ? (
    <Tooltip content={why}>
      <span>{children}</span>
    </Tooltip>
  ) : (
    children
  );
}

function Subject({ share, step }: { share: Share; step: OpenFlow['step'] }) {
  switch (share.subject) {
    case 'chart':
      return <Preview src={share.picture?.preview ?? null} />;
    case 'conversation':
      return (
        <>
          <ConversationPreview page={share.page} />
          {step === 'ready' || step === 'preparing' ? (
            <Switch className="sh-pnl" checked={share.showPnl} onCheckedChange={(on) => void showPnl(on)}>
              Show P/L
            </Switch>
          ) : null}
        </>
      );
    case 'setup':
      return <p className="sh-name">{share.name}</p>;
  }
}

function Actions({ flow, canLink }: { flow: OpenFlow; canLink: boolean }) {
  const why = waitWords(flow);
  const picture = flow.share.subject === 'chart' ? (flow.share.picture?.input.image ?? null) : null;
  const copy = flow.share.subject === 'chart';
  if (flow.step === 'failed')
    return (
      <Button variant="primary" onClick={closeShare}>
        Close
      </Button>
    );
  if (flow.step === 'shared')
    return (
      <>
        {copy ? <CopyPicture image={picture} primary={false} why={null} /> : null}
        <Button variant="primary" onClick={closeShare}>
          Done
        </Button>
      </>
    );
  return (
    <>
      {flow.step === 'sending' ? null : (
        <Button variant="quiet" onClick={closeShare}>
          {canLink || !copy ? 'Cancel' : 'Close'}
        </Button>
      )}
      {copy ? <CopyPicture image={picture} primary={!canLink} why={why} /> : null}
      {canLink ? (
        <Waits why={why}>
          <Button
            variant="primary"
            autoFocus={flow.step === 'ready'}
            disabled={flow.step !== 'ready'}
            onClick={() => void createLink()}
          >
            Create link
          </Button>
        </Waits>
      ) : null}
    </>
  );
}

export function ShareDialog() {
  const flow = useShareFlow();
  const canLink = canShare(useAccount());
  if (flow.step === 'closed') return null;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeShare())}>
      <DialogContent
        className="sh-dialog"
        title={shareTitle(flow.share)}
        data-share-flow={flow.step}
        data-share-subject={flow.share.subject}
      >
        <div className="ui-dialog-body sh-body">
          {flow.step === 'failed' ? null : <Subject share={flow.share} step={flow.step} />}
          <div className="sh-lines" role="status">
            {flowLines(flow, canLink).map((line) => (
              <p key={line} className="sh-line">
                {line}
              </p>
            ))}
          </div>
          {flow.step === 'shared' ? <LinkRow url={flow.link.url} /> : null}
          <div className="sh-acts">
            <Actions flow={flow} canLink={canLink} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
