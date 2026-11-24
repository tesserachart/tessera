import {
  Button,
  Choice,
  Combobox,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  FormActions,
  FormHint,
  FormRow,
  FormSection,
  Menu,
  MenuCheckboxItem,
  Readout,
  ReadoutRow,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  ScrollArea,
  SearchList,
  Select,
  Sheet,
  SheetContent,
  SheetTrigger,
  Stepper,
  Switch,
  ToggleGroup,
  TextInput,
  type ComboboxOption,
  type SelectOption,
} from '@tessera/ui';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { TIME_ZONE_OPTIONS } from '../state/timeZone.ts';

const INTERVALS: readonly SelectOption[] = [
  { value: '1m', label: '1 minute', group: 'Intraday' },
  { value: '5m', label: '5 minutes', group: 'Intraday' },
  { value: '15m', label: '15 minutes', group: 'Intraday' },
  { value: '1h', label: '1 hour', group: 'Intraday' },
  { value: '1d', label: '1 day', group: 'Daily and up' },
  { value: '1w', label: '1 week', group: 'Daily and up', disabled: true, hint: 'soon' },
];

const SOURCES: readonly SelectOption[] = [
  { value: 'close', label: 'Close' },
  { value: 'hlc3', label: 'HLC/3', hint: 'typical' },
  { value: 'ohlc4', label: 'OHLC/4' },
];

const INDICATORS: readonly ComboboxOption[] = [
  { value: 'vwap', label: 'VWAP', group: 'Trend', keywords: ['volume weighted average price'], hint: 'price' },
  { value: 'ema', label: 'EMA', group: 'Trend', keywords: ['exponential moving average'], hint: 'price' },
  { value: 'sma', label: 'SMA', group: 'Trend', keywords: ['simple moving average'], hint: 'price' },
  { value: 'rsi', label: 'RSI', group: 'Momentum', keywords: ['relative strength index'], hint: 'pane' },
  { value: 'macd', label: 'MACD', group: 'Momentum', keywords: ['moving average convergence'], hint: 'pane' },
  { value: 'atr', label: 'ATR', group: 'Volatility', keywords: ['average true range'], hint: 'pane' },
  { value: 'bb', label: 'Bollinger bands', group: 'Volatility', hint: 'price' },
  { value: 'svp', label: 'Session volume profile', group: 'Order flow', keywords: ['vah', 'val', 'poc'] },
  { value: 'vrp', label: 'Visible range profile', group: 'Order flow', keywords: ['volume'] },
  { value: 'cvd', label: 'Cumulative delta', group: 'Order flow', keywords: ['cvd', 'volume'], hint: 'pane' },
  { value: 'fp', label: 'Footprint', group: 'Order flow', keywords: ['bid ask', 'imbalance'] },
  { value: 'big', label: 'Big trades', group: 'Order flow', disabled: true, hint: 'needs prints' },
];

const ZONES = TIME_ZONE_OPTIONS;

function H({ children, small, style }: { children: ReactNode; small?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="kit-h" style={style}>
      {children} {small ? <small>{small}</small> : null}
    </div>
  );
}

function Cell({ cap, children, w }: { cap: ReactNode; children: ReactNode; w?: number }) {
  return (
    <div className="kit-cell" style={w ? { width: w } : undefined}>
      <div className="kit-cell-body">{children}</div>
      <div className="kit-cap">{cap}</div>
    </div>
  );
}

function StillPopover({ children, w = 320 }: { children: ReactNode; w?: number }) {
  return (
    <div className="t-popover" style={{ width: w, position: 'static', zIndex: 'auto' }}>
      {children}
    </div>
  );
}

