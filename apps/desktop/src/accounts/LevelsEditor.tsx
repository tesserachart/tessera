import type { BackfillLevelHistoryOutput, LevelSourceInfo } from '@tessera/protocol';
import { Button, Select, SettingsRow } from '@tessera/ui';
import { useState } from 'react';
import { useClock } from '../app/clock.ts';
import { attempt, refreshTools, useHasTool, useToolValue } from '../app/tools.ts';
import { openSettings } from '../areas/settings/store.ts';
import { endSentence } from '../areas/settings/sentence.ts';
import { openConnectionDialog } from './accountsUi.ts';
import { Elapsed } from './ConnectionForm.tsx';
import { backfillRange, backfillSpans, backfillWords, nyDate, requestWords, storedWords } from './providers.ts';

export function LevelsEditor({ info }: { info: LevelSourceInfo }) {
  const requests = requestWords(info.callsToday);
  const asking = [info.schedule, requests].filter(Boolean).join(' · ');
  return (
    <>
      {info.editable ? (
        <SettingsRow compact label="Its spec" help="How Tessera asks it and reads its answer">
          <Button size="s" onClick={() => openConnectionDialog({ kind: 'levels', id: info.providerId })}>
            Edit spec…
          </Button>
        </SettingsRow>
      ) : null}
      {asking ? <SettingsRow compact label="Asks" help={asking} /> : null}
      <HistoryRows info={info} />
      <SettingsRow compact label="How its levels show">
        <Button size="s" variant="quiet" onClick={() => openSettings('levels.providers')}>
          Levels
        </Button>
      </SettingsRow>
    </>
  );
}

function HistoryRows({ info }: { info: LevelSourceInfo }) {
  const clock = useClock();
  const has = useHasTool('intel.list_level_history');
  const q = useToolValue('intel.list_level_history', has ? {} : null, { keepFor: 10_000 });
  const reach = info.history;
  const [shown, setShown] = useState(false);
  const [ticker, setTicker] = useState(reach?.tickers[0]?.ticker ?? '');
  const [span, setSpan] = useState('7');
  const [out, setOut] = useState<BackfillLevelHistoryOutput | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  if (!has) return null;
  const stored = storedWords(q?.series ?? [], info.vendor);
  const recording = q?.recordings.some((r) => r.provider === info.providerId) ?? false;
  const help =
    stored ?? (recording ? 'Recorded as it arrives, while a chart shows what it covers' : 'Nothing stored yet');
  const go = async (dryRun: boolean) => {
    const { from, to } = backfillRange(nyDate(clock.now()), Number(span));
    setBusy(clock.now());
    setFailed(null);
    const r = await attempt(
      'intel.backfill_level_history',
      { provider: info.providerId, ticker, from, to, dryRun },
      { timeoutMs: 600_000 },
    );
    setBusy(null);
    if (!r.ok) {
      setOut(null);
      setFailed(endSentence(r.why));
      return;
    }
    setOut(r.out);
    if (!dryRun) void refreshTools('intel.list_level_history');
  };
  const toAsk = out?.files.filter((f) => f.status === 'would_ask' || f.status === 'later').length ?? 0;
  return (
    <>
      <SettingsRow compact label="History" help={help}>
        {reach ? (
          <Button size="s" variant="quiet" onClick={() => setShown((o) => !o)} aria-expanded={shown}>
            Backfill…
          </Button>
        ) : null}
      </SettingsRow>
      {reach && shown ? (
        <SettingsRow
          compact
          layout="stack"
          label="Backfill"
          help={
            out
              ? backfillWords(out.files, out.imported)
              : `The last ${String(reach.daysBack)} days on this plan. Each file is one request of ${reach.pool}; Tessera asks at most ${String(reach.dailyCap)} a day.`
          }
          error={failed}
        >
          <span className="st-actions">
            <Select
              size="s"
              label="Ticker"
              value={ticker}
              options={reach.tickers.map((t) => ({
                value: t.ticker,
                label: t.ticker === t.instrument ? t.ticker : `${t.ticker} on ${t.instrument}`,
              }))}
              onValueChange={(v) => {
                setTicker(v);
                setOut(null);
              }}
              align="end"
            />
            <Select
              size="s"
              label="Span"
              value={span}
              options={backfillSpans(reach.daysBack)}
              onValueChange={(v) => {
                setSpan(v);
                setOut(null);
              }}
              align="end"
            />
            {busy !== null ? (
              <Elapsed verb={out ? 'Backfilling' : 'Listing the files'} since={busy} />
            ) : toAsk > 0 ? (
              <Button size="s" variant="primary" onClick={() => void go(false)}>
                {`Backfill ${String(Math.min(toAsk, 20))} ${toAsk === 1 ? 'file' : 'files'}`}
              </Button>
            ) : out ? null : (
              <Button size="s" onClick={() => void go(true)} disabled={!ticker}>
                List the files
              </Button>
            )}
          </span>
        </SettingsRow>
      ) : null}
    </>
  );
}
