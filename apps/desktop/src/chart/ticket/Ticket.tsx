import type { AccountUpdate, TradingAccount } from '@tessera/protocol';
import {
  Button,
  Readout,
  ReadoutRow,
  Segmented,
  SettingsRow,
  Stepper,
  Switch,
  Tooltip,
  formatMoney,
  formatPrice,
  parseStep,
  toneOf,
} from '@tessera/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccountSwitcher } from '../../accounts/AccountSwitcher.tsx';
import { copiesTip, groupOn, useCopyGroups } from '../../accounts/copy.ts';
import { orThrow, switchEdits, useConnectionCall } from '../../accounts/connectionCall.ts';
import { useDraft } from '../../app/overlay.ts';
import { useLiveDrafts } from '../../app/orders.ts';
import { useAccountUpdates } from '../../app/portfolio.ts';
import { addConnection } from '../../accounts/navigate.ts';
import { useQuote } from '../../market/quotes.ts';
import { orderEntrySwitchOf, useConnectionList } from '../../shell/orderEntry.ts';
import { pricesStale, streamStale, useFeeds, type ReadoutStale } from '../../shell/freshness.ts';
import { useShellData } from '../../shell/shellData.ts';
import { instrumentRoot } from '../../shell/oco.ts';
import { mathOf, useOco } from '../../shell/tradeContext.ts';
import { nextPanelStep, settlePanelRequest, usePanelRequest } from '../../state/panelRequests.ts';
import { patchTicket } from '../../state/tickets.ts';
import { useTradeSettingsSync } from '../../state/tradeSettings.ts';
import { groupBrackets } from '../brackets.ts';
import { BracketSection } from './BracketSection.tsx';
import { ContractPicker } from './ContractPicker.tsx';
import { OrderGrid } from './OrderGrid.tsx';
import { TicketOrders } from './TicketOrders.tsx';
import { positionReadout, tradeRows, type PositionReadout } from './tradeRows.ts';
import {
  chartMathOf,
  px,
  useTicketInstrument,
  useTicketModel,
  type TicketChart,
  type TicketInstrument,
  type TicketModel,
} from './useTicketModel.ts';
import { pickTicketAccount, useTicketTrade, type TicketTrade } from './useTicketTrade.ts';

export type { TicketChart } from './useTicketModel.ts';

const QTY_PRESETS = ['1', '2', '5', '10'] as const;

export function Ticket({ chart }: { chart: TicketChart }) {
  useTradeSettingsSync();
  const trade = useTicketTrade(chart.tileId);
  const { accounts } = useShellData();
  const accountUpdates = useAccountUpdates() ?? [];
  const inst = useTicketInstrument(chart, trade.update?.account.id ?? null);
  useAskedSetup(chart, trade, inst, accounts);
  return (
    <section className="tk" aria-label={`Ticket: ${inst.symbol}`}>
      <header className="tk-head">
        <ContractPicker tileId={chart.tileId} inst={inst} />
        {trade.update ? (
          <AccountSwitcher
            updates={accountUpdates}
            current={trade.update}
            instrument={inst.instrument}
            onPick={(id) => pickTicketAccount(chart.tileId, id, accounts)}
          />
        ) : (
          <Button variant="quiet" size="s" className="tk-connect" onClick={() => addConnection()}>
            Connect an account
          </Button>
        )}
      </header>
      {!trade.update ? (
        <Entry chart={chart} trade={trade} inst={inst} disabled />
      ) : trade.entry.open ? (
        <Entry chart={chart} trade={trade} inst={inst} />
      ) : (
        <ReadOnly trade={trade} inst={inst} why={trade.entry.why} canTurnOn={trade.entry.canTurnOn === true} />
      )}
    </section>
  );
}

function useAskedSetup(
  chart: TicketChart,
  trade: TicketTrade,
  inst: TicketInstrument,
  accounts: readonly TradingAccount[],
): void {
  const asked = usePanelRequest(chart.layoutId, chart.tileId);
  const accountId = trade.update?.account.id ?? null;
  const root = inst.instrument ? instrumentRoot(inst.instrument, inst.spec?.root ?? null) : null;
  const { oco, set } = useOco(accountId, root);
  const { layoutId, tileId } = chart;
  useEffect(() => {
    if (!asked) return;
    const step = nextPanelStep(asked, { accountId, root, oco, accounts: accounts.map((a) => a.id) });
    if (!step) return;
    if ('pick' in step) {
      pickTicketAccount(tileId, step.pick, accounts);
      return;
    }
    if (Object.keys(step.ticket).length > 0) patchTicket(tileId, step.ticket);
    if (step.oco) set(step.oco);
    settlePanelRequest(layoutId, tileId, step.rest);
  }, [asked, accountId, root, oco, set, accounts, layoutId, tileId]);
}

