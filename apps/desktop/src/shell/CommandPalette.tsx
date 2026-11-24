import { Icon, Key, PrivateScope, cx, formatPercent, formatPrice, toneOf, PRICE_TEXT, formatMoney } from '@tessera/ui';
import { Command } from 'cmdk';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { usePending } from '../analyst/analystStore.ts';
import { useInstrumentInfo, venueLabel } from '../chart/identity.ts';
import { commands, type Command as PaletteCommand } from '../commands/registry.ts';
import { displaySymbol, useInstrumentSpec } from '../market/instruments.ts';
import { quoteChange, useQuote } from '../market/quotes.ts';
import { symbolRowName, useSymbolSearch, type SymbolHit } from '../market/search.ts';
import { useUi, addRecentCommand, closePalette, setComposerDraft, uiStore } from '../state/ui.ts';
import { revealTile } from '../workspace/dock/open.ts';
import { useActiveChart } from '../state/workspace.ts';
import { showInstrument, splitWithSymbol } from '../workspace/addChart.ts';
import { describeApproval } from './approval.ts';
import { focusComposer } from './composer.ts';
import { ANALYST_KEY } from './keys.ts';
import {
  RECENT_PREFIX,
  browseCommands,
  commandVerb,
  paletteEnter,
  readingsOf,
  symbolValue,
  type Reading,
} from './palette.ts';
import { patch } from '../app/store.ts';

const toolWord = (tool: string) => tool.replace(/[._]/g, ' ');
const ASK = 'ask-agent';
const PRICE = 'price-answer';
const DRAFT = 'open-draft';

function SymbolRow({ hit, onSelect }: { hit: SymbolHit; onSelect: (split: boolean) => void }) {
  const spec = useInstrumentSpec(hit.instrument);
  const id = spec?.instrument ?? hit.instrument;
  const info = useInstrumentInfo(hit.name === null ? hit.instrument : null, null);
  const q = useQuote(id);
  const { pct } = quoteChange(q);
  const symbol = displaySymbol(id);
  const name = symbolRowName({ symbol, instrument: hit.instrument, catalog: hit.name ?? info?.name ?? '' });
  const about = [name || null, info ? venueLabel(info.exchange) : null].filter(Boolean).join(' · ');
  return (
    <Command.Item value={symbolValue(hit.instrument)} onSelect={() => onSelect(false)}>
      <span className="name">{symbol}</span>
      <span className="desc">{about}</span>
      <span className="fig">
        {q?.last !== undefined && q.last !== null ? (
          <span className={PRICE_TEXT}>{formatPrice(q.last, spec?.priceDecimals ?? 2)}</span>
        ) : null}
        {pct !== null ? (
          <span className="chg" data-tone={toneOf(pct)}>
            {formatPercent(pct)}
          </span>
        ) : null}
      </span>
      <span className="kind">chart</span>
    </Command.Item>
  );
}

function PriceRow({ typed, price, onSelect }: { typed: string; price: number; onSelect: () => void }) {
  const chart = useActiveChart();
  const spec = useInstrumentSpec(chart?.instrument ?? null);
  const q = useQuote(spec?.instrument ?? chart?.instrument ?? null);
  const last = q?.last ?? null;
  const dp = spec?.priceDecimals ?? 2;
  const d = last === null ? null : price - last;
  const ticks = d !== null && spec ? Math.round(Math.abs(d) / spec.tickSize) : null;
  const money = d !== null && spec ? Math.abs(d) * spec.multiplier : null;
  const sym = spec ? displaySymbol(spec.instrument).split(' ')[0] : null;
  return (
    <Command.Item value={PRICE} onSelect={onSelect}>
      <span className="name">{typed}</span>
      <span className="fig wide">
        <span className={PRICE_TEXT}>{formatPrice(price, dp)}</span>
      </span>
      <span className="desc right">
        {d === null
          ? 'no last price'
          : d === 0
            ? 'at last'
            : `${formatPrice(Math.abs(d), dp)} ${d < 0 ? 'below' : 'above'} last`}
        {ticks !== null && d ? ` · ${String(ticks)} ticks` : ''}
        {money !== null && d ? (
          <>
            {' · '}
            <b>{formatMoney(money)}</b> per {sym}
          </>
        ) : null}
      </span>
    </Command.Item>
  );
}

function CommandRow({
  command,
  value,
  group,
  onSelect,
}: {
  command: PaletteCommand;
  value: string;
  group: boolean;
  onSelect: () => void;
}) {
  return (
    <Command.Item className="is-cmd" value={value} disabled={!commands.isEnabled(command.id)} onSelect={onSelect}>
      <span className="name">{command.title}</span>
      <span className="desc">{command.hint?.() ?? (group ? command.group : null)}</span>
      <span className="kind">{command.shortcut ? <Key shortcut={command.shortcut} className="text-t3" /> : null}</span>
    </Command.Item>
  );
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  if (!open) return null;
  return (
    <PrivateScope>
      <PaletteLine />
    </PrivateScope>
  );
}

