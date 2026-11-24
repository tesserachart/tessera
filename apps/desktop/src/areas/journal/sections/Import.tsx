import { valueOf } from '../../../app/tools.ts';
import type { ImportResult, Platform, Side } from '@tessera/protocol';
import {
  Button,
  Combobox,
  Field,
  Loaded,
  Segmented,
  Table,
  TBody,
  Td,
  Th,
  THead,
  TextInput,
  cx,
  formatPrice,
  formatMoney,
} from '@tessera/ui';
import { useRef, useState } from 'react';
import { useCatalog, useJournalAction, useToday } from '../data.ts';
import { clock, dayLabel, plural, sideWord, todayIn } from '../model/format.ts';
import { Empty, PageHead, Panel } from '../kit/index.ts';
import { openTrade, setJournal } from '../store.ts';
import './import.css';

export function Import() {
  return (
    <Loaded label="Loading imports">
      <ImportBody />
    </Loaded>
  );
}

function ImportBody() {
  const cat = valueOf(useCatalog());
  const act = useJournalAction();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [platform, setPlatform] = useState<Platform | 'auto'>('auto');
  const [account, setAccount] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [over, setOver] = useState(false);
  const imported = (cat?.accounts ?? []).filter((a) => a.origin !== 'broker');
  const run = async (f: { name: string; text: string }, p: Platform | 'auto', acct: string) => {
    setError(null);
    setDone(null);
    try {
      const r = await act('journal.preview_import', {
        csv: f.text,
        filename: f.name,
        ...(p === 'auto' ? {} : { platform: p }),
        ...(acct ? { account: imported.some((a) => a.id === acct) ? { id: acct } : { name: acct } } : {}),
      });
      setPreview(r);
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const take = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const next = { name: f.name, text: await f.text() };
    setFile(next);
    void run(next, platform, account);
  };
  const commit = async () => {
    if (!file || !preview) return;
    try {
      const r = await act('journal.import_csv', {
        csv: file.text,
        filename: file.name,
        ...(platform === 'auto' ? {} : { platform }),
        ...(account ? { account: imported.some((a) => a.id === account) ? { id: account } : { name: account } } : {}),
      });
      setDone(r);
      setPreview(null);
      setFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const platforms = cat?.platforms ?? [];
  const step = done ? 4 : preview ? 3 : file ? 2 : 1;
  return (
    <div className="ji-page">
      <PageHead title="Import trades" />
      <div className="ji-body">
        <ol className="ji-steps" aria-label="Steps">
          {['Platform & account', 'Upload', 'Preview', 'Done'].map((label, i) => (
            <li key={label} className={cx(i + 1 === step && 'is-on', i + 1 < step && 'is-done')}>
              <span className="ji-step-n">{i + 1 < step ? '✓' : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <Panel chrome="upload" title="Import a broker export">
          <div className="ji-platforms" role="radiogroup" aria-label="Platform">
            <button
              type="button"
              role="radio"
              aria-checked={platform === 'auto'}
              className={cx('ji-platform', platform === 'auto' && 'is-on')}
              onClick={() => {
                setPlatform('auto');
                if (file) void run(file, 'auto', account);
              }}
            >
              <b>Auto-detect</b>
              <span className="text-t3 text-(length:--text-meta) leading-[14px]">
                Read the platform from the file’s columns
              </span>
            </button>
            {platforms.map((p) => (
              <button
                type="button"
                role="radio"
                key={p.id}
                aria-checked={platform === p.id}
                className={cx('ji-platform', platform === p.id && 'is-on')}
                onClick={() => {
                  setPlatform(p.id);
                  if (file) void run(file, p.id, account);
                }}
              >
                <b>{p.name}</b>
                <span className="text-t3 text-(length:--text-meta) leading-[14px]">{p.hint}</span>
              </button>
            ))}
          </div>
          <div className="jr-import-form">
            <Field
              label="Into the account"
              htmlFor="jr-account"
              help="A connection’s own accounts fill themselves; imports go to accounts of their own."
            >
              <Combobox
                id="jr-account"
                label="Account"
                value={account || null}
                onValueChange={(v) => {
                  setAccount(v);
                  if (file) void run(file, platform, v);
                }}
                placeholder="A new account named after the platform"
                options={imported.map((a) => ({ value: a.id, label: a.name }))}
                custom={(q) => (q.trim() ? { value: q.trim(), label: `New account “${q.trim()}”` } : null)}
              />
            </Field>
          </div>
          <div
            className={cx('jr-drop', over && 'is-over')}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void take(e.dataTransfer.files);
            }}
          >
            <span>{file ? file.name : 'Drop a CSV export here'}</span>
            <Button size="s" onClick={() => input.current?.click()}>
              Pick a file
            </Button>
            <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => void take(e.target.files)} />
          </div>
          {error ? (
            <p className="jr-error" data-selectable>
              {error}
            </p>
          ) : null}
          {done ? (
            <p className="jr-done">
              {plural(done.newFills, 'fill')} imported as {plural(done.trades, 'trade')}
              {done.duplicates ? `; ${plural(done.duplicates, 'fill')} the journal already had` : ''}.{' '}
              <Button
                size="s"
                variant="quiet"
                onClick={() =>
                  setJournal({
                    section: 'trades',
                    trade: null,
                    filter: done.accountId ? { accounts: [done.accountId] } : {},
                  })
                }
              >
                See them
              </Button>
            </p>
          ) : null}
        </Panel>
        {preview ? (
          <Panel
            chrome="preview"
            title="Before it is imported"
            description="Net from the contract spec, beside the platform’s own P&L"
            actions={
              <Button variant="primary" size="s" disabled={!preview.newFills} onClick={() => void commit()}>
                {preview.newFills ? `Import ${plural(preview.trades, 'trade')}` : 'Nothing new'}
              </Button>
            }
          >
            <p className="jr-sum">
              {preview.format} · {plural(preview.rows, 'row')} · {plural(preview.fills, 'fill')} ·{' '}
              {plural(preview.trades, 'trade')}
              {preview.duplicates ? ` · ${plural(preview.duplicates, 'fill')} already in the journal` : ''}
            </p>
            {preview.warnings.map((w) => (
              <p key={w} className="text-t3 jr-warn">
                {w}
              </p>
            ))}
            {preview.errors.length ? (
              <details className="jr-errors">
                <summary>{plural(preview.errors.length, 'row')} not read</summary>
                <ul data-selectable>
                  {preview.errors.slice(0, 50).map((e) => (
                    <li key={`${String(e.line)}-${e.field ?? ''}`}>
                      Line {e.line}
                      {e.field ? ` · ${e.field}` : ''}: {e.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <Table className="jr-table">
              <THead>
                <tr>
                  <Th>Date</Th>
                  <Th>Contract</Th>
                  <Th>Side</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Entry</Th>
                  <Th align="right">Exit</Th>
                  <Th align="right">Net (spec)</Th>
                  <Th align="right">Platform</Th>
                </tr>
              </THead>
              <TBody>
                {preview.preview.map((t, i) => (
                  <tr key={i}>
                    <Td className="t3">
                      {dayLabel(todayIn(undefined, t.openedAt / 1e6))} {clock(t.openedAt)}
                    </Td>
                    <Td>
                      <b>{t.symbol}</b> <span className="text-t3">{t.instrument}</span>
                    </Td>
                    <Td className={t.side === 'buy' ? 'up' : 'down'}>{sideWord(t.side)}</Td>
                    <Td align="right">{t.qty}</Td>
                    <Td align="right">{formatPrice(t.entryPrice, t.priceDecimals)}</Td>
                    <Td align="right">{t.exitPrice === null ? 'Open' : formatPrice(t.exitPrice, t.priceDecimals)}</Td>
                    <Td align="right" className={t.netPnl > 0 ? 'up' : t.netPnl < 0 ? 'down' : undefined}>
                      {formatMoney(t.netPnl, { signed: true })}
                    </Td>
                    <Td align="right" className="t3">
                      {t.reportedPnl === null ? '' : formatMoney(t.reportedPnl, { signed: true })}
                    </Td>
                  </tr>
                ))}
              </TBody>
            </Table>
            {preview.trades > preview.preview.length ? (
              <p className="text-t3 jr-quiet">
                The first {preview.preview.length} of {plural(preview.trades, 'trade')}.
              </p>
            ) : null}
          </Panel>
        ) : null}
        <div className="jr-import-low">
          <Panel chrome="imports" title="Imports" description="Undo takes an import's trades back out">
            {(cat?.imports ?? []).length ? (
              <ol className="jr-imports">
                {(cat?.imports ?? []).map((i) => (
                  <li key={i.id}>
                    <span>
                      <b>{i.filename ?? i.format}</b>
                      <span className="text-t3">
                        {' '}
                        · {i.format} · {plural(i.fills, 'fill')} · {dayLabel(todayIn(undefined, i.createdAt / 1e6))}
                      </span>
                    </span>
                    <Button
                      size="s"
                      variant="destructive"
                      what="import"
                      onClick={() => void act('journal.delete_import', { id: i.id })}
                    >
                      Undo
                    </Button>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty compact icon="import" title="Nothing imported yet" />
            )}
          </Panel>
          <LogTrade />
        </div>
      </div>
    </div>
  );
}

function LogTrade() {
  const act = useJournalAction();
  const cat = valueOf(useCatalog());
  const [side, setSide] = useState<Side>('buy');
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const today = useToday();
  if (!open)
    return (
      <Panel
        chrome="manual-entry"
        title="Log a trade by hand"
        description="It goes to an account of its own."
        actions={
          <Button size="s" onClick={() => setOpen(true)}>
            Manual entry
          </Button>
        }
      />
    );
  return (
    <Panel chrome="manual-entry" title="Log a trade by hand">
      <form
        className="jr-logform"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const s = (k: string) => {
            const v = f.get(k);
            return typeof v === 'string' ? v.trim() : '';
          };
          const n = (k: string) => (s(k) === '' ? undefined : Number(s(k)));
          const at = (d: string, t: string) => (s(d) && s(t) ? new Date(`${s(d)}T${s(t)}`).toISOString() : undefined);
          const entryTime = at('entryDate', 'entryTime');
          if (!entryTime) {
            setMsg('The entry needs its date and time.');
            return;
          }
          const exitTime = at('exitDate', 'exitTime');
          const exitPrice = n('exitPrice');
          void act('journal.log_trade', {
            account: s('account') || 'Logged by hand',
            symbol: s('symbol'),
            side,
            qty: n('qty') ?? 1,
            entryPrice: n('entryPrice') ?? 0,
            entryTime,
            ...(exitPrice !== undefined && exitTime ? { exitPrice, exitTime } : {}),
            ...(n('fees') !== undefined ? { fees: n('fees') } : {}),
            ...(n('stop') !== undefined ? { stopPrice: n('stop') } : {}),
            ...(n('target') !== undefined ? { targetPrice: n('target') } : {}),
          }).then(
            (t) => {
              setMsg(null);
              setOpen(false);
              openTrade(t.id);
            },
            (err: unknown) => setMsg(err instanceof Error ? err.message : String(err)),
          );
        }}
      >
        <Field label="Account" htmlFor="jr-l-acct">
          <TextInput id="jr-l-acct" name="account" list="jr-l-accts" placeholder="Logged by hand" />
        </Field>
        <datalist id="jr-l-accts">
          {(cat?.accounts ?? [])
            .filter((a) => a.origin !== 'broker')
            .map((a) => (
              <option key={a.id} value={a.name} />
            ))}
        </datalist>
        <Field label="Contract" htmlFor="jr-l-sym">
          <TextInput id="jr-l-sym" name="symbol" placeholder="NQZ6, MES, ES" required />
        </Field>
        <Field label="Side" htmlFor="jr-l-side">
          <Segmented
            id="jr-l-side"
            label="Side"
            value={side}
            onChange={setSide}
            options={[
              { value: 'buy', label: 'Long' },
              { value: 'sell', label: 'Short' },
            ]}
          />
        </Field>
        <Field label="Quantity" htmlFor="jr-l-qty">
          <TextInput id="jr-l-qty" name="qty" inputMode="decimal" defaultValue="1" />
        </Field>
        <Field label="Entry price" htmlFor="jr-l-ep">
          <TextInput id="jr-l-ep" name="entryPrice" inputMode="decimal" required />
        </Field>
        <Field label="Entry date and time" htmlFor="jr-l-ed">
          <span className="jr-pair">
            <TextInput id="jr-l-ed" name="entryDate" type="date" defaultValue={today} />
            <TextInput name="entryTime" type="time" aria-label="Entry time" />
          </span>
        </Field>
        <Field label="Exit price" htmlFor="jr-l-xp" help="Leave the exit empty for a trade still open.">
          <TextInput id="jr-l-xp" name="exitPrice" inputMode="decimal" />
        </Field>
        <Field label="Exit date and time" htmlFor="jr-l-xd">
          <span className="jr-pair">
            <TextInput id="jr-l-xd" name="exitDate" type="date" defaultValue={today} />
            <TextInput name="exitTime" type="time" aria-label="Exit time" />
          </span>
        </Field>
        <Field label="Fees" htmlFor="jr-l-fee">
          <TextInput id="jr-l-fee" name="fees" inputMode="decimal" unit="$" />
        </Field>
        <Field label="Stop · target" htmlFor="jr-l-stop">
          <span className="jr-pair">
            <TextInput id="jr-l-stop" name="stop" inputMode="decimal" placeholder="stop" />
            <TextInput name="target" inputMode="decimal" placeholder="target" aria-label="Target" />
          </span>
        </Field>
        <div className="jr-logform-act">
          {msg ? <span className="jr-error">{msg}</span> : null}
          <Button variant="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Log the trade
          </Button>
        </div>
      </form>
    </Panel>
  );
}
