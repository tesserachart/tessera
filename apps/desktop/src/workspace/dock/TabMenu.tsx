import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from '@tessera/ui';
import type { TabEntry } from './tabMenu.ts';

export function TabMenuItems({ entries, as }: { entries: readonly TabEntry[]; as: 'menu' | 'context' }) {
  const Item = as === 'menu' ? MenuItem : ContextMenuItem;
  const Sep = as === 'menu' ? MenuSeparator : ContextMenuSeparator;
  const Sub = as === 'menu' ? MenuSub : ContextMenuSub;
  const SubTrigger = as === 'menu' ? MenuSubTrigger : ContextMenuSubTrigger;
  const SubContent = as === 'menu' ? MenuSubContent : ContextMenuSubContent;
  return (
    <>
      {entries.map((e) => {
        if (e.type === 'sep') return <Sep key={e.id} />;
        if (e.type === 'sub')
          return (
            <Sub key={e.id}>
              <SubTrigger>{e.label}</SubTrigger>
              <SubContent>
                <TabMenuItems entries={e.items} as={as} />
              </SubContent>
            </Sub>
          );
        return (
          <Item
            key={e.id}
            current={e.current}
            disabled={e.disabled}
            destructive={e.destructive}
            {...(e.shortcut ? { shortcut: e.shortcut } : {})}
            {...(e.id.startsWith('link-') && e.id !== 'link-none'
              ? { hint: <i className="dock-link-swatch" data-link={e.id.slice(5)} aria-hidden="true" /> }
              : {})}
            onSelect={e.run}
          >
            {e.label}
          </Item>
        );
      })}
    </>
  );
}
