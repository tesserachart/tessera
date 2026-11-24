import { Button, Icon } from '@tessera/ui';
import { useState } from 'react';
import { GetProvider } from './GetProvider.tsx';
import { SignInControls } from './SignIn.tsx';
import { signInLine, useSignIn } from './signInState.ts';
import { connectState, connectWord } from './connect.ts';
import { providerIcon, type ProviderView } from './models.ts';
import { setProviderEnabled, useProviders } from './providers.ts';

function ConnectRow({ p }: { p: ProviderView }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = connectState(p);
  const signIn = useSignIn(p.id, p.name, setErr);
  return (
    <li
      data-provider={p.id}
      data-state={s.kind}
      className="[&_.ag-signin-code]:col-2 [&_.ag-signin-code]:[justify-self:start] [&_.ag-signin-code]:mt-2 [&_.ag-signin-code_.t-btn]:mt-0 [&_.t-btn]:col-2 [&_.t-btn]:[justify-self:start] [&_.t-btn]:mt-2"
    >
      <Icon name={providerIcon(p.id)} />
      <b>{p.name}</b>
      <span>
        {err ??
          (s.kind === 'ready' && s.account
            ? `Ready · ${s.account}`
            : ((s.kind === 'signed-out' ? signInLine(signIn) : null) ?? connectWord(s)))}
      </span>
      {s.kind === 'off' ? (
        <Button
          size="s"
          disabled={busy}
          aria-label={`Turn on ${p.name}`}
          onClick={() => {
            setBusy(true);
            void setProviderEnabled(p.id, true).then((why) => {
              setErr(why);
              setBusy(false);
            });
          }}
        >
          Turn on
        </Button>
      ) : null}
      {s.kind === 'missing' ? <GetProvider id={p.id} name={p.name} s={s} onError={setErr} /> : null}
      {s.kind === 'signed-out' ? <SignInControls s={signIn} /> : null}
    </li>
  );
}

export function ConnectAi({ onSkip, waiting = false }: { onSkip?: () => void; waiting?: boolean }) {
  const { views } = useProviders();
  if (views.length === 0) return null;
  return (
    <section className="ag-connect" aria-label="Turn on the analyst">
      <h2 className="ag-connect-title">Turn on the analyst</h2>
      <p className="lead">It runs on your own Claude Code or Codex.</p>
      {waiting ? (
        <p className="ag-connect-wait" role="status">
          Your question waits here. Turn one on, then send it.
        </p>
      ) : null}
      <ul>
        {views.map((p) => (
          <ConnectRow key={p.id} p={p} />
        ))}
      </ul>
      {onSkip ? (
        <Button size="s" variant="quiet" className="ag-connect-skip" onClick={onSkip}>
          Not now
        </Button>
      ) : null}
    </section>
  );
}
