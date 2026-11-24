import type { DataFile } from '@tessera/protocol';
import { Button, SettingsRow } from '@tessera/ui';
import { useState } from 'react';
import { refreshTools, useHasTool, useToolValue, runToolResult } from '../../../app/tools.ts';
import { Fact, Row, Section } from '../parts.tsx';
import { sizeWords } from '../words.ts';
import { SavedTradesSections } from './SavedTrades.tsx';

const FILE_WORD: Record<DataFile['what'], { label: string; help?: string }> = {
  database: {
    label: 'Database',
    help: 'Settings, workspaces, the journal, research, analyst sessions, orders and fills',
  },
  blobs: { label: 'Vendor responses' },
  depth: { label: 'Order book archive' },
  ticks: { label: 'Saved trades' },
  logs: { label: 'Logs', help: 'Every secret taken out' },
  agents: { label: 'Analyst sessions', help: 'The providers’ working directory' },
  backups: { label: 'Backups' },
};

export function Data() {
  const has = useHasTool('runtime.data_info');
  const q = useToolValue('runtime.data_info', has ? {} : null, { keepFor: 10_000 });
  const info = q;
  const [backup, setBackup] = useState<{ busy: boolean; said: string | null; failed: string | null }>({
    busy: false,
    said: null,
    failed: null,
  });
  const backUp = () => {
    setBackup({ busy: true, said: null, failed: null });
    void runToolResult('runtime.backup', {}, { timeoutMs: 120_000 })
      .then((r) =>
        setBackup(
          r.ok && r.output
            ? { busy: false, said: `${r.output.path} · ${sizeWords(r.output.bytes)}`, failed: null }
            : { busy: false, said: null, failed: r.error?.message ?? 'It did not go through.' },
        ),
      )
      .catch((e: unknown) => setBackup({ busy: false, said: null, failed: e instanceof Error ? e.message : String(e) }))
      .finally(() => void refreshTools('runtime.data_info'));
  };
  return (
    <>
      <Section
        id="data.where"
        description={
          info?.dataDir ? undefined : info ? 'This runtime keeps nothing on disk: it runs in memory.' : undefined
        }
      >
        {info?.dataDir ? (
          <SettingsRow data-setting="data.dir" label="Data directory" help={`${sizeWords(info.totalBytes)} in all`}>
            <Fact code>{info.dataDir}</Fact>
          </SettingsRow>
        ) : null}
        {(info?.files ?? []).map((f) => (
          <SettingsRow
            key={f.what}
            data-setting={`data.file.${f.what}`}
            label={FILE_WORD[f.what].label}
            help={FILE_WORD[f.what].help}
          >
            <Fact>{sizeWords(f.bytes)}</Fact>
          </SettingsRow>
        ))}
      </Section>
      {info && info.counts.length > 0 ? (
        <Section id="data.stored">
          {info.counts.map((c) => (
            <SettingsRow key={c.what} data-setting={`data.count.${c.what}`} label={c.what}>
              <Fact>{c.count.toLocaleString('en-US')}</Fact>
            </SettingsRow>
          ))}
        </Section>
      ) : null}
      {info?.dataDir ? <SavedTradesSections dataDir={info.dataDir} /> : null}
      {info?.dataDir ? (
        <Section id="data.backup">
          <Row id="data.backupNow" help={backup.said ?? undefined} error={backup.failed}>
            <Button size="s" disabled={backup.busy} onClick={backUp}>
              {backup.busy ? 'Backing up…' : 'Back up now'}
            </Button>
          </Row>
        </Section>
      ) : null}
    </>
  );
}
