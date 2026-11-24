import type { ImportLevelHistoryOutput } from '@tessera/protocol';
import { Button, Select, SettingsRow } from '@tessera/ui';
import { useRef, useState } from 'react';
import { refreshTools, useHasTool, useToolValue, runToolResult } from '../../../app/tools.ts';
import { askAnalyst } from '../../../shell/tradeActions.ts';
import { dateValue } from '../../research/model.ts';
import { adapterOptions, coverageGroups, importLine, importSummary } from '../levelHistory.ts';
import { Fact, Row, Section } from '../parts.tsx';

type Picked = { name: string; text: string };

const PICKER_LIMIT = 32e6;

export function LevelHistorySection({ providerVendors = [] }: { providerVendors?: readonly string[] }) {
  const has = useHasTool('intel.list_level_history');
  const q = useToolValue('intel.list_level_history', has ? {} : null, { keepFor: 10_000 });
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setAdapter] = useState<string | null>(null);
  const [file, setFile] = useState<Picked | null>(null);
  const [preview, setPreview] = useState<ImportLevelHistoryOutput | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!has) return null;
  const data = q;
  const groups = coverageGroups((data?.series ?? []).filter((s) => !providerVendors.includes(s.vendor)));
  const options = adapterOptions(data?.adapters ?? []);
  const adapter = chosen ?? options[0]?.value ?? '';
  const since = (data?.recordings ?? [])
    .filter((r) => !providerVendors.includes(r.vendor))
    .map((r) => `${r.vendor} since ${dateValue(r.since)}`)
    .join(', ');

  const run = async (f: Picked, a: string, dryRun: boolean) => {
    setBusy(true);
    setFailed(null);
    setSaid(null);
    try {
      const r = await runToolResult(
        'intel.import_level_history',
        { text: f.text, fileName: f.name, adapter: { kind: 'saved', vendor: a }, dryRun },
        { timeoutMs: 600_000 },
      );
      if (!r.ok || !r.output) throw new Error(r.error?.message ?? 'It did not go through.');
      if (dryRun) {
        setPreview(r.output);
      } else {
        setPreview(null);
        setFile(null);
        setSaid(importSummary(r.output)[0] ?? null);
        void refreshTools('intel.list_level_history');
      }
    } catch (e) {
      setPreview(null);
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const take = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    if (f.size > PICKER_LIMIT) {
      setPreview(null);
      setFailed(
        `${f.name} is ${String(Math.round(f.size / 1e6))} MB: too large to send from here. Ask the analyst to import it by its path.`,
      );
      return;
    }
    const picked = { name: f.name, text: await f.text() };
    setFile(picked);
    void run(picked, adapter, true);
  };
  const undo = async (id: string) => {
    const r = await runToolResult('intel.undo_level_import', { importId: id });
    if (!r.ok) setFailed(r.error?.message ?? 'It did not go through.');
    void refreshTools('intel.list_level_history');
  };

  return (
    <div className="st-group">
      <Section
        id="levels.history"
        description={
          groups.length === 0
            ? providerVendors.length
              ? 'Each provider’s own is on its row in Connections. Studies read levels from here.'
              : 'Nothing stored yet. A source’s levels record while a chart shows an instrument it covers.'
            : since
              ? `Recorded as they arrive (${since}), imported or backfilled. Studies read levels from here.`
              : undefined
        }
      >
        {groups.map((g) => (
          <SettingsRow key={g.key} label={g.title} help={g.levels}>
            <Fact>
              {g.span}
              {g.origins ? ` · ${g.origins}` : ''}
            </Fact>
          </SettingsRow>
        ))}
        <Row id="levels.historyImport" error={failed}>
          <span className="st-actions">
            {options.length > 1 ? (
              <Select
                label="Read the file as"
                value={adapter}
                onValueChange={(v) => {
                  setAdapter(v);
                  if (file) void run(file, v, true);
                }}
                options={options}
                align="end"
              />
            ) : null}
            <Button size="s" disabled={busy} onClick={() => input.current?.click()}>
              {busy && !preview ? 'Reading…' : 'Import history…'}
            </Button>
            <input
              ref={input}
              type="file"
              accept=".csv,.json,.jsonl,.txt,text/csv,application/json"
              hidden
              onChange={(e) => {
                void take(e.target.files);
                e.target.value = '';
              }}
            />
          </span>
        </Row>
        {preview && file ? (
          <SettingsRow label={file.name} help={importSummary(preview).slice(1).join(' ')} layout="stack">
            <span className="st-actions">
              <Fact>{importSummary(preview)[0]}</Fact>
              <Button
                size="s"
                variant="primary"
                disabled={busy || preview.imported === 0}
                onClick={() => void run(file, adapter, false)}
              >
                {preview.imported === 0 ? 'Nothing new' : `Import ${preview.imported.toLocaleString('en-US')} values`}
              </Button>
              <Button
                size="s"
                variant="quiet"
                onClick={() => {
                  setPreview(null);
                  setFile(null);
                }}
              >
                Cancel
              </Button>
            </span>
          </SettingsRow>
        ) : null}
        {said ? (
          <SettingsRow label="Imported">
            <Fact>{said}</Fact>
          </SettingsRow>
        ) : null}
        <Row id="levels.historyAnalyst">
          <Button
            size="s"
            variant="quiet"
            onClick={() =>
              askAnalyst(
                'I have a file of past levels from a vendor to import into the level history. Ask me for its path, preview it (intel.preview_file), propose how to read it, show me the dry run, and import it when I say go.',
              )
            }
          >
            Ask the analyst
          </Button>
        </Row>
      </Section>
      {(data?.imports.length ?? 0) > 0 ? (
        <Section id="levels.historyImports">
          {data!.imports.map((i) => (
            <SettingsRow key={i.id} label={i.fileName ?? i.id} help={importLine(i, (ns) => dateValue(ns))}>
              <span className="st-actions">
                <Fact>{i.imported.toLocaleString('en-US')} values</Fact>
                <Button size="s" variant="destructive" what={i.fileName ?? i.id} onClick={() => void undo(i.id)}>
                  Undo
                </Button>
              </span>
            </SettingsRow>
          ))}
        </Section>
      ) : null}
    </div>
  );
}
