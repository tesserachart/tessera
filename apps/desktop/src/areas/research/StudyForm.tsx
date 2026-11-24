import type { Execution, Gates, Rule, SaveStudyInput, Sides, StudyData, Timeframe } from '@tessera/protocol';
import { Check, Segmented, Select, TextInput } from '@tessera/ui';
import { useId, useState, type ReactNode } from 'react';
import { useHasTool, useToolValue } from '../../app/tools.ts';
import { CodeEditor } from '../indicators/CodeEditor.tsx';
import {
  DEFAULT_EXECUTION,
  DEFAULT_GATES,
  RULES,
  STRATEGY_TEMPLATE,
  TIMEFRAMES,
  dateValue,
  defaultRule,
  fromDateValue,
  levelExample,
  parseLevels,
  windowZone,
  type RuleKind,
} from './model.ts';
import { useDisplayZone, zoneCity } from '../../state/timeZone.ts';

interface StudyFormProps {
  value: SaveStudyInput;
  onChange: (v: SaveStudyInput) => void;
}

export function StudyForm(props: StudyFormProps) {
  const hasHistory = useHasTool('intel.list_level_history');
  const stored = useToolValue('intel.list_level_history', hasHistory ? {} : null, { keepFor: 60_000 })?.series ?? [];
  const zone = useDisplayZone();
  return <StudyFormView {...props} stored={stored} zone={zone} />;
}

