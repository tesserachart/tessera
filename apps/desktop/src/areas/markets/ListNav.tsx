import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Icon,
  ScrollArea,
  Tooltip,
  cx,
} from '@tessera/ui';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { newWatchlist } from '../../markets/actions.ts';
import {
  addSymbols,
  deleteList,
  editWatchlists,
  moveList,
  nameProblem,
  renameList,
  useWatchlists,
  type Watchlist,
  watchlistsStore,
} from '../../markets/watchlists.ts';
import { LIST_WORD, type MarketsList } from './model.ts';
import { setMarketsPlace, marketsUiStore } from './store.ts';
import { read } from '../../app/store.ts';

export function ListNav({
  list,
  watchlist,
  listed,
  recent,
  positions,
  renaming,
  onRenaming,
}: {
  list: MarketsList;
  watchlist: string | null;
  listed: number;
  recent: number;
  positions: number | null;
  renaming: string | null;
  onRenaming: (id: string | null) => void;
}) {
  const lists = useWatchlists((s) => s.value.lists);
  const show = (l: MarketsList, w: string | null = null) =>
    setMarketsPlace({ list: l, watchlist: w, sort: l === list ? read(marketsUiStore).sort : null });
  const item = (l: Exclude<MarketsList, 'watchlist'>, n: number | null) => (
    <button
      key={l}
      type="button"
      className={cx('mk-nav-row', list === l && 'is-on')}
      aria-current={list === l ? 'true' : undefined}
      onClick={() => show(l)}
    >
      <span className="ttl">{LIST_WORD[l]}</span>
      {n !== null ? <span className="n">{n}</span> : null}
    </button>
  );
  return (
    <nav className="mk-nav" aria-label="Lists">
      <ScrollArea className="mk-nav-scroll">
        <div className="mk-nav-group">{item('all', listed)}</div>
        <div className="mk-nav-group">
          <div className="mk-nav-label">
            <span>Watchlists</span>
            <Tooltip content="New watchlist">
              <button
                type="button"
                className="mk-nav-add"
                aria-label="New watchlist"
                onClick={() => {
                  const id = newWatchlist();
                  if (!id) return;
                  show('watchlist', id);
                  onRenaming(id);
                }}
              >
                <Icon name="plus" />
              </button>
            </Tooltip>
          </div>
          {lists.map((l, i) => (
            <WatchlistRow
              key={l.id}
              list={l}
              index={i}
              count={lists.length}
              on={list === 'watchlist' && watchlist === l.id}
              renaming={renaming === l.id}
              onShow={() => show('watchlist', l.id)}
              onRenaming={onRenaming}
            />
          ))}
          {lists.length === 0 ? <p className="mk-nav-none">No watchlists</p> : null}
        </div>
        <div className="mk-nav-group">
          {item('recent', recent)}
          {item('positions', positions)}
        </div>
      </ScrollArea>
    </nav>
  );
}

const LIST_DRAG = 'text/x-tessera-watchlist';

function WatchlistRow({
  list,
  index,
  count,
  on,
  renaming,
  onShow,
  onRenaming,
}: {
  list: Watchlist;
  index: number;
  count: number;
  on: boolean;
  renaming: boolean;
  onShow: () => void;
  onRenaming: (id: string | null) => void;
}) {
  const [over, setOver] = useState<'above' | 'below' | null>(null);
  const remove = () => {
    editWatchlists((w) => deleteList(w, list.id));
    if (on) {
      const next = read(watchlistsStore).value.lists[0];
      setMarketsPlace(next ? { watchlist: next.id } : { list: 'all', watchlist: null });
    }
  };
  if (renaming) return <RenameField list={list} onDone={() => onRenaming(null)} />;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={cx('mk-nav-row', on && 'is-on', over && `drop-${over}`)}
          aria-current={on ? 'true' : undefined}
          draggable
          onClick={onShow}
          onDoubleClick={() => onRenaming(list.id)}
          onDragStart={(e) => {
            e.dataTransfer.setData(LIST_DRAG, list.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e: DragEvent) => {
            const types = e.dataTransfer.types;
            if (!types.includes(LIST_DRAG) && !types.includes('text/x-tessera-symbol')) return;
            e.preventDefault();
            if (!types.includes(LIST_DRAG)) return setOver(null);
            const r = e.currentTarget.getBoundingClientRect();
            setOver(e.clientY < r.top + r.height / 2 ? 'above' : 'below');
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            setOver(null);
            const id = e.dataTransfer.getData(LIST_DRAG);
            const symbol = e.dataTransfer.getData('text/x-tessera-symbol');
            e.preventDefault();
            if (id) {
              const from = read(watchlistsStore).value.lists.findIndex((l) => l.id === id);
              const at = over === 'below' ? index + 1 : index;
              editWatchlists((w) => moveList(w, id, from >= 0 && at > from ? at - 1 : at));
            } else if (symbol) {
              editWatchlists((w) => addSymbols(w, list.id, [symbol]));
            }
          }}
        >
          <span className="ttl">{list.name}</span>
          <span className="n">{list.symbols.length}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent style={{ width: 200 }}>
        <ContextMenuItem onSelect={() => onRenaming(list.id)}>Rename</ContextMenuItem>
        <ContextMenuItem disabled={index === 0} onSelect={() => editWatchlists((w) => moveList(w, list.id, index - 1))}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem
          disabled={index === count - 1}
          onSelect={() => editWatchlists((w) => moveList(w, list.id, index + 1))}
        >
          Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={remove}>
          Delete {list.name}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameField({ list, onDone }: { list: Watchlist; onDone: () => void }) {
  const [name, setName] = useState(list.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const problem = name.trim() === list.name ? null : nameProblem(read(watchlistsStore).value, name, list.id);
  const done = (keep: boolean) => {
    if (keep && !problem && name.trim() !== list.name) editWatchlists((w) => renameList(w, list.id, name));
    onDone();
  };
  return (
    <label className={cx('mk-nav-row', 'is-editing', problem && 'is-bad')} title={problem ?? undefined}>
      <input
        ref={input}
        aria-label={`Rename ${list.name}`}
        aria-invalid={problem ? true : undefined}
        value={name}
        maxLength={40}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            done(false);
          }
        }}
      />
    </label>
  );
}
