import type { Alert, AlertFire } from '@tessera/protocol';
import { Button, ScrollArea, Table, TBody, Td, Th, Tr, cx, PRICE_TEXT } from '@tessera/ui';
import { useState, type MouseEvent } from 'react';
import { displaySymbol, useInstrumentSpec } from '../market/instruments.ts';
import { listOrder, markPrice } from './store.ts';
import { deliverWords, priceWords, stateWords, whenWords } from './words.ts';

export interface AlertActions {
  edit: (a: Alert, opts: { decimals: number; tick: number }, at: { x: number; y: number }) => void;
  pause: (a: Alert, paused: boolean) => Promise<string | null>;
  remove: (a: Alert) => Promise<string | null>;
}

function AlertRow({ a, act, nowMs }: { a: Alert; act: AlertActions; nowMs: number }) {
  const spec = useInstrumentSpec(a.instrument);
  const dp = spec?.priceDecimals;
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const st = stateWords(a);
  const go = (p: Promise<string | null>) => {
    setBusy(true);
    setRefused(null);
    void p.then((why) => {
      setBusy(false);
      setRefused(why);
    });
  };
  const watching = a.status === 'active' || a.status === 'paused';
  const edit = (e: MouseEvent) =>
    act.edit(a, { decimals: dp ?? 2, tick: spec?.tickSize ?? 0.01 }, { x: e.clientX, y: e.clientY });
  return (
    <Tr className={cx(a.status === 'paused' && 'is-paused', !watching && 'is-spent')} data-alert={a.id}>
      <Td className="sym-cell">
        <b>{displaySymbol(a.instrument)}</b>
      </Td>
      <Td className="al-title">
        <span className="al-cond">{a.title}</span>
        {a.message ? <span className="text-t3 al-msg"> · {a.message}</span> : null}
      </Td>
      <Td align="right" className={PRICE_TEXT}>
        {watching ? priceWords(markPrice(a), dp) : ''}
      </Td>
      <Td className="al-state">
        <span className={cx('al-word', `is-${a.status}`, a.live.problem && 'is-waiting')}>{st.word}</span>
        {st.note ? <span className="text-t3 al-note"> · {st.note}</span> : null}
      </Td>
      <Td className="t3">{a.repeat === 'every' ? `Every · ${String(a.cooldownSecs)}s` : 'Once'}</Td>
      <Td className={cx('t3', PRICE_TEXT)}>
        {a.fireCount > 0 && a.firedAt !== null ? `${String(a.fireCount)} · ${whenWords(a.firedAt, nowMs)}` : ''}
      </Td>
      <Td className="t3 col-deliver">{deliverWords(a)}</Td>
      <Td align="right" className="col-act">
        <span className="pz-acts">
          {refused ? <span className="pz-refused">{refused}</span> : null}
          <Button size="s" variant="quiet" className="pz-hover" disabled={busy} onClick={edit}>
            Edit
          </Button>
          <Button
            size="s"
            variant="quiet"
            className="pz-hover"
            disabled={busy}
            onClick={() => go(act.pause(a, a.status === 'active'))}
          >
            {a.status === 'active' ? 'Pause' : watching ? 'Resume' : 'Re-arm'}
          </Button>
          <Button
            size="s"
            variant="quiet"
            className="pz-hover"
            disabled={busy}
            aria-label={`Delete ${a.title}`}
            onClick={() => go(act.remove(a))}
          >
            Delete
          </Button>
        </span>
      </Td>
    </Tr>
  );
}

function FireRow({ f, nowMs }: { f: AlertFire; nowMs: number }) {
  const spec = useInstrumentSpec(f.instrument);
  const outcome: string[] = [];
  if (f.discord) outcome.push(f.discord === 'sent' ? 'Discord' : `Discord: ${f.discord}`);
  if (f.analyst) outcome.push(f.analyst === 'asked' ? 'Analyst asked' : `Analyst: ${f.analyst}`);
  return (
    <Tr data-fire={f.id}>
      <Td className="sym-cell">
        <b>{displaySymbol(f.instrument)}</b>
      </Td>
      <Td className="al-title">
        <span className="al-cond">{f.title}</span>
        {f.message ? <span className="text-t3 al-msg"> · {f.message}</span> : null}
      </Td>
      <Td align="right" className={PRICE_TEXT}>
        {priceWords(f.price, spec?.priceDecimals)}
      </Td>
      <Td className="t3">{f.source}</Td>
      <Td />
      <Td className={cx('t3', PRICE_TEXT)}>{whenWords(f.at, nowMs)}</Td>
      <Td className="t3 col-deliver">{outcome.join(' · ')}</Td>
      <Td />
    </Tr>
  );
}

export function AlertsList({
  alerts,
  fires,
  act,
  nowMs,
}: {
  alerts: ReadonlyMap<string, Alert> | null;
  fires: readonly AlertFire[];
  act: AlertActions;
  nowMs: number;
}) {
  const { watching, spent } = listOrder(alerts);
  if (alerts === null) return null;
  if (watching.length + spent.length + fires.length === 0) {
    return (
      <p className="pz-flat al-empty">
        No alerts. Right-click the chart at a price, or a level, a line or an indicator.
      </p>
    );
  }
  return (
    <ScrollArea className="pz-scroll">
      <Table className="pz-table al-table" aria-label="Alerts and their firings">
        <TBody>
          <tr className="pz-cols">
            <Th className="pz-group">{`Watching · ${String(watching.length)}`}</Th>
            <Th>Condition</Th>
            <Th align="right">At</Th>
            <Th>State</Th>
            <Th>Fires</Th>
            <Th>Fired</Th>
            <Th className="col-deliver">Goes to</Th>
            <Th className="col-act" />
          </tr>
          {watching.map((a) => (
            <AlertRow key={a.id} a={a} act={act} nowMs={nowMs} />
          ))}
          {spent.map((a) => (
            <AlertRow key={a.id} a={a} act={act} nowMs={nowMs} />
          ))}
        </TBody>
        {fires.length > 0 ? (
          <TBody>
            <tr className="pz-cols">
              <Th className="pz-group">{`Fired · ${String(fires.length)}`}</Th>
              <Th>Condition</Th>
              <Th align="right">Price</Th>
              <Th>Data</Th>
              <Th />
              <Th>When</Th>
              <Th className="col-deliver">Delivered</Th>
              <Th className="col-act" />
            </tr>
            {fires.map((f) => (
              <FireRow key={f.id} f={f} nowMs={nowMs} />
            ))}
          </TBody>
        ) : null}
      </Table>
    </ScrollArea>
  );
}
