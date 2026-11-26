import type { McpAddClientOutput, McpClientInfo, McpClientKind, McpClientPolicy, McpSnippet } from '@tessera/protocol';
import {
  Button,
  ConfirmButton,
  Dialog,
  DialogContent,
  Icon,
  Loaded,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SettingsRow,
} from '@tessera/ui';
import { useRef, useState } from 'react';
import { useClock } from '../../../app/clock.ts';
import { attempt, useToolValue, type Attempt } from '../../../app/tools.ts';
import { CLIENT_KINDS, CLIENT_POLICIES, addedWords, clientHelp } from '../agentClients.ts';
import { Section, SettingSelect } from '../parts.tsx';
import { asSentence } from '../sentence.ts';

const LIST = 'mcp.list_clients';
const REFRESH = { refresh: [LIST] };

function ClientRow({ client, all, nowMs }: { client: McpClientInfo; all: readonly McpClientInfo[]; nowMs: number }) {
  const [err, setErr] = useState<string | null>(null);
  const run = (call: Promise<Attempt<unknown>>) => {
    setErr(null);
    void call.then((r) => {
      if (!r.ok) setErr(asSentence(r.why));
    });
  };
  return (
    <SettingsRow
      data-setting={`analyst.external.${client.id}`}
      label={client.name}
      help={clientHelp(client, all, nowMs)}
      error={err}
    >
      <SettingSelect<McpClientPolicy>
        label={`What ${client.name} may do`}
        value={client.policy}
        onValueChange={(policy) => run(attempt('mcp.set_client_policy', { id: client.id, policy }, REFRESH))}
        options={CLIENT_POLICIES.map((p) => ({ value: p.value, label: p.label, hint: p.hint }))}
      />
      <ConfirmButton
        what={client.name}
        question="Its token stops working at once."
        onConfirm={() => run(attempt('mcp.revoke_client', { id: client.id }, REFRESH))}
      >
        Revoke
      </ConfirmButton>
    </SettingsRow>
  );
}

function Snippet({ snippet }: { snippet: McpSnippet }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="st-snippet">
      <div className="st-snippet-head">
        <span className="w">
          {snippet.label}
          {snippet.file ? <code>{snippet.file}</code> : null}
        </span>
        <Button
          size="s"
          variant="quiet"
          aria-label={`Copy: ${snippet.label}`}
          onClick={() => void navigator.clipboard.writeText(snippet.text).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={snippet.label}>
        {snippet.text}
      </pre>
    </div>
  );
}

const SAMPLE_SNIPPETS: readonly McpSnippet[] = [
  {
    label: 'Add Tessera to its MCP servers',
    file: 'mcp.json',
    format: 'json',
    text: '{\n  "mcpServers": {\n    "tessera": {\n      "command": "tessera-runtime",\n      "args": ["mcp", "--token", "tsk_0000000000000000"]\n    }\n  }\n}',
  },
];

function SetupSnippets({ snippets }: { snippets: readonly McpSnippet[] }) {
  return (
    <>
      {snippets.map((s) => (
        <Snippet key={s.label} snippet={s} />
      ))}
      <p className="st-setup-note">This holds its token, shown only now. It works while Tessera is open.</p>
    </>
  );
}

interface Setup {
  attempt: number;
  kind: McpClientKind;
  label: string;
  out: McpAddClientOutput | null;
  failed: string | null;
}

function SetupDialog({ setup, onClose }: { setup: Setup; onClose: () => void }) {
  const [adding, setAdding] = useState<{ busy: boolean; said: string | null; failed: string | null }>({
    busy: false,
    said: null,
    failed: null,
  });
  const { out } = setup;
  const claudeDesktop = setup.kind === 'claude-desktop' && out !== null;
  const add = () => {
    if (!out) return;
    setAdding({ busy: true, said: null, failed: null });
    void attempt('mcp.add_to_claude_desktop', { id: out.client.id, token: out.token }).then((r) =>
      setAdding(
        r.ok
          ? { busy: false, said: addedWords(r.out.path, r.out.backup), failed: null }
          : { busy: false, said: null, failed: asSentence(r.why) },
      ),
    );
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="cn-dialog st-setup"
        title={`Connect ${setup.label}`}
        description="Orders it places wait for your approval in Tessera."
      >
        <div className="cn-form">
          {setup.failed ? (
            <span className="cn-no" role="alert">
              {setup.failed}
            </span>
          ) : (
            <Loaded
              label={`Loading the ${setup.label} setup`}
              pending={!out}
              sample={<SetupSnippets snippets={SAMPLE_SNIPPETS} />}
            >
              {out ? <SetupSnippets snippets={out.snippets} /> : null}
            </Loaded>
          )}
        </div>
        <div className="cn-acts">
          <span className="cn-outcome">
            {adding.said ? (
              <span className="cn-ok" role="status">
                {adding.said}
              </span>
            ) : adding.failed ? (
              <span className="cn-no" role="alert">
                {adding.failed}
              </span>
            ) : null}
          </span>
          {claudeDesktop && !adding.said ? (
            <Button size="s" variant="primary" disabled={adding.busy} onClick={add}>
              {adding.busy ? 'Adding…' : 'Add to Claude Desktop'}
            </Button>
          ) : null}
          <Button size="s" variant={claudeDesktop && !adding.said ? 'secondary' : 'primary'} onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AgentClients() {
  const clock = useClock();
  const list = useToolValue(LIST, {}, { keepFor: 5_000, refreshEvery: 30_000 });
  const clients = list?.clients ?? [];
  const [setup, setSetup] = useState<Setup | null>(null);
  const attempts = useRef(0);
  const connect = (kind: McpClientKind, label: string) => {
    const tried = ++attempts.current;
    setSetup({ attempt: tried, kind, label, out: null, failed: null });
    void attempt('mcp.add_client', { kind }, REFRESH).then((r) =>
      setSetup((s) => (s?.attempt !== tried ? s : r.ok ? { ...s, out: r.out } : { ...s, failed: asSentence(r.why) })),
    );
  };
  const nowMs = clock.now();
  return (
    <>
      <Section
        id="analyst.external"
        actions={
          <Menu>
            <MenuTrigger asChild>
              <Button size="s">
                Connect an agent
                <Icon name="chevron-down" />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              {CLIENT_KINDS.map((k) => (
                <MenuItem key={k.kind} onSelect={() => connect(k.kind, k.kind === 'other' ? 'an MCP client' : k.label)}>
                  {k.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        }
      >
        {clients.map((c) => (
          <ClientRow key={c.id} client={c} all={clients} nowMs={nowMs} />
        ))}
      </Section>
      {setup ? <SetupDialog key={setup.attempt} setup={setup} onClose={() => setSetup(null)} /> : null}
    </>
  );
}
