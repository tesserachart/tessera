import { Button, Check, Loaded, Tooltip } from '@tessera/ui';
import type { ReactNode } from 'react';
import {
  NOTHING_PICKED,
  NO_MARKETS,
  OFFER_LABEL,
  isOpen,
  marketName,
  rowWords,
  totalWords,
  type OfferRow,
  type RowWords,
} from './history.ts';
import { useHistoryOffer } from './useHistory.ts';

interface MarketCheckProps {
  name: string;
  words: RowWords;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}

function MarketCheck({ name, words, checked, disabled, onChange }: MarketCheckProps) {
  return (
    <Check className="hm-row" checked={checked} disabled={disabled} onChange={onChange}>
      <span className="nm">{name}</span>
      <span className="est">
        {words.days} ·{' '}
        {words.why ? (
          <Tooltip content={words.why} side="top">
            <span>{words.size}</span>
          </Tooltip>
        ) : (
          words.size
        )}
      </span>
    </Check>
  );
}

function Row({ row, checked, onChange }: { row: OfferRow; checked: boolean; onChange: () => void }) {
  return (
    <MarketCheck
      name={marketName(row.estimate)}
      words={rowWords(row)}
      checked={checked}
      disabled={!isOpen(row)}
      onChange={onChange}
    />
  );
}

const SAMPLE_MARKETS: readonly { name: string; words: RowWords }[] = [
  { name: 'NQ Z6', words: { days: '30 days', size: 'about 1.4 GB', why: null } },
  { name: 'ES Z6', words: { days: '30 days', size: 'about 1.1 GB', why: null } },
  { name: 'CL F7', words: { days: '30 days', size: 'about 640 MB', why: null } },
];

function MarketsSample() {
  return (
    <>
      <div className="hm-list">
        {SAMPLE_MARKETS.map((m) => (
          <MarketCheck key={m.name} name={m.name} words={m.words} checked disabled={false} onChange={() => undefined} />
        ))}
      </div>
      <p className="hm-total">About 3.1 GB and 12 minutes. It runs in the background while you chart.</p>
    </>
  );
}

export function HistoryMarkets({ secondary, onStarted }: { secondary?: ReactNode; onStarted?: () => void }) {
  const offer = useHistoryOffer();
  const total = totalWords(offer.rows, offer.checked);
  const nothing = offer.checked.size === 0;
  const go = (
    <Button
      size="s"
      variant="primary"
      disabled={!offer.ready || nothing || offer.starting}
      onClick={() => void offer.start().then((ok) => ok && onStarted?.())}
    >
      {offer.starting ? 'Starting…' : 'Download'}
    </Button>
  );
  return (
    <div className="hm">
      <Loaded label="Loading history markets" pending={!offer.ready} alone sample={<MarketsSample />}>
        {offer.rows.length === 0 ? (
          <p className="hm-none">{NO_MARKETS}</p>
        ) : (
          <div className="hm-list" role="group" aria-label={OFFER_LABEL}>
            {offer.rows.map((row) => (
              <Row
                key={row.input}
                row={row}
                checked={offer.checked.has(row.input)}
                onChange={() => offer.toggle(row.input)}
              />
            ))}
          </div>
        )}
        {total ? (
          <p className="hm-total" role="status">
            {total.lead}
            {total.hint && total.why ? (
              <Tooltip content={total.why} side="top">
                <span className="hint">{total.hint}</span>
              </Tooltip>
            ) : null}
          </p>
        ) : null}
      </Loaded>
      <div className="cn-acts hm-acts">
        <span className="cn-outcome cn-no" role={offer.failed ? 'alert' : undefined}>
          {offer.failed}
        </span>
        {secondary}
        {offer.ready && nothing ? (
          <Tooltip content={NOTHING_PICKED} side="top">
            <span className="hm-go">{go}</span>
          </Tooltip>
        ) : (
          go
        )}
      </div>
    </div>
  );
}
