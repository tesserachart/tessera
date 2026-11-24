import { normalizeEpochMs, type CopyFollower } from '@tessera/protocol';
import {
  Button,
  Choice,
  IconButton,
  StatusDot,
  Stepper,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tooltip,
  Tr,
  cx,
  formatClock,
  parseStep,
} from '@tessera/ui';
import { FIXED_MAX, MULTIPLIER_MAX } from '../../accounts/copy.ts';
import type { FollowerRow } from '../../accounts/copyView.ts';
import { displayZone } from '../../state/timeZone.ts';

export interface RowActions {
  onSizing: (account: string, sizing: { times: number } | { fixed: number }) => void;
  onMicro: (account: string, micro: boolean) => void;
  onCopying: (account: string, copying: boolean) => void;
  onResync: (account: string) => void;
  onFlatten: (account: string) => void;
  onRemove: (account: string) => void;
}

export function FollowersTable({
  label,
  rows,
  busy,
  groupOn,
  actions,
}: {
  label: string;
  rows: readonly FollowerRow[];
  busy: boolean;
  groupOn: boolean;
  actions: RowActions;
}) {
  return (
    <Table className="cp-tbl" aria-label={label}>
      <THead>
        <tr>
          <Th className="c-acct">Account</Th>
          <Th className="c-size">Size</Th>
          <Th className="c-contract">Contract</Th>
          <Th className="c-holds">Holds</Th>
          <Th className="c-should">Should hold</Th>
          <Th className="c-sync">Sync</Th>
          <Th className="c-copying">Copying</Th>
          <Th className="c-act" />
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <FollowerLine key={r.accountId} row={r} busy={busy} groupOn={groupOn} actions={actions} />
        ))}
      </TBody>
    </Table>
  );
}

function FollowerLine({
  row: r,
  busy,
  groupOn,
  actions,
}: {
  row: FollowerRow;
  busy: boolean;
  groupOn: boolean;
  actions: RowActions;
}) {
  return (
    <Tr className="cp-row" data-wrong={r.sync.rule || undefined}>
      <Td className="c-acct">
        <span className="nm">{r.name}</span>
        {r.last ? (
          <Tooltip content={formatClock(normalizeEpochMs(r.last.at), displayZone())}>
            <span className="cp-last">
              <StatusDot state={r.last.dot} className="w-1.5 h-1.5" />
              {r.last.text}
            </span>
          </Tooltip>
        ) : null}
      </Td>
      <Td className="c-size">
        <SizeStepper name={r.name} follower={r.follower} onSizing={(s) => actions.onSizing(r.accountId, s)} />
      </Td>
      <Td className="c-contract">
        <Choice
          label={`${r.name} contract`}
          value={r.micro ? 'micro' : 'same'}
          options={[
            { value: 'same', label: 'Same' },
            { value: 'micro', label: 'Micro' },
          ]}
          onChange={(v) => actions.onMicro(r.accountId, v === 'micro')}
        />
      </Td>
      <Td className="c-holds">{r.holds}</Td>
      <Td className="c-should">{r.shouldHold}</Td>
      <Td className="c-sync">
        <span className={cx('cp-sync', r.sync.strong && 'is-strong')}>
          {r.sync.dot ? <StatusDot state={r.sync.dot} className="w-1.5 h-1.5" /> : null}
          <span className="w">{r.sync.text}</span>
        </span>
      </Td>
      <Td className={cx('c-copying', !groupOn && 'is-group-off')}>
        <Switch
          checked={!r.paused}
          onCheckedChange={(on) => actions.onCopying(r.accountId, on)}
          label={`Copy to ${r.name}`}
        />
      </Td>
      <Td className="c-act">
        <span className="cp-acts">
          {r.resync ? (
            <Button size="s" variant="quiet" disabled={busy} onClick={() => actions.onResync(r.accountId)}>
              Resync
            </Button>
          ) : null}
          {r.flatten ? (
            <Button size="s" variant="quiet" disabled={busy} onClick={() => actions.onFlatten(r.accountId)}>
              Flatten
            </Button>
          ) : null}
          <Tooltip content={`Remove ${r.name}`}>
            <IconButton label={`Remove ${r.name}`} icon="remove" onClick={() => actions.onRemove(r.accountId)} />
          </Tooltip>
        </span>
      </Td>
    </Tr>
  );
}

type Unit = 'x' | 'fixed';

function SizeStepper({
  name,
  follower,
  onSizing,
}: {
  name: string;
  follower: CopyFollower;
  onSizing: (s: { times: number } | { fixed: number }) => void;
}) {
  const fixed = follower.fixedQty !== undefined;
  const unit: Unit = fixed ? 'fixed' : 'x';
  return (
    <Stepper
      size="s"
      className="cp-size"
      label={`${name} size`}
      value={fixed ? Number(follower.fixedQty) : follower.multiplier}
      step={fixed ? 1 : 0.25}
      min={fixed ? 1 : 0.25}
      max={fixed ? FIXED_MAX : MULTIPLIER_MAX}
      inputMode={fixed ? 'numeric' : 'decimal'}
      buttons={false}
      parse={(t) => {
        const n = parseStep(t);
        return n === null ? null : fixed ? Math.floor(n) : n;
      }}
      onValueChange={(v) => {
        if (fixed ? v === follower.fixedQty : v === follower.multiplier) return;
        onSizing(fixed ? { fixed: v } : { times: v });
      }}
      unit={{
        value: unit,
        label: 'Size',
        options: [
          { value: 'x', short: '×', label: 'Times the leader’s position' },
          { value: 'fixed', short: 'ct', label: 'Fixed contracts' },
        ],
        onChange: (u: string) => {
          if (u !== unit) onSizing(u === 'fixed' ? { fixed: 1 } : { times: 1 });
        },
      }}
    />
  );
}
