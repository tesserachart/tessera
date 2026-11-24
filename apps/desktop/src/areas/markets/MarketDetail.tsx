import type { ContractSpec, SessionsOutput } from '@tessera/protocol';
import {
  Button,
  Kv,
  Loaded,
  Menu,
  MenuContent,
  MenuTrigger,
  formatCountdown,
  formatPercent,
  formatPrice,
  formatSigned,
  formatVolume,
  toneOf,
  type KvRow,
  type Tone,
  FIGURE_CARD_TEXT,
  PRICE_TEXT,
  cx,
} from '@tessera/ui';
import type { ReactNode } from 'react';
import { assetClassLabel, venueLabel } from '../../chart/identity.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { quoteChange } from '../../market/quotes.ts';
import { OPEN_KEYS, OPEN_WORDS, removeFromWatchlist, type OpenHow } from '../../markets/actions.ts';
import { rangeAt } from '../../markets/lists.ts';
import type { useRowQuote } from '../../markets/rowData.ts';
import { WatchlistItems } from '../../markets/WatchlistItems.tsx';
import { useWatchlists, type Watchlist } from '../../markets/watchlists.ts';
import { hoursRows, marketSession } from '../../markets/sessions.ts';
import { dayWords, instantWords, pointWords, tickWords } from '../../markets/words.ts';
import { useMarketFacts, type DetailSubject } from './facts.ts';
import type { ConnectionTag, MarketRow } from './model.ts';

export function MarketDetail(props: {
  subject: DetailSubject;
  connectionOf: (id: string) => ConnectionTag | null;
  nowMs: number;
  onOpen: (id: string, how: OpenHow) => void;
}) {
  return (
    <Loaded label="Loading market" sample={<MarketDetailSample />}>
      <DetailBody {...props} />
    </Loaded>
  );
}

interface DetailFace {
  symbol: string;
  name: string;
  last: string;
  change: string;
  changeTone: Tone;
  pct: string;
  pctTone: Tone;
  range: { low: string; high: string; at: number } | null;
  tradable: boolean;
  facts: KvRow[];
  lists: string;
}

function DetailView({
  face,
  onOpen,
  listsButton,
}: {
  face: DetailFace;
  onOpen: (how: OpenHow) => void;
  listsButton: ReactNode;
}) {
  return (
    <section className="mk-detail" aria-label={`${face.symbol} details`}>
      <header className="mk-d-head">
        <h2>{face.symbol}</h2>
        <span className="name">{face.name}</span>
      </header>
      <div className="mk-d-price">
        <span className={FIGURE_CARD_TEXT}>{face.last}</span>
        <span className="chg" data-tone={face.changeTone}>
          {face.change}
        </span>
        <span className="chg" data-tone={face.pctTone}>
          {face.pct}
        </span>
      </div>
      {face.range ? (
        <div className="mk-d-range" aria-label="Session range">
          <span className={cx('s', PRICE_TEXT)}>{face.range.low}</span>
          <span className="bar">
            <i style={{ left: `${String(face.range.at * 100)}%` }} />
          </span>
          <span className={cx('s', PRICE_TEXT)}>{face.range.high}</span>
        </div>
      ) : null}
      <div className="mk-d-actions">
        <Button size="s" variant="primary" shortcut={OPEN_KEYS.chart} onClick={() => onOpen('chart')}>
          {OPEN_WORDS.chart}
        </Button>
        <Button size="s" shortcut={OPEN_KEYS.tab} onClick={() => onOpen('tab')}>
          New tab
        </Button>
        <Button size="s" shortcut={OPEN_KEYS.split} onClick={() => onOpen('split')}>
          Split
        </Button>
        {face.tradable ? (
          <Button size="s" shortcut={OPEN_KEYS.dom} onClick={() => onOpen('dom')}>
            DOM
          </Button>
        ) : null}
      </div>
      <Kv className="mk-d-kv" rows={face.facts} />
      <div className="mk-d-lists">
        <span className="lbl">Watchlists</span>
        <span className="in">{face.lists}</span>
        {listsButton}
      </div>
    </section>
  );
}

const SAMPLE_DETAIL: DetailFace = {
  symbol: 'NQ Z6',
  name: 'E-mini Nasdaq-100 Dec 2026',
  last: '00,000.00',
  change: '+000.00',
  changeTone: 'up',
  pct: '+0.00%',
  pctTone: 'up',
  range: { low: '00,000.00', high: '00,000.00', at: 0.6 },
  tradable: true,
  facts: [
    { label: 'Exchange', value: 'CME Globex' },
    { label: 'Connection', value: 'Rithmic Paper' },
    { label: 'Class', value: 'Future' },
    { label: 'Tick', value: '0.25 = $5.00' },
    { label: 'Point value', value: '$20.00' },
    { label: 'Session', value: 'Regular · closes in 0h 00m' },
    { label: 'Hours', value: 'Sun–Fri 18:00–17:00' },
    { label: 'Expiry', value: 'Fri 18 Dec 2026' },
    { label: 'Last trade', value: 'Fri 18 Dec 2026 09:30' },
    { label: 'Roll', value: 'Thu 10 Dec 2026' },
    { label: 'Currency', value: 'USD' },
    { label: 'Open', value: '00,000.00' },
    { label: 'Prior close', value: '00,000.00' },
    { label: 'Volume', value: '000.0K' },
  ],
  lists: 'Index futures',
};

const stayPut = () => undefined;

export function MarketDetailSample() {
  return (
    <DetailView
      face={SAMPLE_DETAIL}
      onOpen={stayPut}
      listsButton={
        <Button size="s" variant="quiet">
          Change
        </Button>
      }
    />
  );
}

