import type { ProviderHealth, SessionMode } from '@tessera/protocol';
import { Button, FormHint, FormRow, FormSection, Segmented, Sheet, SheetContent } from '@tessera/ui';
import { useState } from 'react';
import { useHasTool } from '../app/tools.ts';
import { ConnectAi } from '../areas/agents/ConnectAi.tsx';
import { InstallButton } from '../areas/agents/InstallButton.tsx';
import { SignInControls } from '../areas/agents/SignIn.tsx';
import { useSignIn } from '../areas/agents/signInState.ts';
import { installPage } from '../areas/agents/models.ts';
import { NumberSetting } from '../areas/settings/NumberSetting.tsx';
import { useSettingInfos } from '../state/runtimeSettings.ts';
import { setSessionMode, startSession } from './actions.ts';
import { useAnalyst, useCurrentSession, setSheet } from './analystStore.ts';
import { useModeChange } from './modeChange.tsx';
import { MODES, modeInfo } from './modes.ts';

const GUARDS: { key: string; label: string; unit?: string }[] = [
  { key: 'agent.maxStepsPerTurn', label: 'Steps in one turn, at most' },
  { key: 'agent.maxToolCallsPerTurn', label: 'Tool calls in one turn, at most' },
  { key: 'approvals.staleAfterSeconds', label: 'A draft goes stale after', unit: 's' },
  { key: 'approvals.staleAfterTicks', label: 'or after this many trades', unit: 'trades' },
];

function modelHint(p: ProviderHealth, inUse: boolean, model: string | null): string | undefined {
  if (p.status === 'ok') return inUse ? (model ?? undefined) : (p.message ?? undefined);
  const why = p.message ?? (p.status === 'disconnected' ? 'Not signed in' : 'Not available');
  const codex = /codex/i.test(p.providerId);
  if (installPage(p.providerId, p.status, p.message))
    return codex
      ? `${why}. Install the Codex CLI and sign in with your ChatGPT account; it connects here by itself.`
      : `${why}. Install it and sign in; it connects here by itself.`;
  if (p.status === 'disconnected') return `${why}. Sign in, then finish in your browser; it connects here by itself.`;
  return why;
}

function SignInFor({ p, onError }: { p: ProviderHealth; onError: (text: string) => void }) {
  const s = useSignIn(p.providerId, p.displayName, (why) => {
    if (why) onError(why);
  });
  return <SignInControls s={s} />;
}

function Models({ onError }: { onError: (text: string) => void }) {
  const providers = useAnalyst((s) => s.providers);
  const session = useCurrentSession();
  const canStart = useHasTool('agent.start_session');
  const canList = useHasTool('agent.list_providers');
  const canSignIn = useHasTool('agent.sign_in');
  const models = providers.filter((p) => p.kind === 'agent');
  const [busy, setBusy] = useState<string | null>(null);
  if (models.length === 0) {
    return (
      <FormSection title="Model">
        {canList ? (
          <ConnectAi />
        ) : (
          <FormHint>
            This runtime has no model to offer. The analyst uses your own Codex (ChatGPT) or Claude Code sign-in.
          </FormHint>
        )}
      </FormSection>
    );
  }
  const use = async (p: ProviderHealth) => {
    setBusy(p.providerId);
    try {
      await startSession(p.providerId);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <FormSection
      title="Model"
      description="Your own subscription, through its CLI. Another provider starts a new session."
    >
      {models.map((p) => {
        const inUse = session ? session.provider === p.providerId : false;
        const install = installPage(p.providerId, p.status, p.message);
        return (
          <FormRow key={p.providerId} label={p.displayName} hint={modelHint(p, inUse, session?.model ?? null)}>
            {inUse ? (
              <span className="an-inuse">In use</span>
            ) : p.status === 'ok' ? (
              <Button size="s" disabled={!canStart || busy !== null} onClick={() => void use(p)}>
                {busy === p.providerId ? 'Starting…' : session ? 'Switch' : 'Use'}
              </Button>
            ) : install ? (
              <InstallButton url={install} name={p.displayName} />
            ) : p.status === 'disconnected' && canSignIn ? (
              <SignInFor p={p} onError={onError} />
            ) : null}
          </FormRow>
        );
      })}
    </FormSection>
  );
}

function Permissions({ onError }: { onError: (text: string) => void }) {
  const session = useCurrentSession();
  const canSet = useHasTool('agent.set_mode');
  const mode: SessionMode = session?.mode ?? 'supervised';
  const current = modeInfo(mode);
  const { request, dialog } = useModeChange(mode, (next) => {
    if (!session) return;
    setSessionMode(session.id, next).catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  });
  return (
    <FormSection title="Permissions" description="It can’t approve its own draft or change these rules.">
      <FormRow label="Mode" hint={session ? current.hint : `New sessions start ${current.label}. ${current.hint}`}>
        {session && canSet ? (
          <Segmented
            label="Mode"
            options={MODES.map((m) => ({ value: m.value, label: m.label }))}
            value={mode}
            onChange={request}
          />
        ) : (
          <span className="an-mode">{current.label}</span>
        )}
      </FormRow>
      {dialog}
    </FormSection>
  );
}

function GuardRails() {
  const guards = useSettingInfos();
  if (!guards) return null;
  return (
    <FormSection title="Guard rails" description="Only you can change them.">
      {GUARDS.map((g) =>
        guards[g.key] ? (
          <FormRow key={g.key} label={g.label} hint={`default ${JSON.stringify(guards[g.key]!.default)}`}>
            <NumberSetting info={guards[g.key]!} unit={g.unit} />
          </FormRow>
        ) : null,
      )}
    </FormSection>
  );
}

export function SettingsSheet({ container }: { container: HTMLElement | null }) {
  const open = useAnalyst((s) => s.sheet);
  const [error, setError] = useState<string | null>(null);
  if (!container) return null;
  return (
    <Sheet
      open={open}
      modal={false}
      onOpenChange={(o) => {
        setSheet(o);
        if (!o) setError(null);
      }}
    >
      <SheetContent container={container} title="Model & permissions" className="an-sheet">
        <Models onError={setError} />
        <Permissions onError={setError} />
        <GuardRails />
        {error ? (
          <p className="err" role="alert" data-selectable>
            {error}
          </p>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