function IndicatorForm() {
  const [length, setLength] = useState('14');
  const [source, setSource] = useState('close');
  const [bands, setBands] = useState(true);
  const [scale, setScale] = useState(false);
  return (
    <StillPopover>
      <FormSection title="Inputs">
        <FormRow label="Length" htmlFor="kit-len" layout="fill">
          <TextInput id="kit-len" size="s" value={length} onChange={(e) => setLength(e.target.value)} />
        </FormRow>
        <FormRow label="Source" htmlFor="kit-src" layout="fill">
          <Select id="kit-src" size="s" options={SOURCES} value={source} onValueChange={setSource} />
        </FormRow>
        <FormRow label="Overbought" htmlFor="kit-ob" layout="fill" error="Between 50 and 100.">
          <TextInput id="kit-ob" size="s" defaultValue="120" />
        </FormRow>
      </FormSection>
      <FormSection
        title="Style"
        headerRight={
          <Button variant="quiet" size="s">
            Reset
          </Button>
        }
      >
        <FormRow label="Bands" hint="70 and 30, shaded between" htmlFor="kit-bands">
          <Switch id="kit-bands" checked={bands} onCheckedChange={setBands} />
        </FormRow>
        <FormRow label="Value on the price scale" htmlFor="kit-scale">
          <Switch id="kit-scale" checked={scale} onCheckedChange={setScale} />
        </FormRow>
        <FormHint>Saved with the chart&apos;s template.</FormHint>
      </FormSection>
      <FormActions
        start={
          <Button variant="quiet" size="s">
            Remove
          </Button>
        }
      >
        <Button size="s" variant="primary">
          Done
        </Button>
      </FormActions>
    </StillPopover>
  );
}

function SheetSample() {
  const [notes, setNotes] = useState(true);
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button>Open the sheet</Button>
      </SheetTrigger>
      <SheetContent
        title="Eval 50K · ••0042"
        description="The account's rules and where its data comes from."
        footer={
          <FormActions start={<Button variant="quiet">Disconnect</Button>}>
            <Button variant="primary">Save</Button>
          </FormActions>
        }
      >
        <FormSection title="Rules">
          <FormRow label="Daily loss limit" hint="Resets 17:00 Chicago" htmlFor="kit-dll" layout="fill">
            <TextInput id="kit-dll" defaultValue="1,000" unit="USD" />
          </FormRow>
          <FormRow label="Firm’s drawdown" htmlFor="kit-tdd" layout="fill">
            <TextInput id="kit-tdd" defaultValue="2,500" unit="USD" />
          </FormRow>
          <FormRow label="Timezone" htmlFor="kit-tz" layout="fill">
            <Combobox id="kit-tz" label="Timezone" options={ZONES} defaultValue="America/Chicago" />
          </FormRow>
        </FormSection>
        <FormSection title="Notes">
          <FormRow label="Ask before every order" htmlFor="kit-ask">
            <Switch id="kit-ask" checked={notes} onCheckedChange={setNotes} />
          </FormRow>
        </FormSection>
      </SheetContent>
    </Sheet>
  );
}

