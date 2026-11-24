import type { ExportTradesInput, PullSummary } from '@tessera/protocol';
import { Button, Segmented, SettingsRow, Switch, TextInput } from '@tessera/ui';
import { useEffect, useState } from 'react';
import { peekTool, refreshTools, runToolResult, useHasTool, useToolValue } from '../../../app/tools.ts';
import { useRuntimeSetting, useSetSetting } from '../../../state/runtimeSettings.ts';
import { useArea } from '../../store.ts';
import { useSettingInfos } from '../hooks.ts';
import { NumberSetting } from '../NumberSetting.tsx';
import { Fact, Row, Section } from '../parts.tsx';
import {
  SCOPE_OPTIONS,
  contractExport,
  contractFact,
  pulledLines,
  contractHelp,
  defaultPullForm,
  exportFolder,
  exportWords,
  failureWords,
  finishedDays,
  progressWords,
  pullActions,
  pullExport,
  pullStateWords,
  pullTitle,
  pullsRefreshEvery,
  readPullForm,
  type PullForm,
} from '../savedTrades.ts';
import { HistoryMarkets } from '../HistoryMarkets.tsx';
import { act, EVERY_PULL, PULL_READS } from '../pullTools.ts';
import { sizeWords } from '../words.ts';

const KEEP_SETTING = 'market.savedTradeSessions';
const RECORD_SETTING = 'market.recordWatchlists';
const AUTO_SETTING = 'market.autoDownload';
type Said = { said: string | null; failed: string | null };

async function exportTo(input: ExportTradesInput): Promise<Said> {
  try {
    const r = await runToolResult('market.export_trades', input, { timeoutMs: 600_000 });
    return r.ok && r.output
      ? { said: exportWords(r.output), failed: null }
      : { said: null, failed: r.error?.message ?? 'It did not go through.' };
  } catch (e) {
    return { said: null, failed: e instanceof Error ? e.message : String(e) };
  }
}

function RecordWatchlists() {
  const on = useRuntimeSetting(RECORD_SETTING) !== false;
  const set = useSetSetting();
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <Row id="data.savedRecord" error={failed}>
      <Switch
        label="Record your watchlists"
        checked={on}
        onCheckedChange={(next) => void set(RECORD_SETTING, next).then(setFailed)}
      />
    </Row>
  );
}

function AutoDownload() {
  const on = useRuntimeSetting(AUTO_SETTING) !== false;
  const set = useSetSetting();
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <Row id="data.savedAuto" error={failed}>
      <Switch
        label="Download missing data automatically"
        checked={on}
        onCheckedChange={(next) => void set(AUTO_SETTING, next).then(setFailed)}
      />
    </Row>
  );
}

function PullRow({ pull, dir }: { pull: PullSummary; dir: string }) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Said>({ said: null, failed: null });
  const can = pullActions(pull);
  const run = async (f: () => Promise<Said>) => {
    setBusy(true);
    setOut(await f());
    setBusy(false);
  };
  const tool = (name: 'market.cancel_pull' | 'market.resume_pull' | 'market.release_pull') =>
    void run(async () => ({ said: null, failed: await act(name, { id: pull.id }) }));
  const help = out.said ?? failureWords(pull) ?? progressWords(pull);
  return (
    <SettingsRow data-setting={`data.pull.${pull.id}`} label={pullTitle(pull.request)} help={help} error={out.failed}>
      <span className="st-actions">
        <Fact>{pullStateWords(pull)}</Fact>
        {can.cancel ? (
          <Button size="s" disabled={busy} onClick={() => tool('market.cancel_pull')}>
            Cancel
          </Button>
        ) : null}
        {can.resume ? (
          <Button size="s" disabled={busy} onClick={() => tool('market.resume_pull')}>
            Resume
          </Button>
        ) : null}
        <Button size="s" disabled={busy || !dir} onClick={() => void run(() => exportTo(pullExport(pull, dir)))}>
          Export
        </Button>
        <Button size="s" variant="quiet" disabled={busy} onClick={() => tool('market.release_pull')}>
          Release
        </Button>
      </span>
    </SettingsRow>
  );
}

