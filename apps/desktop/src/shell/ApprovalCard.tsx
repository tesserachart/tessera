import { normalizeEpochMs, RequestTimeout, type Approval, type ApprovalDecision } from '@tessera/protocol';
import { DraftCard, formatClock, formatPrice, type DraftRow } from '@tessera/ui';
import { useState } from 'react';
import { useNow } from '../app/runtimeContext.ts';
import { useInstrumentSpec } from '../market/instruments.ts';
import { useQuote } from '../market/quotes.ts';
import { dismissDraft } from '../analyst/analystStore.ts';
import {
  applyEdit,
  approvalEnv,
  asOrderPreview,
  describeApproval,
  draftedBy,
  editFields,
  entryLegs,
  hasLegsFromForm,
  isExpired,
  setLegsFromForm,
} from './approval.ts';
import { DraftOrderEdit } from './DraftOrderEdit.tsx';
import { DEFAULT_OCO, instrumentRoot, legWords } from './oco.ts';
import { draftOrderInput } from './orderEdit.ts';
import { useShellData } from './shellData.ts';
import { mathOf, resolveOco } from './tradeContext.ts';
import { accountUpdatesStore } from '../app/portfolio.ts';
import { useStore } from '../app/store.ts';
import { useTradeSettings } from '../state/tradeSettings.ts';
import { failureText, ranUnread, useToolValue } from '../app/tools.ts';
import { AlreadySending, approvalIntent, resolveNow, runtimeFailureWords, watchOrderLate } from './tradeActions.ts';
import { useDisplayZone } from '../state/timeZone.ts';

function timeLeft(staleAtMs: number, nowMs: number): string {
  const ms = staleAtMs - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')} left`;
}