function MenuSample() {
  const [grid, setGrid] = useState(true);
  const [type, setType] = useState('candles');
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="s">Drawing menu</Button>
      </MenuTrigger>
      <MenuContent aria-label="Drawing menu">
        <MenuLabel>Lines</MenuLabel>
        <MenuItem icon="trend-line" shortcut="alt+t">
          Trend line
        </MenuItem>
        <MenuItem icon="h-line" shortcut="alt+h" current>
          Horizontal line
        </MenuItem>
        <MenuItem icon="measure" shortcut="alt+m">
          Measure
        </MenuItem>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger hint={type === 'candles' ? 'Candles' : type === 'bars' ? 'Bars' : 'Line'}>
            Chart type
          </MenuSubTrigger>
          <MenuSubContent>
            <MenuRadioGroup value={type} onValueChange={setType}>
              <MenuRadioItem value="candles">Candles</MenuRadioItem>
              <MenuRadioItem value="bars">Bars</MenuRadioItem>
              <MenuRadioItem value="line">Line</MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubContent>
        </MenuSub>
        <MenuCheckboxItem checked={grid} onCheckedChange={setGrid} onSelect={(e) => e.preventDefault()}>
          Grid
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem destructive shortcut="mod+w">
          Close
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function ContextTarget() {
  const [grid, setGrid] = useState(true);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="kit-ctx">Right-click here</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>NQ Z6 · 20,641.25</ContextMenuLabel>
        <ContextMenuItem shortcut="b">Buy limit here</ContextMenuItem>
        <ContextMenuItem shortcut="s">Sell limit here</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger hint="5m">Interval</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem>1 minute</ContextMenuItem>
            <ContextMenuItem current>5 minutes</ContextMenuItem>
            <ContextMenuItem>15 minutes</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuCheckboxItem checked={grid} onCheckedChange={setGrid}>
          Grid
        </ContextMenuCheckboxItem>
        <ContextMenuItem disabled hint="no drawing">
          Delete drawing
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive>Remove all drawings</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function PageShared() {
  const [interval, setIv] = useState('5m');
  const [risk, setRisk] = useState(true);
  const [qty, setQty] = useState(2);
  const [ticks, setTicks] = useState(40);
  const [shown, setShown] = useState<string[]>(['1m', '5m', '1h']);
  const [picked, setPicked] = useState<string | null>(null);
  const [breach, setBreach] = useState('ask');
  return (
    <section className="kit-page" id="p5">
      <header className="kit-head">
        <span>
          <b>Tessera</b> system · 7 Oct 2026
        </span>
        <span>05 Shared controls</span>
      </header>
      <div className="abs" style={{ left: 96, top: 104, width: 820 }}>
        <H small="one of a longer list: the field's box, the menu's rows">Select</H>
        <div className="row gap24">
          <Cell w={180} cap="Field. The chosen row by the mist rule.">
            <Select label="Interval" options={INTERVALS} value={interval} onValueChange={setIv} />
          </Cell>
          <Cell w={150} cap="Small, 28: rows, popovers.">
            <Select label="Source" size="s" options={SOURCES} defaultValue="hlc3" />
          </Cell>
          <Cell w={130} cap="Quiet: toolbars.">
            <Select label="Interval" variant="quiet" options={INTERVALS} value={interval} onValueChange={setIv} />
          </Cell>
          <Cell w={150} cap="Disabled.">
            <Select label="Source" options={SOURCES} defaultValue="close" disabled />
          </Cell>
        </div>

        <H style={{ marginTop: 28 }} small="one thing on, at once; square, the checkbox's mist">
          Switch
        </H>
        <div className="row gap24" style={{ alignItems: 'flex-start' }}>
          <Cell cap="Off · on">
            <div className="row gap12">
              <Switch label="Off" />
              <Switch label="On" defaultChecked />
            </div>
          </Cell>
          <Cell cap="Disabled">
            <div className="row gap12">
              <Switch label="Off" disabled />
              <Switch label="On" disabled defaultChecked />
            </div>
          </Cell>
          <Cell cap="With its words: the row is the target.">
            <Switch checked={risk} onCheckedChange={setRisk}>
              Size by risk
            </Switch>
          </Cell>
          <Cell cap="A choice of words stays a Choice.">
            <Choice
              label="On a breach"
              value={breach}
              onChange={setBreach}
              options={[
                { value: 'mark', label: 'Mark' },
                { value: 'ask', label: 'Ask first' },
                { value: 'block', label: 'Block' },
              ]}
            />
          </Cell>
        </div>

        <H style={{ marginTop: 28 }} small="a number and its steppers: typed as typed, ↑ ↓ step, ⇧ several">
          Stepper
        </H>
        <div className="row gap24" style={{ alignItems: 'flex-start' }}>
          <Cell w={120} cap="Contracts, with its targets.">
            <Stepper label="Contracts" value={qty} min={1} shiftSteps={5} onValueChange={setQty} size="s" />
          </Cell>
          <Cell w={90} cap="A leg: its unit, keys only.">
            <Stepper label="Stop" value={ticks} min={1} suffix="t" buttons={false} onValueChange={setTicks} size="s" />
          </Cell>
          <Cell w={120} cap="Disabled.">
            <Stepper label="Money at risk" value={250} prefix="$" onValueChange={() => undefined} disabled size="s" />
          </Cell>
        </div>

        <H style={{ marginTop: 28 }} small="figures read, not set: the label t3, the value at the row's end">
          Read-out
        </H>
        <div className="row gap24" style={{ alignItems: 'flex-start' }}>
          <Cell w={300} cap="Profit and loss in their tones; a note before the value.">
            <Readout label="Read-out">
              <ReadoutRow label="Position" value="+2 @ 20,630.25" />
              <ReadoutRow label="Open P/L" value="+$125.00" tone="up" />
              <ReadoutRow label="Today" value="−$660.00" tone="down" note="$340.00 left" />
            </Readout>
          </Cell>
        </div>

        <H style={{ marginTop: 28 }} small="several at once, each on or off; one Tab stop, the arrows walk it">
          Toggle group
        </H>
        <div className="row gap24" style={{ alignItems: 'flex-start' }}>
          <Cell w={300} cap="Intervals in the toolbar.">
            <ToggleGroup
              label="Intervals in the toolbar"
              options={['1m', '5m', '15m', '1h', '4h', '1D'].map((t) => ({ value: t, label: t }))}
              value={shown}
              onToggle={(t, on) => setShown((s) => (on ? [...s, t] : s.filter((x) => x !== t)))}
            />
          </Cell>
          <Cell w={200} cap="Disabled (its source is off).">
            <ToggleGroup
              label="Levels to draw"
              disabled
              options={[
                { value: 'hi', label: 'Prior high' },
                { value: 'lo', label: 'Prior low' },
              ]}
              value={['hi']}
              onToggle={() => undefined}
            />
          </Cell>
        </div>

        <H style={{ marginTop: 28 }} small="type to narrow, ↑↓, ⏎; groups; the best match first">
          Combobox and the searchable list
        </H>
        <div className="row gap24" style={{ alignItems: 'flex-start' }}>
          <Cell w={220} cap={picked ? `Took ${picked}.` : 'The box, like a select; it opens a search.'}>
            <Combobox
              label="Indicator"
              options={INDICATORS}
              placeholder="Add an indicator"
              value={picked}
              onValueChange={setPicked}
            />
          </Cell>
          <Cell cap="The list on its own (an Add-indicator dialog).">
            <StillPopover w={260}>
              <div style={{ margin: '-12px -16px -16px' }}>
                <SearchList label="Indicators" options={INDICATORS} value="vwap" onSelect={noop} />
              </div>
            </StillPopover>
          </Cell>
          <Cell cap="“vol”: words that start with it first.">
            <StillPopover w={260}>
              <div style={{ margin: '-12px -16px -16px' }}>
                <SearchList label="Indicators" options={INDICATORS} defaultQuery="vol" onSelect={noop} />
              </div>
            </StillPopover>
          </Cell>
        </div>
      </div>

      <div className="abs" style={{ left: 1012, top: 104, width: 812 }}>
        <H small="label left, control right; a section's name; the form's end">Popover form</H>
        <div className="row gap24" style={{ alignItems: 'flex-start' }}>
          <IndicatorForm />
          <div className="col gap16" style={{ width: 380 }}>
            <Cell cap="Nothing matches: it says so.">
              <StillPopover w={260}>
                <div style={{ margin: '-12px -16px -16px' }}>
                  <SearchList label="Indicators" options={INDICATORS} defaultQuery="zz" onSelect={noop} />
                </div>
              </StillPopover>
            </Cell>
            <Cell cap="The menu: it grows out of its trigger; the lit row takes the rail's rule; glyphs optional, keys dim at the end, a tick for on, the rule for the chosen; Close in the down colour only while lit.">
              <MenuSample />
            </Cell>
          </div>
        </div>

        <H style={{ marginTop: 28 }} small="the 4 px pill over the edge, no gutter">
          Scroll area, right-click menu, sheet
        </H>
        <div className="row gap24" style={{ alignItems: 'flex-start' }}>
          <Cell w={220} cap="Always shown here; at rest it comes up under the pointer.">
            <ScrollArea type="always" className="kit-scroll">
              {Array.from({ length: 30 }, (_, i) => (
                <div key={i} className="t-menu-item">
                  {`Fill ${String(30 - i)}`}
                  <span className="r">{`14:${String(10 + i).padStart(2, '0')}`}</span>
                </div>
              ))}
            </ScrollArea>
          </Cell>
          <Cell w={220} cap="The menu at the pointer: same rows, keys and rules.">
            <ContextTarget />
          </Cell>
          <Cell w={220} cap="A drawer on the edge: slides in 220 ms, out 150.">
            <SheetSample />
          </Cell>
        </div>
      </div>
    </section>
  );
}

const noop = () => undefined;
