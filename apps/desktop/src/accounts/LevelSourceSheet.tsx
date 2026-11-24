import type { JsonValue, Level, LevelSourceSpec, SourceDraft, TestSourceOutput, TimeUnit } from '@tessera/protocol';
import {
  Button,
  FormActions,
  FormRow,
  FormSection,
  Icon,
  Segmented,
  Select,
  SheetContent,
  Switch,
  TextInput,
  Tooltip,
  PRICE_TEXT,
  cx,
} from '@tessera/ui';
import { useId, useState } from 'react';
import { useToolValue } from '../app/tools.ts';
import { endSentence } from '../areas/settings/sentence.ts';
import { Elapsed } from './ConnectionForm.tsx';
import { useConnectionCall } from './connectionCall.ts';
import { useSavedWords } from './savedWords.ts';
import {
  EMPTY_FORM,
  REQUEST_ID,
  formFromSpec,
  formProblem,
  parseSpec,
  samplesOf,
  specFromForm,
  type AuthMode,
  type FieldRow,
  type LevelSourceForm,
  type TickerRow,
} from './levelSource.ts';

const AUTH: { value: AuthMode; label: string }[] = [
  { value: 'header', label: 'A header' },
  { value: 'query', label: 'A query parameter' },
  { value: 'none', label: 'No key' },
];

const UNITS: { value: TimeUnit; label: string }[] = [
  { value: 'seconds', label: 'Unix seconds' },
  { value: 'millis', label: 'Unix ms' },
  { value: 'rfc3339', label: 'Date and time' },
];

function TriedLevel({ l }: { l: Level }) {
  return (
    <li className="lv-level">
      <span className="lab">{l.label}</span>
      <span className="field text-t3">{l.source.field}</span>
      <span className={l.price === null ? 'val text-t3' : cx('val', PRICE_TEXT)}>
        {l.price === null ? (l.unavailableReason ?? 'no value') : String(l.price)}
      </span>
    </li>
  );
}

