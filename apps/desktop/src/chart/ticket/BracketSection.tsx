import {
  Check,
  Icon,
  SettingsRow,
  Stepper,
  Switch,
  Tooltip,
  cx,
  parseStep,
  type StepperUnitOption,
  PRICE_TEXT,
} from '@tessera/ui';
import { useId } from 'react';
import {
  OCO_UNITS,
  convertLeg,
  legPrice,
  legReadout,
  stepLeg,
  type OcoConfig,
  type OcoLeg,
  type OcoMarket,
  type OcoPlan,
  type OcoUnit,
} from '../../shell/oco.ts';
import {
  UNIT_NAME,
  UNIT_SHORT,
  bracketErrors,
  bracketShort,
  breakevenWords,
  legFieldText,
  legHelp,
  rulesShort,
  sizedByStop,
  trailWords,
} from './bracket.ts';

function wholeTicks(text: string): number | null {
  const n = parseStep(text);
  return n === null ? null : Math.floor(n);
}

export function BracketSection({
  oco,
  onChange,
  plan,
  market,
  entry,
  riskSizing,
  open,
  onOpen,
  rulesOpen,
  onRulesOpen,
  extraErrors = [],
  disabled = false,
}: {
  oco: OcoConfig;
  onChange: (oco: OcoConfig) => void;
  plan: OcoPlan | null;
  market: OcoMarket | null;
  entry: number | null;
  riskSizing: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  rulesOpen: boolean;
  onRulesOpen: (open: boolean) => void;
  extraErrors?: readonly string[];
  disabled?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<OcoConfig>) => onChange({ ...oco, ...patch });
  const shown = open && oco.on;
  const errors = oco.on ? bracketErrors(plan, extraErrors) : [];
  const folded = oco.on && !open ? bracketShort(oco, plan, { riskSizing }) : '';

  const unitOptions: StepperUnitOption<OcoUnit>[] = OCO_UNITS.map((u) => ({
    value: u,
    short: UNIT_SHORT[u],
    label: UNIT_NAME[u],
    disabled: u === 'pct' && market?.balance === null,
  }));

  const legRow = (role: 'stop' | 'target') => {
    const leg = oco[role];
    const word = role === 'stop' ? 'Stop' : 'Target';
    const ticks = (role === 'stop' ? plan?.stopTicks : plan?.targetTicks) ?? null;
    const price = market && entry !== null && ticks !== null ? legPrice('buy', role, entry, ticks, market.tick) : null;
    const err = plan?.errors[role];
    const setLeg = (l: OcoLeg) => set({ [role]: l });
    return (
      <SettingsRow
        compact
        className={cx('tk-leg', !leg.on && 'is-off')}
        data-role={role}
        label={
          <Check checked={leg.on} disabled={disabled} onChange={(on) => setLeg({ ...leg, on })}>
            {word}
          </Check>
        }
        help={
          !leg.on ? undefined : riskSizing && role === 'target' ? (
            sizedByStop(leg.unit) ? (
              <Tooltip content="For all the contracts your stop sizes: its price follows once the stop is clicked">
                <span>For the whole size</span>
              </Tooltip>
            ) : undefined
          ) : (
            <Tooltip content={market && ticks !== null ? legReadout(ticks, market, price) : word}>
              <span className={PRICE_TEXT}>{legHelp(ticks, leg.unit, market, price)}</span>
            </Tooltip>
          )
        }
      >
        <Stepper
          className="tk-dist"
          size="s"
          buttons={false}
          label={`${word} distance`}
          value={leg.value}
          min={Number.MIN_VALUE}
          format={(v) => legFieldText({ value: v, unit: leg.unit })}
          onValueChange={(v) => setLeg({ ...leg, value: leg.unit === 'ticks' ? Math.round(v) : v })}
          onStep={(n) => setLeg(stepLeg(leg, n))}
          unit={{
            value: leg.unit,
            label: `${word} unit`,
            options: unitOptions,
            onChange: (v) => {
              const u = OCO_UNITS.find((x) => x === v);
              if (u) setLeg(market ? convertLeg(leg, u, market) : { ...leg, unit: u });
            },
          }}
          invalid={!!err}
          disabled={disabled || !leg.on}
        />
      </SettingsRow>
    );
  };

  const inForce = rulesShort(oco);
  return (
    <section className={cx('tk-sec', 'tk-bracket')} aria-labelledby={`${id}-t`}>
      <div className="tk-sec-head">
        <button
          type="button"
          className="tk-fold"
          aria-expanded={shown}
          disabled={disabled || !oco.on}
          data-press="none"
          onClick={() => onOpen(!open)}
        >
          <span id={`${id}-t`} className="t">
            Bracket
          </span>
          {folded ? <span className={cx('sum', PRICE_TEXT)}>{folded}</span> : null}
          {oco.on ? <Icon name={shown ? 'chevron-up' : 'chevron-down'} className="chev" /> : null}
        </button>
        <Switch label="Bracket" checked={oco.on} disabled={disabled} onCheckedChange={(on) => set({ on })} />
      </div>
      {shown ? (
        <div className="tk-sec-body">
          {riskSizing ? (
            <SettingsRow compact className="tk-leg" data-role="stop" label="Stop">
              <span className="tk-fact">Clicked on the chart</span>
            </SettingsRow>
          ) : (
            legRow('stop')
          )}
          {legRow('target')}
          <button
            type="button"
            className="tk-fold tk-more"
            aria-expanded={rulesOpen}
            disabled={disabled}
            data-press="none"
            onClick={() => onRulesOpen(!rulesOpen)}
          >
            <span className="t">More</span>
            {!rulesOpen && inForce ? <span className={cx('sum', PRICE_TEXT)}>{inForce}</span> : null}
            <Icon name={rulesOpen ? 'chevron-up' : 'chevron-down'} className="chev" />
          </button>
          {rulesOpen ? (
            <>
              <SettingsRow
                compact
                className="tk-rule"
                label={
                  <Tooltip content={breakevenWords(oco)}>
                    <span className="tk-tipped">
                      <Check
                        checked={oco.breakeven.on}
                        disabled={disabled || !oco.stop.on}
                        onChange={(on) => set({ breakeven: { ...oco.breakeven, on } })}
                      >
                        Breakeven
                      </Check>
                    </span>
                  </Tooltip>
                }
              >
                <Stepper
                  className="tk-rule-dist"
                  size="s"
                  buttons={false}
                  label="Breakeven trigger in ticks"
                  value={oco.breakeven.trigger}
                  min={1}
                  shiftSteps={1}
                  parse={wholeTicks}
                  suffix="t"
                  disabled={disabled || !oco.breakeven.on}
                  onValueChange={(trigger) => set({ breakeven: { ...oco.breakeven, trigger } })}
                />
                <Stepper
                  className="tk-rule-dist"
                  size="s"
                  buttons={false}
                  label="Breakeven offset in ticks"
                  value={oco.breakeven.offset}
                  min={0}
                  shiftSteps={1}
                  parse={wholeTicks}
                  prefix="+"
                  suffix="t"
                  disabled={disabled || !oco.breakeven.on}
                  onValueChange={(offset) => set({ breakeven: { ...oco.breakeven, offset } })}
                />
              </SettingsRow>
              <SettingsRow
                compact
                className="tk-rule"
                label={
                  <Tooltip content={trailWords(oco)}>
                    <span className="tk-tipped">
                      <Check
                        checked={oco.trail.on}
                        disabled={disabled || !oco.stop.on}
                        onChange={(on) => set({ trail: { ...oco.trail, on } })}
                      >
                        Trailing
                      </Check>
                    </span>
                  </Tooltip>
                }
              >
                <Stepper
                  className="tk-rule-dist"
                  size="s"
                  buttons={false}
                  label="Trailing distance in ticks"
                  value={oco.trail.ticks}
                  min={1}
                  shiftSteps={1}
                  parse={wholeTicks}
                  suffix="t"
                  disabled={disabled || !oco.trail.on}
                  onValueChange={(ticks) => set({ trail: { ...oco.trail, ticks } })}
                />
                <Stepper
                  className="tk-rule-dist"
                  size="s"
                  buttons={false}
                  label="Ticks of profit before trailing starts"
                  value={oco.trail.trigger}
                  min={0}
                  shiftSteps={1}
                  parse={wholeTicks}
                  prefix="+"
                  suffix="t"
                  disabled={disabled || !oco.trail.on}
                  onValueChange={(trigger) => set({ trail: { ...oco.trail, trigger } })}
                />
              </SettingsRow>
              <SettingsRow compact className="tk-rule tk-rule-sub" label="Trail step">
                <Stepper
                  className="tk-rule-dist"
                  size="s"
                  buttons={false}
                  label="Trailing step in ticks"
                  value={oco.trail.step}
                  min={1}
                  shiftSteps={1}
                  parse={wholeTicks}
                  suffix="t"
                  disabled={disabled || !oco.trail.on}
                  onValueChange={(step) => set({ trail: { ...oco.trail, step } })}
                />
              </SettingsRow>
            </>
          ) : null}
        </div>
      ) : null}
      {errors.length > 0 ? (
        <p className="tk-err" role="alert">
          {errors.join(' · ')}
        </p>
      ) : null}
    </section>
  );
}
