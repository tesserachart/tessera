import type { AgentProviderInfo, Delivery, SessionMode } from '@tessera/protocol';
import { Button, Choice, SettingsRow, Switch, TextArea, TextInput, formatShortcut, usePlatform } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { FOLLOW_UP, followUpHelp } from '../../../analyst/dispatch.ts';
import { useModeChange } from '../../../analyst/modeChange.tsx';
import { DEFAULT_MODE, MODES, modeInfo } from '../../../analyst/modes.ts';
import { useClock } from '../../../app/clock.ts';
import { useFlag } from '../../../app/flags.ts';
import { GetProvider } from '../../agents/GetProvider.tsx';
import { SignInControls } from '../../agents/SignIn.tsx';
import { signInLine, useSignIn } from '../../agents/signInState.ts';
import {
  PROVIDER_CLI,
  checkedWords,
  connectState,
  formatArgs,
  parseArgs,
  providerLine,
  readProviderChoices,
  type ProviderChoices,
} from '../../agents/connect.ts';
import { anyEnabled, effortOf, findModel, resolvePick, type ProviderView } from '../../agents/models.ts';
import {
  PROVIDERS,
  recheckProviders,
  setProviderEnabled,
  setProviderLaunch,
  useProviders,
} from '../../agents/providers.ts';
import { setPick, useAgentsUi } from '../../agents/store.ts';
import { useSetting, useSettingInfos, useSettingSave } from '../../../state/runtimeSettings.ts';
import { DEFAULT_MODEL } from '../../../state/settingsSync.ts';
import { defineSetting, textOrNull } from '../../../state/setting.ts';
import { NumberSetting } from '../NumberSetting.tsx';
import { AgentClients } from './AgentClients.tsx';
import { TradingSessions } from './TradingSessions.tsx';
import { Fact, Row, Section, SettingSelect } from '../parts.tsx';

export const INSTRUCTIONS_MAX = 4000;
const SEP = '::';

function LaunchRow({
  id,
  label,
  help,
  value,
  onSave,
}: {
  id: string;
  label: string;
  help: ReactNode;
  value: string;
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
    setErr(await onSave(text));
  };
  return (
    <SettingsRow data-setting={id} className="st-own" label={label} help={help} error={err}>
      <TextInput
        aria-label={label}
        value={text ?? value}
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
          }
        }}
      />
    </SettingsRow>
  );
}

function ProviderDetail({
  view,
  info,
  choices,
}: {
  view: ProviderView;
  info: AgentProviderInfo | undefined;
  choices: ProviderChoices;
}) {
  const cli = PROVIDER_CLI[view.id];
  const home = view.enabled ? (info?.configHome ?? null) : null;
  return (
    <>
      <LaunchRow
        id={`analyst.provider.${view.id}.binary`}
        label={`${view.name} binary path`}
        help={`Empty: ${cli?.bin ?? 'its name'} on your PATH.`}
        value={choices.binaryPath}
        onSave={(binaryPath) => setProviderLaunch(view.id, { binaryPath })}
      />
      <LaunchRow
        id={`analyst.provider.${view.id}.home`}
        label={`${view.name} config directory`}
        help={
          <>
            {cli ? `Its ${cli.homeVar}. Empty: ${cli.home}.` : null}
            {home ? <span className="st-line">Runs on {home}</span> : null}
          </>
        }
        value={choices.configDir}
        onSave={(configDir) => setProviderLaunch(view.id, { configDir })}
      />
      <LaunchRow
        id={`analyst.provider.${view.id}.args`}
        label={`${view.name} launch arguments`}
        help="Tessera’s own win where both set one. Quotes keep spaces."
        value={formatArgs(choices.args)}
        onSave={(text) => setProviderLaunch(view.id, { args: parseArgs(text) })}
      />
    </>
  );
}

function ProviderRow({
  view,
  info,
  choices,
}: {
  view: ProviderView;
  info: AgentProviderInfo | undefined;
  choices: ProviderChoices;
}) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = connectState(view);
  const signIn = useSignIn(view.id, view.name, setErr);
  const signingIn = s.kind === 'signed-out' ? signInLine(signIn) : null;
  return (
    <>
      <SettingsRow
        data-setting={`analyst.provider.${view.id}`}
        label={view.name}
        error={err}
        help={<>{signingIn ?? providerLine(view, view.enabled ? (info?.version ?? null) : null)}</>}
      >
        <span className="st-actions">
          {s.kind === 'missing' ? <GetProvider id={view.id} name={view.name} s={s} onError={setErr} /> : null}
          {s.kind === 'signed-out' ? <SignInControls s={signIn} /> : null}
          <Button size="s" variant="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            Details
          </Button>
          <Switch
            label={`Enable ${view.name}`}
            checked={choices.enabled}
            onCheckedChange={(on) => void setProviderEnabled(view.id, on).then(setErr)}
          />
        </span>
      </SettingsRow>
      {open ? <ProviderDetail view={view} info={info} choices={choices} /> : null}
    </>
  );
}

function CheckAgain({ list }: { list: readonly AgentProviderInfo[] | undefined }) {
  const clock = useClock();
  const [busy, setBusy] = useState(false);
  const on = (list ?? []).some((p) => p.enabled);
  if (!on) return null;
  const checked = checkedWords(list, clock.now());
  return (
    <span className="st-actions">
      {checked ? <span className="st-fact">{checked}</span> : null}
      <Button
        size="s"
        variant="quiet"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void recheckProviders().finally(() => setBusy(false));
        }}
      >
        {busy ? 'Checking…' : 'Check again'}
      </Button>
    </span>
  );
}

