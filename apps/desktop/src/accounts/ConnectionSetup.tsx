import type { ConnectionInfo, RithmicLoginInput } from '@tessera/protocol';
import { Button, Combobox, ConfirmButton, Field, Loaded, Select, SettingsRow, TextInput } from '@tessera/ui';
import { useId, useState, type ReactNode } from 'react';
import { useToolValue } from '../app/tools.ts';
import type { LoginMode } from './accountsUi.ts';
import { Elapsed } from './ConnectionForm.tsx';
import { useConnectionCall } from './connectionCall.ts';
import {
  defaultGateway,
  gatewayProblem,
  loginProblem,
  systemOptions,
  typedSystem,
  type ConnectionRow,
} from './connections.ts';
import { useRithmicDirectory } from './rithmicDirectory.ts';
import { useHasUserConnectionTools } from './useConnections.ts';
import { useSavedWords } from './savedWords.ts';
import { endSentence } from '../areas/settings/sentence.ts';

type Said = { ok: boolean; text: string } | null;

const ADDRESS = '\u0000address';

/** A second Rithmic session of a connected login can end the first. */
export function LoginForm({
  mode,
  system: fixed = '',
  user: knownUser = '',
  gateway: knownGateway = null,
  onDone,
  onCancel,
}: {
  mode: 'first' | 'new' | LoginMode;
  system?: string;
  user?: string;
  gateway?: string | null;
  onDone: (connection: ConnectionInfo) => void;
  onCancel?: () => void;
}) {
  const [system, setSystem] = useState(fixed);
  const [picked, setPicked] = useState<string | null>(knownGateway);
  const saved = useSavedWords();
  const [address, setAddress] = useState('');
  const [user, setUser] = useState(knownUser);
  const [password, setPassword] = useState('');
  const [outcome, setOutcome] = useState<Said>(null);
  const [verb, setVerb] = useState('');
  const dir = useRithmicDirectory(system);
  const { since, run } = useConnectionCall();
  const ids = useId();
  const busy = since !== null;
  const first = mode === 'first';
  const listed = dir.gateways;
  const typing = picked === ADDRESS || (system.trim() !== '' && !dir.loading && listed.length === 0);
  const named = picked !== null && listed.includes(picked) ? picked : defaultGateway(listed);
  const login: RithmicLoginInput = { system, gateway: typing ? address : (named ?? ''), user, password };
  const problem = loginProblem(login);
  const to = system.trim() || 'Rithmic';
  const changed = () => setOutcome(null);
  const test = async () => {
    setVerb(`Logging in to ${to}`);
    const r = await run('connections.test_rithmic', login);
    setOutcome(
      r.ok
        ? { ok: r.out.ok, text: r.out.ok ? endSentence(r.out.message) : `${endSentence(r.out.message)} Nothing saved.` }
        : { ok: false, text: `${endSentence(r.why)} Nothing saved.` },
    );
  };
  const save = async () => {
    setVerb(`Logging in to ${to}`);
    const r = await run(mode === 'replace' ? 'connections.replace_rithmic' : 'connections.add_rithmic', login);
    if (r.ok) {
      setPassword('');
      onDone(r.out.connection);
    } else {
      setOutcome({ ok: false, text: mode === 'replace' ? endSentence(r.why) : `${endSentence(r.why)} Nothing saved.` });
    }
  };
  return (
    <form
      className="cn-login"
      aria-label="Rithmic login"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && !busy) void save();
      }}
    >
      <Field label="Firm" htmlFor={`${ids}-system`}>
        <Combobox
          id={`${ids}-system`}
          label="Firm"
          options={systemOptions(dir.systems)}
          custom={typedSystem}
          value={system.trim() === '' ? null : system}
          onValueChange={(v) => {
            setSystem(v);
            setPicked(null);
            changed();
          }}
          placeholder="Pick or type the firm"
          searchPlaceholder="Search firms, or type one"
          disabled={busy || !!fixed}
        />
      </Field>
      {typing ? (
        <Field
          label="Gateway"
          htmlFor={`${ids}-address`}
          error={gatewayProblem(address)}
          help={
            dir.problem && listed.length === 0
              ? endSentence(dir.problem)
              : listed.length === 0
                ? 'Its wss:// address, from your firm’s Rithmic instructions'
                : undefined
          }
        >
          <TextInput
            id={`${ids}-address`}
            value={address}
            placeholder="wss://"
            onChange={(e) => {
              setAddress(e.target.value);
              changed();
            }}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : (
        <Field label="Gateway" htmlFor={`${ids}-gateway`} help="The nearest to you is quickest">
          <Select
            id={`${ids}-gateway`}
            value={named ?? ''}
            onValueChange={(v) => {
              setPicked(v);
              changed();
            }}
            placeholder={dir.loading ? 'Asking Rithmic…' : 'Pick the firm first'}
            disabled={busy || listed.length === 0}
            options={[...listed.map((g) => ({ value: g, label: g })), { value: ADDRESS, label: 'Type an address…' }]}
          />
        </Field>
      )}
      {typing && listed.length > 0 ? (
        <Button size="s" variant="quiet" className="cn-login-back" onClick={() => setPicked(null)} disabled={busy}>
          Pick from Rithmic’s gateways
        </Button>
      ) : null}
      <Field label="User" htmlFor={`${ids}-user`}>
        <TextInput
          id={`${ids}-user`}
          value={user}
          onChange={(e) => {
            setUser(e.target.value);
            changed();
          }}
          disabled={busy}
          autoComplete="username"
          spellCheck={false}
          autoFocus={!!fixed}
        />
      </Field>
      <Field label="Password" htmlFor={`${ids}-password`} help={`${saved}, sent only to Rithmic`}>
        <TextInput
          id={`${ids}-password`}
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            changed();
          }}
          disabled={busy}
          autoComplete="current-password"
          spellCheck={false}
        />
      </Field>
      <div className="cn-acts">
        <span className="cn-outcome">
          {busy ? (
            <Elapsed verb={verb} since={since} />
          ) : outcome ? (
            <span className={outcome.ok ? 'cn-ok' : 'cn-no'} role="status">
              {outcome.text}
            </span>
          ) : null}
        </span>
        {onCancel ? (
          <Button size="s" variant="quiet" disabled={busy} onClick={onCancel}>
            {first ? 'Not now' : 'Cancel'}
          </Button>
        ) : null}
        {mode === 'replace' ? null : (
          <Button size="s" variant="quiet" disabled={!!problem || busy} onClick={() => void test()}>
            Test
          </Button>
        )}
        <Button type="submit" size="s" variant="primary" disabled={!!problem || busy}>
          {mode === 'replace' ? 'Replace' : first ? 'Connect' : 'Test and save'}
        </Button>
      </div>
    </form>
  );
}

