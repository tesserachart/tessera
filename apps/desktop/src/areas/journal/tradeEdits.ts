import type { JournalCatalog, JournalTrade, UpdateTradeInput } from '@tessera/protocol';
import { useMemo } from 'react';
import { createOverlay, useOverlay } from '../../app/overlay.ts';
import { runTool } from '../../app/tools.ts';

export type TradeChange = Omit<UpdateTradeInput, 'id'>;

const FIELDS = [
  'rating',
  'reviewed',
  'emotion',
  'exitReason',
  'stopPrice',
  'targetPrice',
  'setupId',
  'tagIds',
] as const;
type Field = (typeof FIELDS)[number];

const edits = createOverlay();
const key = (id: string, f: Field) => `${id}/${f}`;

function read(t: JournalTrade, f: Field): unknown {
  return f === 'tagIds' ? t.tags.map((x) => x.id) : t[f];
}

export async function updateTrade(id: string, change: TradeChange): Promise<void> {
  const shown = FIELDS.filter((f) => change[f] !== undefined);
  const others = Object.fromEntries(Object.entries(change).filter(([f]) => !shown.includes(f as Field)));
  const send = () => runTool('journal.update_trade', { id, ...change }, { refresh: ['journal.*'] });
  if (shown.length === 0) {
    await send();
    return;
  }
  let sent: Promise<unknown> | null = null;
  const once = () => (sent ??= send());
  await Promise.all(shown.map((f) => edits.write(key(id, f), change[f], once)));
  if (Object.keys(others).length > 0) await once();
}

function overlaid(
  t: JournalTrade,
  shown: Readonly<Record<string, unknown>>,
  catalog: JournalCatalog | null,
): JournalTrade {
  let out = t;
  for (const f of FIELDS) {
    const k = key(t.id, f);
    if (!(k in shown)) continue;
    const v = shown[k];
    if (f === 'tagIds') {
      const ids = v as string[];
      const known = new Map([...t.tags, ...(catalog?.tags ?? [])].map((x) => [x.id, x]));
      out = { ...out, tags: ids.flatMap((id) => (known.has(id) ? [known.get(id)!] : [])) };
    } else if (f === 'setupId') {
      const id = v as string | null;
      out = {
        ...out,
        setupId: id,
        setupName: catalog?.setups.find((s) => s.id === id)?.name ?? (id ? out.setupName : null),
      };
    } else out = { ...out, [f]: v };
  }
  return out;
}

export function useTradesShown<T extends JournalTrade | null | undefined>(
  trades: readonly T[],
  catalog: JournalCatalog | null,
): T[] {
  const reads = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const t of trades) if (t) for (const f of FIELDS) out[key(t.id, f)] = read(t, f);
    return out;
  }, [trades]);
  const shown = useOverlay(edits, reads);
  return useMemo(() => trades.map((t) => (t ? (overlaid(t, shown, catalog) as T) : t)), [trades, shown, catalog]);
}