function Entry({
  chart,
  trade,
  inst,
  disabled = false,
}: {
  chart: TicketChart;
  trade: TicketTrade;
  inst: TicketInstrument;
  disabled?: boolean;
}) {
  const m = useTicketModel(chart, trade, inst, disabled);
  const { setup } = m;
  const drafts = useLiveDrafts();
  const waiting = (drafts ?? [])
    .filter((draft) => draft.account === m.accountId && (!draft.instrument || inst.ids.has(draft.instrument)))
    .map((draft) => draft.draftId)
    .sort()
    .join(',');
  const [draftFold, setDraftFold] = useState<{ waiting: string; open: boolean } | null>(null);
  const bracketOpen = waiting ? draftFold?.waiting === waiting && draftFold.open : setup.bracket === 'open';
  const why = m.runtimeWhy ?? (disabled ? null : inst.unavailable);
  return (
    <div className="tk-body" aria-disabled={disabled || undefined}>
      {m.update ? (
        <DayReadout update={m.update} position={m.position} stale={m.stale}>
          <CopiesRow accountId={m.update.account.id} />
        </DayReadout>
      ) : null}
      <section className="tk-sec tk-act" aria-label="Order">
        <SizeRow m={m} tileId={chart.tileId} disabled={disabled} />
        <OrderGrid m={m} tileId={chart.tileId} />
        <OrderNote why={why} m={m} />
      </section>
      <BracketSection
        oco={m.oco}
        onChange={m.setOco}
        plan={m.plan}
        market={m.market}
        entry={m.buyAt}
        riskSizing={m.risking}
        open={bracketOpen}
        onOpen={(open) => {
          if (waiting) setDraftFold({ waiting, open });
          else patchTicket(chart.tileId, { bracket: open ? 'open' : 'closed' });
        }}
        rulesOpen={setup.rules === 'open'}
        onRulesOpen={(open) => patchTicket(chart.tileId, { rules: open ? 'open' : 'closed' })}
        extraErrors={m.shownErrors}
        disabled={disabled}
      />
      <TicketOrders rows={m.rows} symbol={m.symbol} onCancel={m.cancelRows} merge={m.merge} />
    </div>
  );
}

export function OrderNote({
  why,
  m,
}: {
  why: string | null;
  m: Pick<TicketModel, 'lockedLine' | 'refusal' | 'riskLine'>;
}) {
  if (why)
    return (
      <p className="tk-why" role="note">
        {why}
      </p>
    );
  if (m.lockedLine) return <p className="tk-line is-locked">{m.lockedLine}</p>;
  if (m.refusal)
    return (
      <p className="tk-line is-refused" role="status">
        {m.refusal}
      </p>
    );
  return m.riskLine ? <p className="tk-line">{m.riskLine}</p> : null;
}

function whole(text: string): number | null {
  const n = parseStep(text);
  return n === null ? null : Math.floor(n);
}

function SizeRow({ m, tileId, disabled }: { m: TicketModel; tileId: string; disabled: boolean }) {
  const { setup } = m;
  return (
    <div className="tk-size">
      {m.risking ? (
        <Stepper
          className="tk-amount"
          size="s"
          label="Money at risk"
          prefix="$"
          value={setup.risk}
          min={0.01}
          format={(v) => formatPrice(v, Number.isInteger(v) ? 0 : 2)}
          fit
          onValueChange={(risk) => patchTicket(tileId, { risk })}
          onStep={m.stepRisk}
          disabled={disabled}
        />
      ) : (
        <>
          <Stepper
            className="tk-amount"
            size="s"
            label="Contracts"
            value={setup.qty}
            min={1}
            shiftSteps={5}
            inputMode="numeric"
            parse={whole}
            onValueChange={(qty) => patchTicket(tileId, { qty })}
            onStep={m.stepQty}
            disabled={disabled}
          />
          <Segmented
            className="tk-presets"
            label="Contract presets"
            options={QTY_PRESETS.map((q) => ({ value: q, label: q, disabled }))}
            value={QTY_PRESETS.find((q) => q === String(setup.qty)) ?? null}
            onChange={(q) => patchTicket(tileId, { qty: Number(q) })}
          />
        </>
      )}
      <Tooltip content="Size by the money risked at the stop you click">
        <span className="tk-risk">
          <Switch
            checked={m.risking}
            disabled={disabled}
            onCheckedChange={(on) => patchTicket(tileId, { sizing: on ? 'risk' : 'qty' })}
          >
            Risk
          </Switch>
        </span>
      </Tooltip>
    </div>
  );
}

