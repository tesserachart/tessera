import { Button, ConfirmButton, SettingsRow, StatusDot } from '@tessera/ui';
import { useState } from 'react';
import { AddConnection, AddForm, ConnectionForms } from '../../../accounts/AddConnection.tsx';
import {
  focusConnections,
  openConnectionDialog,
  useAccountsUi,
  type ConnectionsFocus,
} from '../../../accounts/accountsUi.ts';
import { Elapsed } from '../../../accounts/ConnectionForm.tsx';
import { useConnectionCall } from '../../../accounts/connectionCall.ts';
import { connectionItem, type ConnectionItem, type Listed } from '../../../accounts/connections.ts';
import { LoginEditor } from '../../../accounts/ConnectionSetup.tsx';
import { LevelsEditor } from '../../../accounts/LevelsEditor.tsx';
import { connectionTarget } from '../../../accounts/navigate.ts';
import { useListedConnections } from '../../../accounts/useConnections.ts';
import { dotFor } from '../../../shell/health.ts';
import { useShellData } from '../../../shell/shellData.ts';
import { useShellKnown } from '../hooks.ts';
import { Section } from '../parts.tsx';
import { endSentence } from '../sentence.ts';
import { openSettings } from '../store.ts';
import { ExchangesSections } from './Exchanges.tsx';

type Said = { ok: boolean; text: string } | null;

export function Connections() {
  const listed = useListedConnections();
  const { accounts } = useShellData();
  const focus = useAccountsUi((s) => s.focus);
  useShellKnown();
  return (
    <>
      {focus?.kind === 'add' ? <AddForm provider={focus.provider} /> : null}
      <Section id="connections.list" actions={<AddConnection />}>
        {listed.map((l) => {
          const item = connectionItem(l, accounts);
          return <ConnectionEntry key={item.id} listed={l} item={item} focus={focus} />;
        })}
      </Section>
      <ExchangesSections />
      <ConnectionForms />
    </>
  );
}

function ConnectionEntry({ listed, item, focus }: { listed: Listed; item: ConnectionItem; focus: ConnectionsFocus }) {
  const { since, run } = useConnectionCall();
  const [said, setSaid] = useState<Said>(null);
  const [verb, setVerb] = useState('');
  const editing = focus?.kind === 'edit' && focus.id === item.id ? focus : null;
  const busy = since !== null;
  const call = (v: string, p: Promise<Said>) => {
    setVerb(v);
    setSaid(null);
    void p.then(setSaid);
  };
  const failed = (r: { ok: true } | { ok: false; why: string }): Said =>
    r.ok ? null : { ok: false, text: endSentence(r.why) };
  const test = () =>
    call(
      listed.kind === 'levels' ? `Asking ${listed.info.vendor}` : 'Checking the login',
      run('connections.test_credential', { id: item.id }).then((r) =>
        r.ok ? { ok: r.out.ok, text: endSentence(r.out.message) } : { ok: false, text: endSentence(r.why) },
      ),
    );
  const edit = () => {
    if (listed.kind === 'draft') return openConnectionDialog({ kind: 'levels', draft: listed.draft.id });
    focusConnections(editing ? null : { kind: 'edit', id: item.id, login: null });
  };
  const switchTo = (enabled: boolean) =>
    call(
      enabled ? `Logging in to ${item.short}` : 'Logging out',
      run('connections.set_enabled', { id: item.id, enabled }).then(failed),
    );
  const problem = said && !said.ok ? said.text : null;
  return (
    <>
      <SettingsRow
        className="st-conn"
        role="group"
        data-setting={connectionTarget(item.id)}
        aria-label={item.name}
        label={
          <span className="st-conn-name">
            <StatusDot state={dotFor(item.status)} />
            {item.name}
          </span>
        }
        help={[item.provides, item.serves].filter(Boolean).join(' · ')}
        error={problem}
      >
        <span className="st-conn-state" data-status={item.status}>
          {busy ? <Elapsed verb={verb} since={since} /> : said?.ok ? said.text : item.state}
        </span>
        <span className="flex min-w-[200px] items-center justify-end gap-2 @max-[721px]/settings:min-w-0 @max-[721px]/settings:justify-start">
          {item.fix?.kind === 'reconnect' ? (
            <Button
              size="s"
              variant="primary"
              disabled={busy}
              onClick={() =>
                call(`Logging in to ${item.short}`, run('connections.reconnect', { id: item.id }).then(failed))
              }
            >
              {item.fix.label}
            </Button>
          ) : null}
          {item.fix?.kind === 'login' ? (
            <Button
              size="s"
              variant="primary"
              onClick={() => focusConnections({ kind: 'edit', id: item.id, login: 'again' })}
            >
              {item.fix.label}
            </Button>
          ) : null}
          {item.test ? (
            <Button size="s" variant="quiet" disabled={busy} onClick={test}>
              Test
            </Button>
          ) : null}
          {item.edit ? (
            <Button size="s" variant="quiet" aria-expanded={editing !== null} onClick={edit}>
              {listed.kind === 'draft' ? 'Review…' : 'Edit'}
            </Button>
          ) : null}
          {listed.kind === 'login' && listed.row.paper ? (
            <Button size="s" variant="quiet" onClick={() => openSettings('trading.commission')}>
              Commission
            </Button>
          ) : null}
          <EndButton
            item={item}
            listed={listed}
            busy={busy}
            onSwitch={switchTo}
            onRemove={() =>
              call(
                'Removing',
                run(
                  listed.kind === 'draft' ? 'intel.discard_source_draft' : 'connections.remove',
                  listed.kind === 'draft' ? { id: listed.draft.id } : { id: item.id },
                ).then(failed),
              )
            }
          />
        </span>
      </SettingsRow>
      {editing ? (
        <div className="st-conn-edit" role="group" aria-label={`Edit ${item.name}`}>
          <Editor listed={listed} focus={editing} />
        </div>
      ) : null}
    </>
  );
}

function EndButton({
  item,
  listed,
  busy,
  onSwitch,
  onRemove,
}: {
  item: ConnectionItem;
  listed: Listed;
  busy: boolean;
  onSwitch: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  switch (item.end) {
    case 'disconnect':
      return (
        <Button size="s" variant="quiet" disabled={busy} onClick={() => onSwitch(false)}>
          Disconnect
        </Button>
      );
    case 'connect':
      return (
        <Button size="s" disabled={busy} onClick={() => onSwitch(true)}>
          Connect
        </Button>
      );
    case 'remove':
      return (
        <ConfirmButton
          what={item.name}
          question={
            listed.kind === 'levels' && listed.info.sendsSecret
              ? 'Take its levels off the charts and delete its key?'
              : 'Take its levels off the charts?'
          }
          disabled={busy}
          onConfirm={onRemove}
        >
          Remove
        </ConfirmButton>
      );
    case 'discard':
      return (
        <ConfirmButton what={item.name} question="Discard this draft?" disabled={busy} onConfirm={onRemove}>
          Discard
        </ConfirmButton>
      );
    case null:
      return null;
  }
}

function Editor({ listed, focus }: { listed: Listed; focus: Exclude<ConnectionsFocus, null | { kind: 'add' }> }) {
  const close = () => focusConnections(null);
  if (listed.kind === 'login')
    return (
      <LoginEditor
        row={listed.row}
        mode={focus.login ?? (listed.row.action?.kind === 'login' ? 'again' : 'replace')}
        onClose={close}
      />
    );
  if (listed.kind === 'levels') return <LevelsEditor info={listed.info} />;
  return null;
}
