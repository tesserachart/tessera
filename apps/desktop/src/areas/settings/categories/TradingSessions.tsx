import { Button, Switch, TextInput } from '@tessera/ui';
import { useState } from 'react';
import { selectSession } from '../../../analyst/analystStore.ts';
import {
  SESSION_RUNNER,
  accountLabel,
  canStartNow,
  repoProblem,
  runnerValue,
  sessionRunning,
  standingWords,
} from '../../../analyst/tradingSessions.ts';
import { useAccountUpdates } from '../../../app/portfolio.ts';
import { useNow } from '../../../app/runtimeContext.ts';
import { attempt, refreshTools, useHasTool, useToolValue } from '../../../app/tools.ts';
import { saveSetting, useSetting } from '../../../state/runtimeSettings.ts';
import type { ProviderView } from '../../agents/models.ts';
import { tradable } from '../../research/flow.ts';
import { useShellKnown } from '../hooks.ts';
import { Fact, Row, Section, SettingSelect } from '../parts.tsx';
import { showArea } from '../../store.ts';

const SEP = '::';
const STATUS = 'agent.trading_session';
const NO_STUDY = 'none';

function TextRow({
  id,
  label,
  value,
  placeholder,
  help,
  check,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  help?: string;
  check?: (text: string) => string | null;
  onSave: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(null);
  }
  const save = async () => {
    if (text === null || text.trim() === value.trim()) return;
    const bad = check?.(text) ?? null;
    setErr(bad ?? (await onSave(text)));
  };
  return (
    <Row id={id} help={help} error={err}>
      <TextInput
        aria-label={label}
        value={text ?? value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape' && text !== null) {
            e.preventDefault();
            e.stopPropagation();
            setText(null);
            setErr(null);
          }
        }}
      />
    </Row>
  );
}

function chosenWords(views: readonly ProviderView[], s: { provider?: string; model?: string }): string | null {
  const v = views.find((p) => p.id === s.provider);
  if (!v) return null;
  return s.model ? `${v.name} · ${s.model}` : v.name;
}

function StartNow({ ready, onError }: { ready: boolean; onError: (why: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  if (!ready) return null;
  return (
    <Button
      size="s"
      variant="quiet"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onError(null);
        void attempt('agent.start_trading_session', {}, { refresh: [STATUS] }).then((r) => {
          onError(r.ok ? null : r.why);
          setBusy(false);
        });
      }}
    >
      {busy ? 'Starting…' : 'Start now'}
    </Button>
  );
}

export function TradingSessions({ views }: { views: readonly ProviderView[] }) {
  useShellKnown();
  const setting = useSetting(SESSION_RUNNER);
  const can = useHasTool(STATUS);
  const status = useToolValue(STATUS, can ? {} : null, { refreshEvery: 15_000, keepFor: 60_000 });
  const accounts = useAccountUpdates() ?? [];
  const studies = (useToolValue('research.list_studies', can ? {} : null)?.studies ?? []).filter(
    (st) => tradable(st) || st.id === setting.studyId,
  );
  const now = useNow();
  const [err, setErr] = useState<string | null>(null);
  if (!can) return null;
  const save = (change: Parameters<typeof runnerValue>[1]) =>
    saveSetting(SESSION_RUNNER, runnerValue(setting, change)).then((why) => {
      void refreshTools(STATUS);
      return why;
    });
  const models = views
    .filter((v) => v.ready)
    .flatMap((v) => v.models.map((m) => ({ value: `${v.id}${SEP}${m.id}`, label: m.label, group: v.name })));
  const provider = views.find((v) => v.id === setting.provider);
  const model = setting.model ?? provider?.defaultModel ?? provider?.models[0]?.id ?? '';
  const picked = provider ? `${provider.id}${SEP}${model}` : '';
  const sessionId = status?.day?.sessionId ?? null;
  const running = sessionRunning(status, now);
  return (
    <Section id="analyst.sessions" actions={<StartNow ready={canStartNow(status, now)} onError={setErr} />}>
      <Row id="analyst.sessions.on" help={standingWords(status, now)} error={err}>
        <span className="st-actions">
          {sessionId && running ? (
            <Button
              size="s"
              variant="quiet"
              onClick={() => {
                selectSession(sessionId);
                showArea('agents');
              }}
            >
              Open its conversation
            </Button>
          ) : null}
          <Switch
            label="Trade every session"
            checked={setting.enabled}
            onCheckedChange={(on) => void save({ enabled: on }).then(setErr)}
          />
        </span>
      </Row>
      <Row id="analyst.sessions.account">
        {accounts.length > 0 ? (
          <SettingSelect
            label="Account it trades"
            value={setting.accountId ?? ''}
            placeholder="Pick an account"
            onValueChange={(accountId) => void save({ accountId }).then(setErr)}
            options={accounts.map((u) => ({ value: u.account.id, label: accountLabel(u) }))}
          />
        ) : (
          <Fact>No account is connected</Fact>
        )}
      </Row>
      <Row id="analyst.sessions.model">
        {models.length > 0 ? (
          <SettingSelect
            label="Model it runs on"
            value={models.some((m) => m.value === picked) ? picked : ''}
            placeholder="Pick a model"
            onValueChange={(v) => {
              const [provider = '', model = ''] = v.split(SEP);
              void save({ provider, model, effort: '' }).then(setErr);
            }}
            options={models}
          />
        ) : (
          <Fact>{chosenWords(views, setting) ?? 'Turn on Claude Code or Codex above'}</Fact>
        )}
      </Row>
      <Row id="analyst.sessions.study">
        <SettingSelect
          label="Study it trades"
          value={setting.studyId ?? NO_STUDY}
          onValueChange={(v) => void save({ studyId: v === NO_STUDY ? '' : v }).then(setErr)}
          options={[{ value: NO_STUDY, label: 'None' }, ...studies.map((st) => ({ value: st.id, label: st.name }))]}
        />
      </Row>
      <TextRow
        id="analyst.sessions.instructions"
        label="Instructions file"
        value={setting.instructionsPath ?? ''}
        placeholder={status?.instructionsPath ?? '~/.config/tessera/analyst-instructions.md'}
        help={
          status
            ? status.instructionsChars === null
              ? setting.studyId
                ? `None at ${status.instructionsPath}: the study decides`
                : `Nothing to read at ${status.instructionsPath} yet`
              : `Read at every start · ${status.instructionsChars.toLocaleString('en-US')} characters`
            : undefined
        }
        onSave={(instructionsPath) => save({ instructionsPath })}
      />
      <TextRow
        id="analyst.sessions.issues"
        label="Issues repository"
        value={setting.issuesRepo ?? ''}
        placeholder="owner/name"
        check={repoProblem}
        onSave={(issuesRepo) => save({ issuesRepo })}
      />
    </Section>
  );
}