const CUSTOM_INSTRUCTIONS = defineSetting('agent.customInstructions', (v) => textOrNull(v) ?? '');

function Instructions() {
  const value = useSetting(CUSTOM_INSTRUCTIONS);
  const { save: keep, error: err } = useSettingSave(CUSTOM_INSTRUCTIONS);
  const [text, setText] = useState<string | null>(null);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(null);
  }
  const shown = text ?? value;
  const save = async () => {
    if (text === null || text === value) return;
    await keep(text.slice(0, INSTRUCTIONS_MAX));
  };
  const near = shown.length > INSTRUCTIONS_MAX * 0.8;
  return (
    <Row
      id="analyst.customInstructions"
      layout="stack"
      error={err}
      help={
        near
          ? `${shown.length.toLocaleString('en-US')} of ${INSTRUCTIONS_MAX.toLocaleString('en-US')} characters`
          : 'Kept when you leave the field. Applies from the next conversation.'
      }
    >
      <TextArea
        aria-label="Custom instructions"
        rows={6}
        maxLength={INSTRUCTIONS_MAX}
        value={shown}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape' && text !== null) {
            e.preventDefault();
            e.stopPropagation();
            setText(null);
          }
        }}
      />
    </Row>
  );
}

const GUARDS: { row: string; key: string; unit?: string }[] = [
  { row: 'analyst.maxSteps', key: 'agent.maxStepsPerTurn' },
  { row: 'analyst.maxToolCalls', key: 'agent.maxToolCallsPerTurn' },
  { row: 'analyst.dedup', key: 'agent.dedupWindowMs', unit: 'ms' },
];

export function Analyst() {
  const tradingSessions = useFlag('analyst-trading-sessions');
  const { list, views } = useProviders();
  const choices = useSetting(PROVIDERS);
  const stored = useSetting(DEFAULT_MODEL);
  const lastPick = useAgentsUi((s) => s.pick);
  const pick = resolvePick(views, null, stored ?? lastPick);
  const model = findModel(views, pick);
  const effort = effortOf(model, pick?.effort ?? null);
  const mode = useSetting(DEFAULT_MODE);
  const { save: saveMode, error: modeErr } = useSettingSave(DEFAULT_MODE);
  const modeChange = useModeChange(mode, (v) => void saveMode(v));
  const followUp = useSetting(FOLLOW_UP);
  const { save: saveFollowUp, error: followUpErr } = useSettingSave(FOLLOW_UP);
  const platform = usePlatform();
  const infos = useSettingInfos();
  const options = views
    .filter((v) => v.ready)
    .flatMap((v) => v.models.map((m) => ({ value: `${v.id}${SEP}${m.id}`, label: m.label, group: v.name })));
  const choose = (provider: string, m: string | null, e: string | null) => setPick({ provider, model: m, effort: e });
  return (
    <>
      <Section id="analyst.providers" actions={<CheckAgain list={list} />}>
        {views.map((v) => (
          <ProviderRow
            key={v.id}
            view={v}
            info={list?.find((p) => p.id === v.id)}
            choices={readProviderChoices(choices, v.id)}
          />
        ))}
      </Section>
      <AgentClients />
      <Section id="analyst.defaults">
        <Row id="analyst.model" help={pick ? views.find((v) => v.id === pick.provider)?.name : undefined}>
          {pick && options.length > 0 ? (
            <SettingSelect
              label="Model of new conversations"
              value={`${pick.provider}${SEP}${pick.model ?? model?.id ?? ''}`}
              onValueChange={(v) => {
                const [provider = '', m = ''] = v.split(SEP);
                choose(provider, m || null, null);
              }}
              options={options}
            />
          ) : (
            <Fact>
              {anyEnabled(views)
                ? 'Finish turning on Claude Code or Codex above'
                : 'Turn on Claude Code or Codex above'}
            </Fact>
          )}
        </Row>
        {model && model.efforts.length > 0 && pick ? (
          <Row id="analyst.effort">
            <SettingSelect
              label="Reasoning effort of new conversations"
              value={effort ?? model.efforts[0]!.id}
              onValueChange={(e) => choose(pick.provider, pick.model, e)}
              options={model.efforts.map((e) => ({ value: e.id, label: e.label }))}
            />
          </Row>
        ) : null}
        <Row id="analyst.mode" help={modeInfo(mode).hint} error={modeErr}>
          <Choice<SessionMode>
            label="Permissions of new sessions"
            value={mode}
            onChange={modeChange.request}
            options={MODES.map((m) => ({ value: m.value, label: m.label }))}
          />
          {modeChange.dialog}
        </Row>
        <Row
          id="analyst.followUp"
          help={followUpHelp(followUp, formatShortcut('mod+enter', platform))}
          error={followUpErr}
        >
          <Choice<Delivery>
            label="While the analyst works"
            value={followUp}
            onChange={(v) => void saveFollowUp(v)}
            options={[
              { value: 'steer', label: 'Steer' },
              { value: 'queue', label: 'Queue' },
            ]}
          />
        </Row>
      </Section>
      <Section id="analyst.instructions">
        <Instructions />
      </Section>
      {tradingSessions ? <TradingSessions views={views} /> : null}
      <Section id="analyst.guards">
        {GUARDS.map((g) => {
          const info = infos?.[g.key];
          return info ? (
            <Row key={g.key} id={g.row}>
              <NumberSetting info={info} unit={g.unit} />
            </Row>
          ) : null;
        })}
      </Section>
    </>
  );
}