export function SavedTradesSections({ dataDir }: { dataDir: string | null }) {
  const has = useHasTool('market.saved_trades');
  const canWeek = useHasTool('market.estimate_pull');
  const shown = useArea((s) => s.area === 'settings');
  const every = pullsRefreshEvery(peekTool('market.list_pulls', EVERY_PULL)?.pulls, shown);
  const pulls = useToolValue('market.list_pulls', has ? EVERY_PULL : null, {
    keepFor: 10_000,
    refreshEvery: every,
  })?.pulls;
  useEffect(() => {
    if (has && shown) void refreshTools(...PULL_READS);
  }, [has, shown]);
  const saved = useToolValue('market.saved_trades', has ? {} : null, { keepFor: 10_000, refreshEvery: every });
  const finished = finishedDays(pulls);
  useEffect(() => {
    if (finished > 0) void refreshTools('market.saved_trades');
  }, [finished]);
  const diskBytes = saved?.diskBytes;
  useEffect(() => {
    if (diskBytes !== undefined) void refreshTools('runtime.data_info');
  }, [diskBytes]);
  const keep = useSettingInfos()?.[KEEP_SETTING];
  const [form, setForm] = useState<PullForm>(() => defaultPullForm(new Date()));
  const [dirTyped, setDir] = useState<string | null>(null);
  const [start, setStart] = useState<{ busy: boolean; failed: string | null }>({ busy: false, failed: null });
  const [contractOut, setContractOut] = useState<Record<string, Said>>({});
  if (!has) return null;
  const dir = dirTyped ?? exportFolder(dataDir);
  const pull = () => {
    const read = readPullForm(form);
    if (!read.ok) {
      setStart({ busy: false, failed: read.why });
      return;
    }
    setStart({ busy: true, failed: null });
    void act('market.pull_trades', read.request).then((failed) => setStart({ busy: false, failed }));
  };
  const set = (patch: Partial<PullForm>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <>
      <Section id="data.saved">
        <RecordWatchlists />
        <AutoDownload />
        <Row id="data.savedDisk" help={saved?.path ?? undefined}>
          <Fact>{saved ? sizeWords(saved.diskBytes) : '…'}</Fact>
        </Row>
        {(saved?.pulled ?? []).map((p) => (
          <SettingsRow
            key={`pulled:${p.source}`}
            data-setting={`data.pulled.${p.source}`}
            label="History pulled"
            help={`${p.source} · what its history service sent, counted on this computer`}
          >
            <Fact>
              {pulledLines(p).map((line) => (
                <span key={line} className="st-fact-line">
                  {line}
                </span>
              ))}
            </Fact>
          </SettingsRow>
        ))}
        {keep ? (
          <Row id="data.savedKeep">
            <NumberSetting info={keep} unit="sessions" label="Sessions kept per contract" />
          </Row>
        ) : null}
        {(saved?.contracts ?? []).map((c) => {
          const key = `${c.source}:${c.instrument}`;
          const out = contractOut[key];
          const ask = contractExport(c, dir);
          return (
            <SettingsRow
              key={key}
              data-setting={`data.saved.${key}`}
              label={c.instrument}
              help={out?.said ?? contractHelp(c)}
              error={out?.failed ?? null}
            >
              <span className="st-actions">
                <Fact>
                  {contractFact(c)} · {sizeWords(c.bytes)}
                </Fact>
                <Button
                  size="s"
                  disabled={!ask || !dir}
                  onClick={() => ask && void exportTo(ask).then((r) => setContractOut((m) => ({ ...m, [key]: r })))}
                >
                  Export
                </Button>
              </span>
            </SettingsRow>
          );
        })}
        <Row id="data.exportDir">
          <TextInput
            className="st-path"
            aria-label="Export folder"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
          />
        </Row>
      </Section>
      <Section id="data.pulls">
        {canWeek ? (
          <Row id="data.pullWeek" layout="stack">
            <HistoryMarkets />
          </Row>
        ) : null}
        <Row id="data.pullNew" layout="stack" error={start.failed}>
          <span className="st-actions st-pull-form">
            <TextInput
              className="st-symbol"
              aria-label="Contract or root"
              value={form.instrument}
              onChange={(e) => set({ instrument: e.target.value })}
            />
            <TextInput
              type="date"
              aria-label="First day"
              value={form.from}
              onChange={(e) => set({ from: e.target.value })}
            />
            <TextInput
              type="date"
              aria-label="Last day"
              value={form.to}
              onChange={(e) => set({ to: e.target.value })}
            />
            <Segmented label="Hours" options={SCOPE_OPTIONS} value={form.scope} onChange={(scope) => set({ scope })} />
            <Button size="s" variant="primary" disabled={start.busy} onClick={pull}>
              {start.busy ? 'Starting…' : 'Pull'}
            </Button>
          </span>
        </Row>
        {(pulls ?? []).map((p) => (
          <PullRow key={p.id} pull={p} dir={dir} />
        ))}
      </Section>
    </>
  );
}