export function DayReadout({
  update,
  position,
  stale,
  children,
}: {
  update: AccountUpdate;
  position: PositionReadout;
  stale: ReadoutStale;
  children?: ReactNode;
}) {
  const day = update.summary.dayPnl;
  const pnl = position.qty === 0 ? 0 : position.pnl;
  return (
    <Readout className="tk-readout" label={`${update.account.displayName} read-out`}>
      <ReadoutRow
        label="Position"
        value={position.words}
        quiet={position.qty === 0}
        note={(stale.position ?? stale.prices)?.words}
        data-trust={stale.position?.trust}
      />
      <ReadoutRow
        label="Open P/L"
        value={formatMoney(pnl, { signed: true })}
        tone={stale.prices ? null : toneOf(pnl)}
        data-trust={stale.prices?.trust}
      />
      <ReadoutRow
        label="Today"
        value={formatMoney(day, { signed: true })}
        tone={stale.prices ? null : toneOf(day.amount)}
        data-trust={stale.prices?.trust}
      />
      {children}
    </Readout>
  );
}

function CopiesRow({ accountId }: { accountId: string }) {
  const group = groupOn(useCopyGroups(), accountId);
  const { accounts } = useShellData();
  if (!group) return null;
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;
  return (
    <ReadoutRow
      label="Copies to"
      value={
        <Tooltip content={<span className="tk-copies-tip">{copiesTip(group, nameOf)}</span>}>
          <span tabIndex={0}>{group.followers.length}</span>
        </Tooltip>
      }
    />
  );
}

function ReadOnly({
  trade,
  inst,
  why,
  canTurnOn,
}: {
  trade: TicketTrade;
  inst: TicketInstrument;
  why: string;
  canTurnOn: boolean;
}) {
  const { update, positions, orders } = trade;
  const connections = useConnectionList(canTurnOn);
  const sw = canTurnOn ? orderEntrySwitchOf(update?.account ?? null, connections) : null;
  const { since, run } = useConnectionCall();
  const [failed, setFailed] = useState<string | null>(null);
  const on = useDraft(
    switchEdits,
    sw && update ? `entry/${sw.connectionId}/${update.account.id}` : null,
    sw?.on ?? false,
  );
  const quote = useQuote(inst.instrument);
  const feeds = useFeeds();
  const stale = { position: streamStale(feeds), prices: pricesStale(feeds, quote?.source?.provider ?? null) };
  const math = mathOf(inst.spec ?? null, inst.instrument);
  const dp = math?.decimals ?? 2;
  const cm = useMemo(() => chartMathOf(math, dp), [math, dp]);
  const brackets = useMemo(() => groupBrackets(orders, positions, [], inst.ids), [orders, positions, inst.ids]);
  const rows = useMemo(() => tradeRows(brackets, cm, { position: false }), [brackets, cm]);
  const position = useMemo(() => positionReadout(brackets, cm), [brackets, cm]);
  if (!update) return null;
  return (
    <div className="tk-body tk-readonly">
      <DayReadout update={update} position={position} stale={stale}>
        <ReadoutRow
          label="Bid · Ask"
          value={`${px(quote?.bid, dp)} · ${px(quote?.ask, dp)}`}
          data-trust={stale.prices?.trust}
        />
      </DayReadout>
      <SettingsRow compact className="tk-entry-row" label="Order entry" help={why} error={failed}>
        {sw ? (
          <Switch
            label="Turn on trading"
            checked={on.value}
            disabled={since !== null}
            onCheckedChange={(next) => {
              setFailed(null);
              on.save(next, (enabled) =>
                run('connections.set_order_entry', {
                  connectionId: sw.connectionId,
                  accountId: update.account.id,
                  enabled,
                })
                  .then((r) => {
                    setFailed(r.ok ? null : r.why);
                    return r;
                  })
                  .then(orThrow),
              );
            }}
          />
        ) : null}
      </SettingsRow>
      <TicketOrders rows={rows} symbol={inst.symbol} />
    </div>
  );
}
