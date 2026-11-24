import { Button, cx, formatMoney } from '@tessera/ui';
import type { IDockviewPanelProps } from 'dockview-react';
import { useHasTool, valueOf } from '../../app/tools.ts';
import { showArea } from '../../areas/store.ts';
import { useJournalLive, useToday, useTrades } from '../../areas/journal/data.ts';
import { clock, pct, plural, rLabel, sideWord } from '../../areas/journal/model/format.ts';
import { Spark } from '../../areas/journal/parts/Charts.tsx';
import { openDay, openTrade } from '../../areas/journal/store.ts';
import { registerTile } from './registry.ts';
import '../../areas/journal/journal.css';

export function JournalTile(_props: IDockviewPanelProps) {
  useJournalLive();
  const has = useHasTool('journal.list_trades');
  const today = useToday();
  const q = valueOf(useTrades({ from: today, to: today }, 'opened', false, 200));
  const trades = q?.trades ?? [];
  const s = q?.summary;
  const go = (id: string) => {
    openTrade(id);
    showArea('journal');
  };
  if (!has) return <div className="jr-empty">This runtime has no journal.</div>;
  return (
    <div className="jr-tile">
      <div className="jr-tile-head">
        <span className={cx('jr-figure s', s && s.net > 0 ? 'up' : s && s.net < 0 ? 'down' : null)}>
          {s ? formatMoney(s.net, { signed: true }) : '—'}
        </span>
        <Spark
          values={[...trades]
            .reverse()
            .filter((t) => t.status === 'closed')
            .map((t) => t.netPnl)}
          width={72}
          height={22}
        />
        <span className="text-t3 jr-tile-sub">
          {s?.n
            ? `${plural(s.n, 'trade')} · ${pct(s.winRate, 0)} won${s.nR ? ` · ${rLabel(s.totalR)}` : ''}`
            : 'No trades yet today'}
        </span>
        <Button
          size="s"
          variant="quiet"
          className="jr-tile-open"
          onClick={() => {
            openDay(today);
            showArea('journal');
          }}
        >
          Today’s page
        </Button>
      </div>
      <ol className="jr-mini-trades jr-tile-list">
        {trades.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => go(t.id)}>
              <span className="text-t3">{clock(t.openedAt)}</span>
              <b>{t.symbol}</b>
              <span className={t.side === 'buy' ? 'up' : 'down'}>{sideWord(t.side)}</span>
              <span className="text-t3">{t.status === 'open' ? 'Open' : (t.setupName ?? '')}</span>
              <span className={cx('r', t.netPnl > 0 ? 'up' : t.netPnl < 0 ? 'down' : null)}>
                {formatMoney(t.netPnl, { signed: true })}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

registerTile({
  kind: 'journal',
  private: true,
  title: 'Journal',
  component: JournalTile,
  icon: 'journal',
  home: 'centre',
  singleton: true,
  order: 2,
});
