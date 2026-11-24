import { Button } from '@tessera/ui';
import { useState } from 'react';
import type { ConnectState } from './connect.ts';
import { InstallButton } from './InstallButton.tsx';
import { installProvider } from './providers.ts';

export function GetProvider({
  id,
  name,
  s,
  onError,
}: {
  id: string;
  name: string;
  s: Extract<ConnectState, { kind: 'missing' }>;
  onError: (why: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      {s.installs ? (
        <Button
          size="s"
          disabled={busy}
          aria-label={`Install ${name}`}
          onClick={() => {
            setBusy(true);
            onError(null);
            void installProvider(id).then((why) => {
              setBusy(false);
              onError(why);
            });
          }}
        >
          {busy ? 'Installing…' : 'Install'}
        </Button>
      ) : null}
      {s.page ? <InstallButton url={s.page} name={name} download={!s.installs} /> : null}
    </>
  );
}