export function ApprovalCard({
  approval,
  more,
  sessionTitle,
}: {
  approval: Approval;
  more: number;
  sessionTitle: string | null;
}) {
  const now = useNow();
  const zone = useDisplayZone();
  const { accounts } = useShellData();
  const spec = useInstrumentSpec(approval.instrument);
  const precision = spec?.priceDecimals ?? 2;
  const view = describeApproval(approval, precision);
  const order = asOrderPreview(approval.preview);
  const quote = useQuote(spec?.instrument ?? approval.instrument);
  const fields = editFields(approval.input);
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [approvedAt, setApprovedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const external = approval.origin.kind === 'external';
  const clients = useToolValue('mcp.list_clients', external ? {} : null)?.clients;
  const expired = isExpired(approval, now);
  const env = approvalEnv(approval);
  const accountId = order?.request.accountId ?? null;
  const accountName = accounts.find((a) => a.id === accountId)?.displayName ?? accountId ?? 'no account';
  const balance = useStore(
    accountUpdatesStore,
    (us) => us?.find((u) => u.account.id === accountId)?.summary.netLiq.amount ?? null,
  );
  const instrument = order?.request.instrument ?? null;
  const root = instrument ? instrumentRoot(instrument, spec?.root ?? null) : null;
  const oco = useTradeSettings((s) => (accountId && root ? resolveOco(s, accountId, root) : DEFAULT_OCO));
  const math = mathOf(spec ?? null, instrument);
  const market = math ? { ...math, qty: order?.request.qty ?? 0, balance } : null;
  const yours = market && !hasLegsFromForm(approval.draftId) ? { oco, market, quote } : null;
  const legs = order ? entryLegs(approval, order, yours) : null;
  const orderInput = draftOrderInput(approval.tool, legs?.input ?? approval.input);

  const resolve = async (decision: ApprovalDecision, input?: Approval['input']): Promise<boolean> => {
    setBusy(decision);
    setError(null);
    if (decision === 'approve') setApprovedAt(now);
    const intent = approvalIntent(approval.id, decision);
    try {
      await resolveNow({
        approvalId: approval.id,
        decision,
        previewHash: approval.previewHash,
        ...(input === undefined ? {} : { input }),
      });
      return true;
    } catch (err) {
      if (err instanceof AlreadySending || ranUnread(err)) return true;
      setError(runtimeFailureWords(err) ?? failureText(err));
      if (err instanceof RequestTimeout) {
        const stop = watchOrderLate((update) => {
          if (update.key !== intent) return;
          stop();
          setError(update.result.tone === 'err' ? update.result.text : null);
          setBusy(null);
          setApprovedAt(null);
        });
        return false;
      }
      setBusy(null);
      setApprovedAt(null);
      return false;
    }
  };

  if (editing && orderInput) {
    return (
      <DraftOrderEdit
        input={orderInput}
        busy={busy === 'edit'}
        error={error}
        onSave={(next) => {
          if (!next) {
            setEditing(null);
            return;
          }
          setLegsFromForm(approval.draftId, true);
          void resolve('edit', next).then((sent) => {
            if (!sent) setLegsFromForm(approval.draftId, false);
          });
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (editing) {
    return (
      <section className="approval is-editing" aria-label="Edit the draft">
        <form
          className="edit"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              void resolve('edit', applyEdit(approval.input, fields, editing));
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          {fields.map((f) => (
            <label key={f.path}>
              <span>{f.label}</span>
              <input
                type="text"
                inputMode={f.kind === 'number' ? 'decimal' : undefined}
                value={editing[f.path] ?? f.value}
                onChange={(e) => setEditing({ ...editing, [f.path]: e.target.value })}
              />
            </label>
          ))}
          <div className="act">
            <button type="submit" className="t-btn s" disabled={busy !== null}>
              {busy === 'edit' ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="t-btn quiet s" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
        {error ? (
          <p className="err" role="alert" data-selectable>
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  const r = order?.request ?? null;
  const resting = r ? (r.orderType === 'limit' ? r.limitPrice : r.stopPrice) : null;
  const last = quote?.last ?? null;
  const d = resting !== null && last !== null ? resting - last : null;
  const ticks = d !== null && spec ? Math.round(Math.abs(d) / spec.tickSize) : null;
  const rows: DraftRow[] = [];
  const bracket = legs ? legs.bracket : (r?.bracket ?? null);
  const stopWords = legWords(bracket, 'stop', precision);
  const targetWords = legWords(bracket, 'target', precision);
  const risk = legs ? legs.risk : (view.facts.find((f) => f.label === 'Risk')?.value ?? null);
  if (stopWords !== null) {
    rows.push({ label: 'Stop', price: stopWords, value: risk?.replace(/^\$/, '−$') });
  } else if (legs) {
    rows.push({ label: 'Stop', text: 'None' });
  }
  if (targetWords !== null) {
    rows.push({ label: 'Target', price: targetWords });
  } else if (legs) {
    rows.push({ label: 'Target', text: 'None' });
  }
  const after = view.facts.find((f) => f.label === 'After fill');
  if (after) rows.push({ label: 'After fill', text: after.value, wide: true });
  if (!r) for (const f of view.facts) rows.push({ label: f.label, text: f.value });
  const block = view.checks.find((c) => c.severity === 'block') ?? null;
  const created = normalizeEpochMs(approval.createdAt);
  const plan = [sessionTitle, Number.isFinite(created) ? formatClock(created, zone, false) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="t-draft-slot">
      {more > 0 ? <p className="t-draft-more">+{more} waiting</p> : null}
      <DraftCard
        env={env}
        account={view.order && view.copies ? `${accountName} ${view.copies.words}` : accountName}
        plan={plan || undefined}
        left={expired ? undefined : timeLeft(normalizeEpochMs(approval.staleAt), now)}
        order={view.order ? `${view.order.side} ${view.order.qty} ${view.order.symbol}` : (view.title ?? 'Change')}
        pre={view.order?.price ? view.order.pre : undefined}
        price={view.order?.price ?? undefined}
        post={view.order?.price ? view.order.post : (view.order?.post ?? view.restatement ?? undefined)}
        distance={
          d === null || d === 0 ? undefined : `${formatPrice(Math.abs(d), precision)} ${d < 0 ? 'below' : 'above'} last`
        }
        distanceWide={ticks ? ` · ${String(ticks)} ticks` : undefined}
        rows={rows}
        by={{
          text: [draftedBy(approval.origin, sessionTitle, clients), legs?.yours].filter(Boolean).join(' · '),
        }}
        envLabel={env === 'paper' ? 'on paper' : `on ${accountName}`}
        refused={block ? { l1: 'Refused', l2: block.message } : null}
        expired={expired ? { l1: 'Expired', l2: 'Not sent' } : null}
        approved={
          approvedAt !== null ? { at: formatClock(approvedAt, zone, true), sending: `Sending to ${env}` } : null
        }
        armKey={approval.previewHash}
        onApprove={() => void resolve('approve', legs?.input ?? undefined)}
        onEdit={fields.length > 0 ? () => setEditing({}) : undefined}
        onReject={expired ? () => dismissDraft(approval.id) : () => void resolve('reject')}
      />
      {error ? (
        <p className="err" role="alert" data-selectable>
          {error}
        </p>
      ) : null}
    </div>
  );
}
