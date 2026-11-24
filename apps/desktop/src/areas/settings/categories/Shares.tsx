import type { ShareLink } from '@tessera/protocol';
import { Button, ConfirmDialog, SettingsRow } from '@tessera/ui';
import { useState } from 'react';
import { useAccount } from '../../../account/account.ts';
import { openExternal } from '../../../app/host.ts';
import { useNow } from '../../../app/runtimeContext.ts';
import { failureText, runTool, useToolValue } from '../../../app/tools.ts';
import { screenWords } from '../../../shell/deskWords.ts';
import { canShare, sharedOnWords } from '../../../share/model.ts';
import { SHARE_LIST } from '../../../share/store.ts';
import { useDisplayZone } from '../../../state/timeZone.ts';
import { Section } from '../parts.tsx';

const DELETE_FAILED = 'The link couldn’t be deleted. Try again in a moment.';

function ShareRow({ share, zone, now }: { share: ShareLink; zone: string; now: number }) {
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const remove = () => {
    setWhy(null);
    runTool('share.delete', { id: share.id }, { refresh: [SHARE_LIST] }).catch((e: unknown) =>
      setWhy(screenWords(failureText(e), DELETE_FAILED)),
    );
  };
  return (
    <SettingsRow
      data-setting={`app.share.${share.id}`}
      data-share-id={share.id}
      label={share.title}
      help={why ?? `Shared ${sharedOnWords(share.createdAt, zone, now)}`}
    >
      <Button
        size="s"
        variant="quiet"
        onClick={() =>
          void navigator.clipboard
            .writeText(share.url)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
      >
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <Button size="s" variant="quiet" onClick={() => void openExternal(share.url)}>
        Open
      </Button>
      <Button size="s" variant="destructive" onClick={() => setAsking(true)}>
        Delete
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Delete this link?"
        description={`${share.title} stops opening for everyone who has the link. This can’t be undone.`}
        confirmLabel="Delete link"
        onConfirm={remove}
      />
    </SettingsRow>
  );
}

export function SharesSection() {
  const on = canShare(useAccount());
  const list = useToolValue('share.list', on ? {} : null, { keepFor: 10_000 });
  const zone = useDisplayZone();
  const now = useNow();
  if (!on || !list?.available) return null;
  return (
    <Section id="app.shares">
      {list.shares.length === 0 ? (
        <SettingsRow data-setting="app.sharesNone" label="Nothing shared yet" help="Share a chart from its menu." />
      ) : (
        list.shares.map((share) => <ShareRow key={share.id} share={share} zone={zone} now={now} />)
      )}
    </Section>
  );
}