function Tried({ out }: { out: TestSourceOutput }) {
  return (
    <div className="lv-tried" role="status" aria-label="What the test read">
      {out.requests.map((r) => (
        <div key={r.id}>
          <p className="lv-from text-t3">
            {r.url === 'sample' ? 'From the sample' : r.url}
            {r.status ? ` · ${String(r.status)}` : ''}
          </p>
          {r.message ? <p className="cn-no">{endSentence(r.message)}</p> : null}
          {r.levels.length > 0 ? (
            <ul className="lv-levels">
              {r.levels.map((l) => (
                <TriedLevel key={l.key} l={l} />
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      {out.conversion ? (
        <p className="lv-from text-t3">
          Converted with × {String(out.conversion.ratio)}
          {out.conversion.additive ? ` + ${String(out.conversion.additive)}` : ''}
        </p>
      ) : null}
      {out.problems.length > 0 ? (
        <ul className="lv-problems">
          {out.problems.map((p) => (
            <li key={p} className="cn-no">
              {endSentence(p)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function LevelSourceSheet({ id, draft, onDone }: { id?: string; draft?: string; onDone: () => void }) {
  const editing = id !== undefined;
  const listed = useToolValue('intel.list_sources', editing ? {} : null);
  const drafts = useToolValue('intel.list_source_drafts', draft !== undefined ? {} : null);
  const drafted = draft !== undefined ? (drafts?.drafts.find((d) => d.id === draft) ?? null) : null;
  const existing = editing ? (listed?.sources.find((s) => s.providerId === id)?.spec ?? null) : (drafted?.spec ?? null);
  return (
    <SourceSheet
      key={existing ? 'loaded' : 'new'}
      editing={editing}
      existing={existing}
      drafted={drafted}
      waiting={(editing && !listed) || (draft !== undefined && !drafts)}
      onDone={onDone}
    />
  );
}

function draftSample(d: SourceDraft | null): string {
  const values = Object.values(d?.samples ?? {});
  return values.length === 1 ? JSON.stringify(values[0], null, 2) : '';
}

function SourceSheet({
  editing,
  existing,
  drafted,
  waiting,
  onDone,
}: {
  editing: boolean;
  existing: LevelSourceSpec | null;
  drafted: SourceDraft | null;
  waiting: boolean;
  onDone: () => void;
}) {
  const saved = useSavedWords();
  const [form, setForm] = useState<LevelSourceForm>(() => ({
    ...((existing && formFromSpec(existing)) ?? EMPTY_FORM),
    sample: draftSample(drafted),
  }));
  const unformable = existing !== null && formFromSpec(existing) === null;
  const [mode, setMode] = useState<'form' | 'spec'>(unformable ? 'spec' : 'form');
  const [specText, setSpecText] = useState(() => (unformable ? JSON.stringify(existing, null, 2) : ''));
  const [tried, setTried] = useState<TestSourceOutput | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const { since, run } = useConnectionCall();
  const ids = useId();
  const busy = since !== null || waiting;
  const parsed = mode === 'spec' ? parseSpec(specText) : null;
  const problem = parsed ? ('error' in parsed ? parsed.error : null) : formProblem(form);
  const spec = (): LevelSourceSpec => (parsed && 'spec' in parsed ? parsed.spec : specFromForm(form));
  const sendsKey = parsed && 'spec' in parsed ? parsed.spec.auth !== undefined : form.auth !== 'none';
  const set = (patch: Partial<LevelSourceForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setOutcome(null);
  };
  const switchTo = (next: 'form' | 'spec') => {
    setOutcome(null);
    if (next === 'spec') {
      if (!formProblem(form)) setSpecText(JSON.stringify(specFromForm(form), null, 2));
      setMode('spec');
      return;
    }
    const back = parsed && 'spec' in parsed ? formFromSpec(parsed.spec) : null;
    if (parsed && 'spec' in parsed && !back) {
      setOutcome('This spec says more than the form can show');
      return;
    }
    if (back) setForm((f) => ({ ...back, secret: f.secret, sample: f.sample }));
    setMode('form');
  };
  const setTicker = (i: number, patch: Partial<TickerRow>) =>
    set({ tickers: form.tickers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const setField = (i: number, patch: Partial<FieldRow>) =>
    set({ fields: form.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const secret = form.secret.trim() || undefined;

  const test = async () => {
    const s = samplesOf(form);
    if ('error' in s) {
      setOutcome(s.error);
      return;
    }
    const asked = spec();
    const only = asked.requests.length === 1 ? asked.requests[0]!.id : REQUEST_ID;
    const typed = s.samples[REQUEST_ID];
    const samples: Record<string, JsonValue> =
      typed !== undefined ? { [only]: typed } : { ...(drafted?.samples ?? {}) };
    setTried(null);
    const root = mode === 'form' ? form.tickers.find((t) => t.root.trim() && t.ticker.trim())?.root.trim() : undefined;
    const r = await run('connections.test_level_source', {
      spec: asked,
      ...(secret ? { secret } : {}),
      samples,
      ...(root ? { instrument: root } : {}),
    });
    if (r.ok) setTried(r.out);
    else setOutcome(endSentence(r.why));
  };
  const save = async () => {
    const r = await run('connections.add_level_source', { spec: spec(), ...(secret ? { secret } : {}) });
    if (r.ok) {
      setForm(EMPTY_FORM);
      onDone();
    } else {
      setOutcome(`${endSentence(r.why)} Nothing saved.`);
    }
  };
  const remove = (label: string, onClick: () => void) => (
    <Tooltip content={label}>
      <button type="button" className="dock-act" aria-label={label} onClick={onClick} disabled={busy}>
        <Icon name="remove" />
      </button>
    </Tooltip>
  );

  return (
    <SheetContent
      title={
        editing
          ? `Edit ${existing?.name ?? 'the source'}`
          : drafted
            ? `Review ${drafted.spec.name}`
            : 'Levels from an API'
      }
      description={
        drafted
          ? [drafted.note, ...drafted.problems.map(endSentence)].filter(Boolean).join(' ') ||
            'Drafted by the analyst. Test it with your key, then save it.'
          : undefined
      }
      size={600}
      className="lv-sheet"
      headerRight={
        <Segmented<'form' | 'spec'>
          label="Write it as"
          value={mode}
          onChange={switchTo}
          options={[
            { value: 'form', label: 'Form' },
            { value: 'spec', label: 'Spec' },
          ]}
        />
      }
      footer={
        <FormActions
          start={
            since !== null ? (
              <Elapsed verb="Asking the API" since={since} />
            ) : outcome ? (
              <span className="cn-no" role="status">
                {outcome}
              </span>
            ) : problem && (mode === 'spec' || form.vendor.trim()) ? (
              <span className="text-t3">{problem}</span>
            ) : null
          }
        >
          <Button size="s" variant="quiet" disabled={!!problem || busy} onClick={() => void test()}>
            Test
          </Button>
          <Button size="s" variant="primary" disabled={!!problem || busy} onClick={() => void save()}>
            Save
          </Button>
        </FormActions>
      }
    >
      {mode === 'spec' ? specFields() : fields()}
      {tryIt()}
    </SheetContent>
  );

  function keyRow() {
    return (
      <FormRow
        label="Key"
        htmlFor={`${ids}-key`}
        hint={editing ? `${saved}; leave empty to keep the one saved` : saved}
        layout="fill"
      >
        <TextInput
          id={`${ids}-key`}
          size="s"
          type="password"
          value={form.secret}
          onChange={(e) => set({ secret: e.target.value })}
          disabled={busy}
          autoComplete="off"
        />
      </FormRow>
    );
  }

  function specFields() {
    return (
      <FormSection description="The key itself stays saved on this computer.">
        <textarea
          className="lv-sample lv-spec"
          aria-label="Spec"
          value={specText}
          onChange={(e) => {
            setSpecText(e.target.value);
            setOutcome(null);
          }}
          disabled={busy}
          spellCheck={false}
          rows={16}
        />
        {sendsKey ? keyRow() : null}
      </FormSection>
    );
  }

  function tryIt() {
    return (
      <FormSection
        title="Test"
        description="Paste an answer to read it without calling the API; leave it empty and Test asks the API once."
      >
        <textarea
          className="lv-sample"
          aria-label="A sample answer"
          value={form.sample}
          onChange={(e) => set({ sample: e.target.value })}
          disabled={busy}
          spellCheck={false}
          rows={5}
        />
        {tried ? <Tried out={tried} /> : null}
      </FormSection>
    );
  }

  function fields() {
    return (
      <>
        <FormSection>
          <FormRow label="Vendor" htmlFor={`${ids}-vendor`} layout="fill">
            <TextInput
              id={`${ids}-vendor`}
              size="s"
              value={form.vendor}
              onChange={(e) => set({ vendor: e.target.value })}
              disabled={busy}
              spellCheck={false}
            />
          </FormRow>
          <FormRow label="Product" htmlFor={`${ids}-pkg`} hint="The vendor’s name for these levels" layout="fill">
            <TextInput
              id={`${ids}-pkg`}
              size="s"
              value={form.package}
              onChange={(e) => set({ package: e.target.value })}
              disabled={busy}
              spellCheck={false}
            />
          </FormRow>
          <FormRow
            label="Request"
            htmlFor={`${ids}-url`}
            hint="With {ticker} where the vendor’s ticker goes"
            layout="fill"
          >
            <TextInput
              id={`${ids}-url`}
              size="s"
              value={form.url}
              onChange={(e) => set({ url: e.target.value })}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
            />
          </FormRow>
          <FormRow label="Key goes in" layout="fill">
            <Select<AuthMode>
              size="s"
              label="Key goes in"
              value={form.auth}
              options={AUTH}
              onValueChange={(auth) => set({ auth })}
              disabled={busy}
            />
          </FormRow>
          {form.auth !== 'none' ? (
            <>
              <FormRow label={form.auth === 'header' ? 'Header' : 'Parameter'} htmlFor={`${ids}-an`} layout="fill">
                <TextInput
                  id={`${ids}-an`}
                  size="s"
                  value={form.authName}
                  onChange={(e) => set({ authName: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                />
              </FormRow>
              {form.auth === 'header' ? (
                <FormRow label="Before the key" htmlFor={`${ids}-ap`} layout="fill">
                  <TextInput
                    id={`${ids}-ap`}
                    size="s"
                    value={form.authPrefix}
                    onChange={(e) => set({ authPrefix: e.target.value })}
                    disabled={busy}
                    spellCheck={false}
                  />
                </FormRow>
              ) : null}
              {keyRow()}
            </>
          ) : null}
          <FormRow label="Ask every" htmlFor={`${ids}-every`} layout="fill">
            <TextInput
              id={`${ids}-every`}
              size="s"
              inputMode="numeric"
              unit="s"
              value={form.every}
              onChange={(e) => set({ every: e.target.value })}
              disabled={busy}
            />
          </FormRow>
          <FormRow label="US market hours only" hint="Outside them it is asked once for its last levels">
            <Switch
              label="US market hours only"
              checked={form.rthOnly}
              onCheckedChange={(rthOnly) => set({ rthOnly })}
              disabled={busy}
            />
          </FormRow>
        </FormSection>

        <FormSection
          title="Instruments"
          description="Each instrument and the vendor’s ticker for it. Points added turn the vendor’s price into the future’s (NDX into NQ)."
          headerRight={
            <Button
              size="s"
              variant="quiet"
              disabled={busy}
              onClick={() => set({ tickers: [...form.tickers, { root: '', ticker: '', add: '' }] })}
            >
              Add
            </Button>
          }
        >
          <div className="lv-grid tickers" role="table" aria-label="Instruments">
            <div className="lv-head" role="row">
              <span role="columnheader">Instrument</span>
              <span role="columnheader">Vendor ticker</span>
              <span role="columnheader">Points added</span>
              <span />
            </div>
            {form.tickers.map((t, i) => (
              <div className="lv-line" role="row" key={i}>
                <TextInput
                  size="s"
                  aria-label="Instrument"
                  value={t.root}
                  onChange={(e) => setTicker(i, { root: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                />
                <TextInput
                  size="s"
                  aria-label="Vendor ticker"
                  value={t.ticker}
                  onChange={(e) => setTicker(i, { ticker: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                />
                <TextInput
                  size="s"
                  aria-label="Points added"
                  inputMode="decimal"
                  value={t.add}
                  onChange={(e) => setTicker(i, { add: e.target.value })}
                  disabled={busy}
                />
                {form.tickers.length > 1
                  ? remove('Remove the instrument', () => set({ tickers: form.tickers.filter((_, j) => j !== i) }))
                  : null}
              </div>
            ))}
          </div>
        </FormSection>

        <FormSection
          title="Levels"
          description="The fields of the answer that are levels, under the vendor’s own names. Where: a path into the answer (data.levels.call_wall); empty, the field itself."
          headerRight={
            <Button
              size="s"
              variant="quiet"
              disabled={busy}
              onClick={() => set({ fields: [...form.fields, { field: '', path: '', label: '' }] })}
            >
              Add
            </Button>
          }
        >
          <div className="lv-grid fields" role="table" aria-label="Levels">
            <div className="lv-head" role="row">
              <span role="columnheader">Field</span>
              <span role="columnheader">Where</span>
              <span role="columnheader">Label</span>
              <span />
            </div>
            {form.fields.map((x, i) => (
              <div className="lv-line" role="row" key={i}>
                <TextInput
                  size="s"
                  aria-label="Field"
                  value={x.field}
                  onChange={(e) => setField(i, { field: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                />
                <TextInput
                  size="s"
                  aria-label="Where"
                  value={x.path}
                  onChange={(e) => setField(i, { path: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                />
                <TextInput
                  size="s"
                  aria-label="Label"
                  value={x.label}
                  onChange={(e) => setField(i, { label: e.target.value })}
                  disabled={busy}
                />
                {form.fields.length > 1
                  ? remove('Remove the field', () => set({ fields: form.fields.filter((_, j) => j !== i) }))
                  : null}
              </div>
            ))}
          </div>
          <FormRow
            label="Snapshot time"
            htmlFor={`${ids}-asof`}
            hint="Where the answer says when it was computed"
            layout="fill"
          >
            <div className="lv-pair">
              <TextInput
                id={`${ids}-asof`}
                size="s"
                value={form.asOf}
                onChange={(e) => set({ asOf: e.target.value })}
                disabled={busy}
                spellCheck={false}
              />
              <Select<TimeUnit>
                size="s"
                label="Written as"
                value={form.asOfUnit}
                options={UNITS}
                onValueChange={(asOfUnit) => set({ asOfUnit })}
                disabled={busy || !form.asOf.trim()}
              />
            </div>
          </FormRow>
          <FormRow label="A 0 means not applicable" hint="Drawn as no level, never at 0">
            <Switch
              label="A 0 means not applicable"
              checked={form.zeroIsNa}
              onCheckedChange={(zeroIsNa) => set({ zeroIsNa })}
              disabled={busy}
            />
          </FormRow>
        </FormSection>
      </>
    );
  }
}