export function LoginEditor(props: { row: ConnectionRow; mode: LoginMode; onClose: () => void }) {
  return (
    <Loaded label="Loading the login" sample={<LoginEditorSample mode={props.mode} />}>
      <LoginEditorBody {...props} />
    </Loaded>
  );
}

function LoginNote({ mode }: { mode: LoginMode }) {
  return (
    <p className="st-conn-note">
      {mode === 'replace'
        ? 'Tessera logs the session out, logs in with this login and keeps it only if it works.'
        : 'Its saved login cannot be read: type it again.'}
    </p>
  );
}

function RemoveRow({ error, children }: { error?: string | null; children: ReactNode }) {
  return (
    <SettingsRow compact label="Remove this connection" help="Logs it out and deletes its saved login" error={error}>
      {children}
    </SettingsRow>
  );
}

function LoginEditorSample({ mode }: { mode: LoginMode }) {
  return (
    <>
      <LoginNote mode={mode} />
      <div className="cn-login">
        <Field label="Firm">
          <TextInput value="Rithmic Paper Trading" readOnly tabIndex={-1} />
        </Field>
        <Field label="Gateway" help="The nearest to you is quickest">
          <TextInput value="Chicago Area" readOnly tabIndex={-1} />
        </Field>
        <Field label="User">
          <TextInput value="trader-00000" readOnly tabIndex={-1} />
        </Field>
        <Field label="Password" help="Saved in the system keychain, sent only to Rithmic">
          <TextInput type="password" value="" readOnly tabIndex={-1} />
        </Field>
        <div className="cn-acts">
          <span className="cn-outcome" />
          <Button size="s" variant="quiet">
            Cancel
          </Button>
          {mode === 'replace' ? null : (
            <Button size="s" variant="quiet">
              Test
            </Button>
          )}
          <Button size="s" variant="primary">
            {mode === 'replace' ? 'Replace' : 'Test and save'}
          </Button>
        </div>
      </div>
      <RemoveRow>
        <ConfirmButton what="this connection" onConfirm={() => undefined}>
          Remove
        </ConfirmButton>
      </RemoveRow>
    </>
  );
}

function LoginEditorBody({ row, mode, onClose }: { row: ConnectionRow; mode: LoginMode; onClose: () => void }) {
  const has = useHasUserConnectionTools();
  const creds = useToolValue('connections.list_credentials', has ? {} : null, { keepFor: 5_000 })?.credentials;
  const cred = creds?.find((c) => c.connectionId === row.id) ?? null;
  const { since, run } = useConnectionCall();
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <LoginNote mode={mode} />
      {creds ? (
        <LoginForm
          mode={mode}
          system={row.system ?? row.name}
          user={cred?.user ?? ''}
          gateway={cred?.gateway ?? null}
          onDone={onClose}
          onCancel={onClose}
        />
      ) : null}
      <RemoveRow error={failed}>
        <ConfirmButton
          what={row.name}
          question="Log it out and delete its saved login?"
          disabled={since !== null}
          onConfirm={() =>
            void run('connections.remove', { id: row.id }).then((r) => {
              if (r.ok) onClose();
              else setFailed(endSentence(r.why));
            })
          }
        >
          Remove
        </ConfirmButton>
      </RemoveRow>
    </>
  );
}
