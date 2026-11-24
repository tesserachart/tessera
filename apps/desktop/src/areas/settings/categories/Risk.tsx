import type { AccountUpdate, JsonValue, LimitsSetting, RiskLimits } from '@tessera/protocol';
import { SettingsRow, Switch, TextInput } from '@tessera/ui';
import { useState, type KeyboardEvent } from 'react';
import {
  LIMIT_KEYS,
  limitKind,
  limitsValue,
  parseLimit,
  readLimits,
  setIsOff,
  standingWords,
  withLimit,
  withOwn,
  type LimitKey,
} from '../../../accounts/limits.ts';
import { useAccountUpdates } from '../../../app/portfolio.ts';
import { useRuntimeSetting, useSetSetting } from '../../../state/runtimeSettings.ts';
import { rowWords } from '../model.ts';
import { Row, Section } from '../parts.tsx';

const ROW: Record<LimitKey, string> = {
  dailyLossLimit: 'trading.dailyLoss',
  maxRiskPerTrade: 'trading.perTrade',
  maxOrderQty: 'trading.orderQty',
  maxPositionQty: 'trading.positionQty',
  maxTradesPerDay: 'trading.trades',
};

const UNIT: Record<LimitKey, string> = {
  dailyLossLimit: 'USD',
  maxRiskPerTrade: 'USD',
  maxOrderQty: 'contracts',
  maxPositionQty: 'contracts',
  maxTradesPerDay: 'trades',
};

function LimitField({
  k,
  value,
  label,
  onCommit,
}: {
  k: LimitKey;
  value: number | undefined;
  label: string;
  onCommit: (v: number | null) => Promise<string | null>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const commit = async () => {
    if (text === null) return;
    const v = parseLimit(text, k);
    if (v === 'invalid') {
      setErr(limitKind(k) === 'money' ? 'An amount over 0, or empty for off' : 'A whole number, or empty for off');
      return;
    }
    if ((v ?? undefined) === value) {
      setText(null);
      setErr(null);
      return;
    }
    const why = await onCommit(v);
    setErr(why);
    if (!why) setText(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setText(null);
      setErr(null);
    }
  };
  return (
    <span className="st-num">
      <TextInput
        inputMode={limitKind(k) === 'money' ? 'decimal' : 'numeric'}
        aria-label={label}
        unit={UNIT[k]}
        placeholder="Off"
        className={err ? 'is-invalid' : undefined}
        value={text ?? (value === undefined ? '' : String(value))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
      {err ? (
        <span className="st-err" role="alert">
          {err}
        </span>
      ) : null}
    </span>
  );
}

function accountWords(u: AccountUpdate, own: boolean, set: RiskLimits): string {
  const standing = standingWords(u.limits);
  if (standing) return own ? `Its own limits · ${standing}` : standing;
  if (own) return setIsOff(set) ? 'Its own limits: none on' : 'Its own limits';
  return setIsOff(set) ? 'No limits' : 'Every account’s limits';
}

function AccountLimits({
  u,
  setting,
  save,
}: {
  u: AccountUpdate;
  setting: LimitsSetting;
  save: (next: LimitsSetting) => Promise<string | null>;
}) {
  const id = u.account.id;
  const name = u.account.displayName;
  const own = setting.accounts[id] !== undefined;
  const set = setting.accounts[id] ?? setting.every;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <SettingsRow
        data-setting={`trading.accountLimit.${id}`}
        label={name}
        help={accountWords(u, own, set)}
        error={failed}
      >
        <Switch
          label={`Limits of its own for ${name}`}
          checked={own}
          onCheckedChange={(on) => void save(withOwn(setting, id, on)).then(setFailed)}
        >
          Own limits
        </Switch>
      </SettingsRow>
      {own
        ? LIMIT_KEYS.map((k) => (
            <SettingsRow
              key={k}
              className="st-own"
              data-setting={`trading.accountLimit.${id}.${k}`}
              label={rowWords(ROW[k]).title}
            >
              <LimitField
                k={k}
                value={set[k]}
                label={`${rowWords(ROW[k]).title} for ${name}`}
                onCommit={(v) => save(withLimit(setting, id, k, v))}
              />
            </SettingsRow>
          ))
        : null}
    </>
  );
}

export function RiskSections() {
  const stored = useRuntimeSetting('risk.limits');
  const set = useSetSetting();
  const accountUpdates = useAccountUpdates() ?? [];
  const setting = readLimits(stored);
  const save = (next: LimitsSetting) => set('risk.limits', limitsValue(next) as JsonValue);
  const [firmFailed, setFirmFailed] = useState<string | null>(null);
  const [unlockFailed, setUnlockFailed] = useState<string | null>(null);
  return (
    <>
      <Section id="trading.limits">
        {LIMIT_KEYS.map((k) => (
          <Row key={k} id={ROW[k]}>
            <LimitField
              k={k}
              value={setting.every[k]}
              label={rowWords(ROW[k]).title}
              onCommit={(v) => save(withLimit(setting, null, k, v))}
            />
          </Row>
        ))}
      </Section>
      {accountUpdates.length > 0 ? (
        <Section id="trading.accountLimits">
          {accountUpdates.map((u) => (
            <AccountLimits key={u.account.id} u={u} setting={setting} save={save} />
          ))}
        </Section>
      ) : null}
      <Section id="trading.firm">
        <Row id="trading.useFirm" error={firmFailed}>
          <Switch
            label="Use my firm’s limits"
            checked={setting.useFirmLimits}
            onCheckedChange={(on) => void save({ ...setting, useFirmLimits: on }).then(setFirmFailed)}
          />
        </Row>
      </Section>
      <Section id="trading.lock">
        <Row id="trading.earlyUnlock" error={unlockFailed}>
          <Switch
            label="Allow unlocking early"
            checked={setting.allowEarlyUnlock}
            onCheckedChange={(on) => void save({ ...setting, allowEarlyUnlock: on }).then(setUnlockFailed)}
          />
        </Row>
      </Section>
    </>
  );
}
