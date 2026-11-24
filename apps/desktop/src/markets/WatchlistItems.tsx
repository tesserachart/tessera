import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
} from '@tessera/ui';
import { addToWatchlist, newWatchlist, removeFromWatchlist } from './actions.ts';
import { useWatchlists } from './watchlists.ts';

export function WatchlistItems({
  symbols,
  context = false,
  onCreated,
}: {
  symbols: readonly string[];
  context?: boolean;
  onCreated?: (id: string) => void;
}) {
  const lists = useWatchlists((s) => s.value.lists);
  const Check = context ? ContextMenuCheckboxItem : MenuCheckboxItem;
  const Item = context ? ContextMenuItem : MenuItem;
  const Sep = context ? ContextMenuSeparator : MenuSeparator;
  return (
    <>
      {lists.map((l) => {
        const holds = symbols.length > 0 && symbols.every((s) => l.symbols.includes(s));
        return (
          <Check
            key={l.id}
            checked={holds}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => (on ? addToWatchlist(l.id, symbols) : removeFromWatchlist(l.id, symbols))}
          >
            {l.name}
          </Check>
        );
      })}
      {lists.length > 0 ? <Sep /> : null}
      <Item
        icon="plus"
        onSelect={() => {
          const id = newWatchlist(symbols);
          if (id) onCreated?.(id);
        }}
      >
        New watchlist{symbols.length > 0 ? ' with ' + (symbols.length === 1 ? 'it' : 'them') : ''}
      </Item>
    </>
  );
}