function DetailBody({
  subject,
  connectionOf,
  nowMs,
  onOpen,
}: {
  subject: DetailSubject;
  connectionOf: (id: string) => ConnectionTag | null;
  nowMs: number;
  onOpen: (id: string, how: OpenHow) => void;
}) {
  const { id, row } = subject;
  const { spec, resolved, missing, sessions, info, q } = useMarketFacts(subject, nowMs);
  const i = row?.instrument ?? info;
  const lists = useWatchlists((s) => s.value.lists);
  const symbol = displaySymbol(resolved ?? id);
  const dp = spec?.priceDecimals ?? 2;
  const { change, pct } = quoteChange(q);
  const at = rangeAt(q);
  const lo = q?.session?.low ?? null;
  const hi = q?.session?.high ?? null;
  const conn = row?.connection ?? connectionOf(resolved ?? id);
  const holding = lists.filter((l) => l.symbols.includes(id) || (resolved !== null && l.symbols.includes(resolved)));
  return (
    <DetailView
      face={{
        symbol,
        name: i?.name ?? (missing ? 'No connection serves it' : ''),
        last: formatPrice(q?.last, dp),
        change: change === null ? '' : formatSigned(change, dp, true),
        changeTone: toneOf(change),
        pct: pct === null ? '' : formatPercent(pct),
        pctTone: toneOf(pct),
        range:
          at !== null && lo !== null && hi !== null
            ? { low: formatPrice(lo, dp), high: formatPrice(hi, dp), at }
            : null,
        tradable: i?.tradable !== false,
        facts: specRows(spec, sessions, i?.exchange ?? null, i?.assetClass ?? null, conn, nowMs, q),
        lists: holding.length > 0 ? holding.map((l) => l.name).join(', ') : 'In none',
      }}
      onOpen={(how) => onOpen(id, how)}
      listsButton={<WatchlistButton symbols={[id]} holding={holding} />}
    />
  );
}

function WatchlistButton({ symbols, holding = [] }: { symbols: readonly string[]; holding?: readonly Watchlist[] }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="s" variant="quiet">
          {holding.length > 0 ? 'Change' : 'Add'}
        </Button>
      </MenuTrigger>
      <MenuContent align="end" style={{ minWidth: 200 }}>
        <WatchlistItems symbols={symbols} />
      </MenuContent>
    </Menu>
  );
}

function specRows(
  spec: ContractSpec | null,
  sessions: SessionsOutput | null,
  exchange: string | null,
  assetClass: ContractSpec['assetClass'] | null,
  conn: ConnectionTag | null,
  nowMs: number,
  q: ReturnType<typeof useRowQuote>,
): KvRow[] {
  const rows: KvRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) rows.push({ label, value });
  };
  add('Exchange', exchange ? venueLabel(exchange) : null);
  add('Connection', conn?.name);
  add('Class', assetClass ? assetClassLabel(assetClass) : null);
  if (spec) {
    add('Tick', tickWords(spec));
    if (spec.assetClass === 'future') add('Point value', pointWords(spec));
    const now = sessions ? marketSession(nowMs, sessions) : null;
    const holiday = now?.holiday ? ` · ${now.holiday}` : '';
    const closes = now?.closesInMs ? ` · closes in ${formatCountdown(now.closesInMs)}` : '';
    add('Session', now ? `${now.label}${holiday}${closes}` : null);
    for (const row of sessions ? hoursRows(sessions.hours) : []) add(row.label, row.value);
    add('Expiry', dayWords(spec.expiry));
    add('Last trade', instantWords(spec.lastTrade));
    add('Roll', dayWords(spec.rollDate));
    add('Currency', spec.currency);
  }
  const s = q?.session;
  if (s) {
    add('Open', s.open !== null ? formatPrice(s.open, spec?.priceDecimals ?? 2) : null);
    add('Prior close', s.prevClose !== null ? formatPrice(s.prevClose, spec?.priceDecimals ?? 2) : null);
    add('Volume', s.volume ? formatVolume(s.volume) : null);
  }
  return rows;
}

export function MultiDetail({
  rows,
  watchlist,
  onOpen,
}: {
  rows: readonly MarketRow[];
  watchlist: Watchlist | null;
  onOpen: (how: OpenHow) => void;
}) {
  const symbols = rows.map((r) => r.id);
  return (
    <section className="mk-detail" aria-label={`${String(rows.length)} selected`}>
      <header className="mk-d-head">
        <h2>{rows.length} selected</h2>
        <span className="name">{symbols.map((s) => displaySymbol(s)).join(', ')}</span>
      </header>
      <div className="mk-d-actions">
        <Button size="s" shortcut={OPEN_KEYS.tab} onClick={() => onOpen('tab')}>
          Open in new tabs
        </Button>
        <Button size="s" shortcut={OPEN_KEYS.split} onClick={() => onOpen('split')}>
          Open as splits
        </Button>
        <Button size="s" shortcut={OPEN_KEYS.dom} onClick={() => onOpen('dom')}>
          DOMs
        </Button>
      </div>
      <div className="mk-d-lists">
        <span className="lbl">Watchlists</span>
        <span className="in" />
        <WatchlistButton symbols={symbols} />
      </div>
      {watchlist ? (
        <div className="mk-d-actions">
          <Button
            size="s"
            variant="destructive"
            what={watchlist.name}
            onClick={() => removeFromWatchlist(watchlist.id, symbols)}
          >
            Remove from
          </Button>
        </div>
      ) : null}
    </section>
  );
}
