import { Avatar, Button, ConfirmButton, ScrollArea, SettingsRow, SettingsSection } from '@tessera/ui';
import { LEGAL_PAGES } from '@tessera/ui/legal';
import { checkAgain, signIn, signOut, useAccount, useAccountsOn } from '../../account/account.ts';
import { acceptedWords, openLegal, useTermsAccepted } from '../../account/terms.ts';
import { useClock } from '../../app/clock.ts';
import { useAccountAction } from './hooks.ts';
import { profileView, type ProfileView } from './model.ts';

type Action = ReturnType<typeof useAccountAction>;

function Who({ view }: { view: Extract<ProfileView, { kind: 'signed-in' }> }) {
  return (
    <header className="pf-who">
      <Avatar initial={view.initial} size="l" className="text-t1" />
      <div className="pf-names">
        <h2 className="pf-name" data-selectable>
          {view.name}
        </h2>
        {view.email ? (
          <p className="pf-email" data-selectable>
            {view.email}
          </p>
        ) : null}
      </div>
    </header>
  );
}

function Account({ view, action }: { view: Extract<ProfileView, { kind: 'signed-in' }>; action: Action }) {
  const { busy, failed, run } = action;
  const access = view.access;
  const terms = useTermsAccepted();
  return (
    <SettingsSection title="Account" aria-label="Account">
      {access ? (
        <SettingsRow label="Alpha access" help={access.help} error={failed?.action === 'check' ? failed.text : null}>
          <span className="pf-value">
            <span className="pf-fact" data-selectable>
              {access.word}
            </span>
            {access.checkAgain ? (
              <Button
                size="s"
                variant="secondary"
                disabled={busy || access.checking}
                onClick={() => run('check', checkAgain)}
              >
                {access.checking ? 'Checking…' : 'Check again'}
              </Button>
            ) : null}
          </span>
        </SettingsRow>
      ) : null}
      <SettingsRow label="Terms" help={acceptedWords(terms)}>
        <span className="pf-value">
          {LEGAL_PAGES.map((p) => (
            <Button key={p.path} size="s" variant="quiet" onClick={() => void openLegal(p.path).catch(() => undefined)}>
              {p.title}
            </Button>
          ))}
        </span>
      </SettingsRow>
      <SettingsRow label="Sign out" error={failed?.action === 'sign-out' ? failed.text : null}>
        <ConfirmButton
          question="Sign out of Tessera on this machine?"
          disabled={busy}
          onConfirm={() => run('sign-out', signOut)}
        >
          Sign out
        </ConfirmButton>
      </SettingsRow>
    </SettingsSection>
  );
}

function SignIn({ view, action }: { view: Extract<ProfileView, { kind: 'signed-out' }>; action: Action }) {
  const { busy, failed, run } = action;
  const note = failed?.action === 'sign-in' ? failed.text : view.note;
  return (
    <header className="pf-sign-in">
      <h2 className="pf-name">{view.say}</h2>
      <p className="pf-email">{view.line}</p>
      {note ? (
        <p className="pf-note" role="status" data-selectable>
          {note}
        </p>
      ) : null}
      <div className="pf-acts">
        <Button variant="primary" disabled={busy} onClick={() => run('sign-in', signIn)}>
          {view.action}
        </Button>
      </div>
    </header>
  );
}

export function ProfilePage() {
  const on = useAccountsOn() === true;
  const state = useAccount(on);
  const clock = useClock();
  const action = useAccountAction();
  const view: ProfileView = on ? profileView(state, clock.now()) : { kind: 'wait' };
  return (
    <section className="ar-page pf-page" aria-label="Profile">
      <header className="ar-head" data-tauri-drag-region>
        <h1 className="ar-title">Profile</h1>
      </header>
      <ScrollArea className="pf-body">
        <div className="pf-col">
          {view.kind === 'signed-in' ? (
            <>
              <Who view={view} />
              <Account view={view} action={action} />
            </>
          ) : view.kind === 'signed-out' ? (
            <SignIn view={view} action={action} />
          ) : null}
        </div>
      </ScrollArea>
    </section>
  );
}