export function StudyFormView({
  value,
  onChange,
  stored,
  zone,
}: StudyFormProps & { stored: readonly { vendor: string; level: string }[]; zone: string }) {
  const set = (patch: Partial<SaveStudyInput>) => onChange({ ...value, ...patch });
  const data = (patch: Partial<StudyData>) => set({ data: { ...value.data, ...patch } });
  const exec = value.execution ?? DEFAULT_EXECUTION;
  const setExec = (patch: Partial<Execution>) => set({ execution: { ...exec, ...patch } });
  const gates = value.gates ?? DEFAULT_GATES;
  const setGates = (patch: Partial<Gates>) => set({ gates: { ...gates, ...patch } });
  const s = value.strategy;
  const [levelsText, setLevelsText] = useState(value.data.levels.join(', '));
  const window = value.data.window;
  const windowZoneShown = window && windowZone(window) !== zone ? zoneCity(windowZone(window)) : undefined;
  const setWindow = (start: string, end: string) =>
    data({
      window: start || end ? { start, end, timeZone: window ? windowZone(window) : zone } : null,
    });
  return (
    <div className="rs-form">
      <Group title="Hypothesis">
        <Row label="Name">
          <TextInput value={value.name} onChange={(e) => set({ name: e.target.value })} aria-label="Name" />
        </Row>
        <textarea
          className="rs-text"
          aria-label="Hypothesis"
          rows={3}
          value={value.hypothesis}
          placeholder="What you expect, and why, before any outcome"
          onChange={(e) => set({ hypothesis: e.target.value })}
        />
        <textarea
          className="rs-text is-quiet"
          aria-label="Notes"
          rows={2}
          value={value.notes ?? ''}
          placeholder="What is known already; what would limit the result"
          onChange={(e) => set({ notes: e.target.value || null })}
        />
      </Group>

      <Group title="History">
        <Row label="Instrument">
          <TextInput
            value={value.data.instrument}
            onChange={(e) => data({ instrument: e.target.value })}
            aria-label="Instrument"
          />
        </Row>
        <Row label="Bars">
          <Segmented<Timeframe>
            label="Timeframe"
            options={TIMEFRAMES.map((t) => ({ value: t, label: t }))}
            value={value.data.tf}
            onChange={(tf) => data({ tf })}
          />
        </Row>
        <Row label="From · to">
          <span className="rs-pair">
            <TextInput
              type="date"
              aria-label="From"
              value={dateValue(value.data.from)}
              onChange={(e) => data({ from: fromDateValue(e.target.value) })}
            />
            <TextInput
              type="date"
              aria-label="To"
              value={dateValue(value.data.to)}
              onChange={(e) => data({ to: fromDateValue(e.target.value, true) })}
            />
          </span>
        </Row>
        <Row label="Development share">
          <TextInput
            type="number"
            min={10}
            max={90}
            step={5}
            unit="% of sessions"
            aria-label="Development share"
            value={Math.round(value.data.developmentShare * 100)}
            onChange={(e) => data({ developmentShare: clamp(Number(e.target.value), 10, 90) / 100 })}
          />
        </Row>
        <Row label="">
          <Check checked={value.data.rthOnly} onChange={(rthOnly) => data({ rthOnly })}>
            Regular hours only
          </Check>
        </Row>
        <Row label={windowZoneShown ? `Window · ${windowZoneShown}` : 'Window'}>
          <span className="rs-pair">
            <TextInput
              type="time"
              aria-label="Window start"
              value={window?.start ?? ''}
              onChange={(e) => setWindow(e.target.value, window?.end ?? '')}
            />
            <TextInput
              type="time"
              aria-label="Window end"
              value={window?.end ?? ''}
              onChange={(e) => setWindow(window?.start ?? '', e.target.value)}
            />
          </span>
        </Row>
        <Row label="Levels">
          <TextInput
            aria-label="Level inputs"
            placeholder={levelExample(stored)}
            value={levelsText}
            onChange={(e) => {
              setLevelsText(e.target.value);
              data({ levels: parseLevels(e.target.value) });
            }}
          />
        </Row>
      </Group>

      <Group title="Rules">
        <Row label="Kind">
          <Segmented<'rules' | 'script'>
            label="Strategy kind"
            options={[
              { value: 'rules', label: 'Built-in' },
              { value: 'script', label: 'JavaScript' },
            ]}
            value={s.kind}
            onChange={(k) =>
              set({
                strategy:
                  k === 'script'
                    ? { kind: 'script', code: STRATEGY_TEMPLATE, inputs: {}, freeParameters: 0 }
                    : { kind: 'rules', rule: defaultRule('ema_cross') },
              })
            }
          />
        </Row>
        {s.kind === 'rules' ? (
          <RuleFields rule={s.rule} onChange={(rule) => set({ strategy: { kind: 'rules', rule } })} />
        ) : (
          <>
            <div className="rs-code">
              <CodeEditor
                label="Strategy code"
                value={s.code}
                onChange={(code) => set({ strategy: { ...s, code } })}
                onRun={() => undefined}
                onSave={() => undefined}
                problem={null}
              />
            </div>
            <Row label="Free parameters">
              <TextInput
                type="number"
                min={0}
                aria-label="Free parameters"
                value={s.freeParameters}
                onChange={(e) =>
                  set({ strategy: { ...s, freeParameters: Math.max(0, Math.floor(Number(e.target.value))) } })
                }
              />
            </Row>
          </>
        )}
      </Group>

      <Group title="Execution">
        <Row label="Contracts">
          <TextInput
            type="number"
            min={1}
            aria-label="Contracts"
            value={exec.qty}
            onChange={(e) => setExec({ qty: Math.max(1, Math.floor(Number(e.target.value))) })}
          />
        </Row>
        <Row label="Commission">
          <TextInput
            type="number"
            min={0}
            step={0.05}
            unit="$ a contract a side"
            aria-label="Commission"
            value={exec.commissionPerContract}
            onChange={(e) => setExec({ commissionPerContract: Math.max(0, Number(e.target.value)) })}
          />
        </Row>
        <Row label="Stop · target">
          <span className="rs-pair">
            <TextInput
              type="number"
              min={0}
              unit="t"
              aria-label="Stop ticks"
              value={exec.stopTicks ?? ''}
              onChange={(e) => setExec({ stopTicks: positive(e.target.value) })}
            />
            <TextInput
              type="number"
              min={0}
              unit="t"
              aria-label="Target ticks"
              value={exec.targetTicks ?? ''}
              onChange={(e) => setExec({ targetTicks: positive(e.target.value) })}
            />
          </span>
        </Row>
        {exec.fillCases.map((c, i) => (
          <Row key={c.name} label={i === 0 ? 'Fill cases' : ''}>
            <TextInput
              type="number"
              min={0}
              step={0.5}
              unit={`ticks · ${c.name}`}
              aria-label={`${c.name} slippage`}
              value={c.slippageTicks}
              onChange={(e) =>
                setExec({
                  fillCases: exec.fillCases.map((x, j) =>
                    j === i ? { ...x, slippageTicks: Math.max(0, Number(e.target.value)) } : x,
                  ),
                })
              }
            />
          </Row>
        ))}
      </Group>

      <Group title="Gates">
        <Row label="Later trades ≥">
          <TextInput
            type="number"
            min={1}
            aria-label="Minimum later trades"
            value={gates.minTrades}
            onChange={(e) => setGates({ minTrades: Math.max(1, Math.floor(Number(e.target.value))) })}
          />
        </Row>
        <Row label="Later win rate ≥">
          <TextInput
            type="number"
            min={0}
            max={100}
            unit="%"
            aria-label="Minimum later win rate"
            value={gates.minWinRate === null ? '' : Math.round(gates.minWinRate * 100)}
            onChange={(e) =>
              setGates({ minWinRate: e.target.value === '' ? null : clamp(Number(e.target.value), 0, 100) / 100 })
            }
          />
        </Row>
        <div className="rs-checks">
          <Check checked={gates.ciAboveZero} onChange={(ciAboveZero) => setGates({ ciAboveZero })}>
            Later mean trade&apos;s interval above zero
          </Check>
          <Check checked={gates.eachHalfPositive} onChange={(eachHalfPositive) => setGates({ eachHalfPositive })}>
            Each half of the later sessions positive
          </Check>
          <Check
            checked={gates.developmentPositive}
            onChange={(developmentPositive) => setGates({ developmentPositive })}
          >
            Development sessions positive
          </Check>
        </div>
        <Row label="Placebo runs">
          <TextInput
            type="number"
            min={0}
            max={500}
            aria-label="Placebo runs"
            value={value.placeboRuns ?? 100}
            onChange={(e) => set({ placeboRuns: clamp(Math.floor(Number(e.target.value)), 0, 500) })}
          />
        </Row>
      </Group>
    </div>
  );
}