function PaletteLine() {
  const query = useUi((s) => s.paletteQuery);
  const recents = useUi((s) => s.recentSymbols);
  const recentCommands = useUi((s) => s.recentCommands);
  const [picked, setPicked] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const inEvent = useRef<'key' | 'pointer' | null>(null);
  const held = useRef<{ split: boolean } | null>(null);
  useSyncExternalStore(commands.subscribe, commands.getVersion);
  const chart = useActiveChart();
  const spec = useInstrumentSpec(chart?.instrument ?? null);
  const last = useQuote(spec?.instrument ?? chart?.instrument ?? null)?.last ?? null;
  const pending = usePending();
  const draft = pending.find((a) => a.risk === 'financial') ?? null;

  const q = query.trim();
  const search = useSymbolSearch(q.startsWith('?') ? '' : q, 6, recents);
  const results = q ? commands.search(q).slice(0, 7) : [];
  const browsing = !q;
  const browse = browseCommands(
    browsing ? commands.list().filter((c) => commands.isEnabled(c.id)) : [],
    recentCommands,
  );
  const browsed = [...browse.recent, ...browse.groups.flatMap((g) => g.commands)];
  const symbolRows = q.startsWith('?') || (!q && recents.length === 0) ? [] : search.hits;
  const readings = readingsOf(query, last, symbolRows.length + results.length > 0);
  const current: Reading = readings[Math.min(reading, readings.length - 1)] ?? { kind: 'rows' };

  const close = (refocus = true) => {
    closePalette();
    if (refocus && returnTo.current instanceof HTMLElement) returnTo.current.focus({ preventScroll: true });
  };

  useEffect(() => {
    returnTo.current = document.activeElement;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) closePalette();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  const pickSymbol = (instrument: string, split: boolean) => {
    close();
    void (split ? splitWithSymbol(instrument) : showInstrument(instrument));
  };
  const runCommand = (id: string) => {
    close();
    addRecentCommand(id);
    commands.run(id);
  };
  const commandOf = (value: string): PaletteCommand | null => {
    const id = value.startsWith(RECENT_PREFIX) ? value.slice(RECENT_PREFIX.length) : value;
    return (
      results.find((r) => r.command.id.toLowerCase() === id)?.command ??
      browsed.find((c) => c.id.toLowerCase() === id) ??
      null
    );
  };
  const choose = (value: string, split: boolean) => {
    const hit = symbolRows.find((s) => symbolValue(s.instrument) === value);
    const cmd = commandOf(value);
    if (hit) pickSymbol(hit.instrument, split);
    else if (cmd) runCommand(cmd.id);
  };
  const ask = (text: string) => {
    setComposerDraft(text);
    close(false);
    commands.run('agent.focusComposer');
    focusComposer();
  };

  const showRows = current.kind !== 'ask';
  const priceRow = current.kind === 'price';
  const values = [
    ...(current.kind === 'ask' ? [ASK] : []),
    ...(priceRow ? [PRICE] : []),
    ...(!q && draft ? [DRAFT] : []),
    ...(showRows && !priceRow ? symbolRows.map((s) => symbolValue(s.instrument)) : []),
    ...(showRows ? results.filter((r) => commands.isEnabled(r.command.id)).map((r) => r.command.id.toLowerCase()) : []),
    ...(showRows ? browse.recent.map((c) => `${RECENT_PREFIX}${c.id.toLowerCase()}`) : []),
    ...(showRows ? browse.groups.flatMap((g) => g.commands.map((c) => c.id.toLowerCase())) : []),
  ];
  const active = picked !== null && values.includes(picked) ? picked : (values[0] ?? '');
  const waitForSymbols = current.kind === 'rows' && search.searching && active !== picked;

  useEffect(() => {
    const hold = held.current;
    if (!hold || search.searching) return;
    held.current = null;
    const first = values[0] ?? '';
    if (paletteEnter(symbolRows, first).kind !== 'none') choose(first, hold.split);
  });

  let enter: ReactNode = null;
  let other: ReactNode = null;
  if (active === ASK) enter = 'ask';
  else if (active === PRICE) enter = 'copy';
  else if (active === DRAFT) enter = 'open draft';
  else if (active.startsWith('symbol:')) {
    enter = 'chart';
    other = (
      <>
        <Key shortcut="shift+enter" className="text-inherit in-[.show-keys]:text-inherit" /> split
      </>
    );
  } else if (active) {
    const cmd = commandOf(active);
    enter = cmd ? commandVerb(cmd.title) : null;
  }
  if (readings.length > 1) {
    const next = readings[(Math.min(reading, readings.length - 1) + 1) % readings.length]!;
    other = (
      <>
        <Key shortcut="tab" className="text-inherit in-[.show-keys]:text-inherit" />{' '}
        {next.kind === 'ask' ? 'ask' : next.kind === 'price' ? 'answer' : 'rows'}
      </>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (readings.length > 1) {
        const i = Math.min(reading, readings.length - 1);
        setReading((i + (e.shiftKey ? readings.length - 1 : 1)) % readings.length);
        setPicked(null);
        held.current = null;
      }
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing && waitForSymbols) {
      e.preventDefault();
      held.current = { split: e.shiftKey };
    } else if (e.key === 'Enter' && e.shiftKey && active.startsWith('symbol:')) {
      e.preventDefault();
      choose(active, true);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
    }
  };

  const eventStarts = (e: SyntheticEvent) => {
    inEvent.current = e.type === 'keydown' ? 'key' : 'pointer';
  };
  const eventEnds = () => {
    inEvent.current = null;
  };

  const asking = current.kind === 'ask';
  return (
    <div
      ref={root}
      className="t-palette-v5"
      data-private=""
      role="dialog"
      aria-label="Command palette"
      data-focus-zone="palette"
      onKeyDownCapture={eventStarts}
      onKeyDown={eventEnds}
      onPointerMoveCapture={eventStarts}
      onPointerMove={eventEnds}
    >
      <Command
        label="Command palette"
        shouldFilter={false}
        loop
        value={active}
        onValueChange={(v) => {
          if (inEvent.current) setPicked(v.toLowerCase());
          if (inEvent.current === 'key') held.current = null;
        }}
        onKeyDown={onKeyDown}
      >
        <div className={cx('pal-line', asking && 'is-ask')}>
          <Icon name={asking ? 'analyst' : 'command'} className="prompt" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={(v) => {
              patch(uiStore, { paletteQuery: v });
              setReading(0);
              setPicked(null);
              held.current = null;
            }}
            placeholder="Symbol or command · ? asks the analyst"
          />
          {other ? <span className="nx">{other}</span> : null}
          {enter ? (
            <span className="enter">
              <Key shortcut="enter" className="text-inherit in-[.show-keys]:text-inherit" /> {enter}
            </span>
          ) : null}
        </div>
        <Command.List>
          {search.failed && q && !q.startsWith('?') ? (
            <div className="pal-note" role="status">
              Search could not reach the feed. Symbols on the desk still work.
            </div>
          ) : null}
          {q ? (
            <Command.Empty>
              {search.failed ? 'Search could not reach the feed.' : `No symbol or command matches “${q}”`}
            </Command.Empty>
          ) : null}
          {current.kind === 'ask' ? (
            <Command.Item value={ASK} onSelect={() => ask(current.text)}>
              <span className="name">Ask the analyst</span>
              <span className="desc">{current.text || '…'}</span>
            </Command.Item>
          ) : null}
          {current.kind === 'price' ? (
            <PriceRow
              typed={q}
              price={current.price}
              onSelect={() => {
                const text = formatPrice(current.price, spec?.priceDecimals ?? 2);
                void Promise.resolve()
                  .then(() => navigator.clipboard.writeText(text))
                  .catch(() => undefined);
                close();
              }}
            />
          ) : null}
          {!q && draft ? (
            <Command.Item
              value={DRAFT}
              onSelect={() => {
                close(false);
                revealTile('analyst', { via: 'key' });
              }}
            >
              <span className="name">
                <i className="t-halftile" aria-hidden="true" />
                Draft
              </span>
              <span className="desc">{describeApproval(draft).restatement ?? toolWord(draft.tool)}</span>
              <span className="kind">
                <Key shortcut={ANALYST_KEY} className="text-t3" />
              </span>
            </Command.Item>
          ) : null}
          {showRows && !priceRow && symbolRows.length > 0 ? (
            <Command.Group heading={browsing ? 'Recent symbols' : undefined}>
              {symbolRows.map((s) => (
                <SymbolRow key={s.instrument} hit={s} onSelect={(split) => pickSymbol(s.instrument, split)} />
              ))}
            </Command.Group>
          ) : null}
          {showRows
            ? results.map(({ command }) => (
                <CommandRow
                  key={command.id}
                  command={command}
                  value={command.id.toLowerCase()}
                  group
                  onSelect={() => runCommand(command.id)}
                />
              ))
            : null}
          {showRows && browse.recent.length > 0 ? (
            <Command.Group heading="Recent">
              {browse.recent.map((c) => (
                <CommandRow
                  key={c.id}
                  command={c}
                  value={`${RECENT_PREFIX}${c.id.toLowerCase()}`}
                  group
                  onSelect={() => runCommand(c.id)}
                />
              ))}
            </Command.Group>
          ) : null}
          {showRows
            ? browse.groups.map(({ group, commands: list }) => (
                <Command.Group key={group} heading={group}>
                  {list.map((c) => (
                    <CommandRow
                      key={c.id}
                      command={c}
                      value={c.id.toLowerCase()}
                      group={false}
                      onSelect={() => runCommand(c.id)}
                    />
                  ))}
                </Command.Group>
              ))
            : null}
        </Command.List>
      </Command>
    </div>
  );
}