function RuleFields({ rule, onChange }: { rule: Rule; onChange: (r: Rule) => void }) {
  const def = RULES.find((r) => r.rule === rule.rule)!;
  const values = rule as unknown as Record<string, number>;
  return (
    <>
      <Row label="Rule">
        <Select<RuleKind>
          label="Rule"
          options={RULES.map((r) => ({ value: r.rule, label: r.label }))}
          value={rule.rule}
          onValueChange={(k) => onChange(defaultRule(k))}
        />
      </Row>
      <p className="rs-what">{def.what}</p>
      {def.params.map((p) => (
        <Row key={p.key} label={p.label}>
          <TextInput
            type="number"
            min={p.min}
            max={p.max}
            aria-label={p.label}
            value={values[p.key] ?? ''}
            onChange={(e) => onChange({ ...rule, [p.key]: clamp(Number(e.target.value), p.min, p.max) })}
          />
        </Row>
      ))}
      <Row label="Sides">
        <Segmented<Sides>
          label="Sides"
          options={[
            { value: 'both', label: 'Both' },
            { value: 'long', label: 'Long' },
            { value: 'short', label: 'Short' },
          ]}
          value={rule.sides}
          onChange={(sides) => onChange({ ...rule, sides })}
        />
      </Row>
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="rs-group" aria-labelledby={id}>
      <h2 id={id} className="rs-group-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rs-row-field">
      <span className="rs-label">{label}</span>
      <span className="rs-control">{children}</span>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function positive(v: string): number | null {
  const n = Number(v);
  return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
}
