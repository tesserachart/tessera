import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from '@tessera/ui';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { NEW_TAB_KEY } from '../../shell/keys.ts';
import { useStageView } from '../../state/layouts.ts';
import { workspaceContext } from '../controller.ts';
import { dockRevision, subscribeDock } from './edges.ts';
import { chooseFromLibrary, deskRows, whereWords, type LibraryTarget } from './library.ts';
import { keepMovedFocus } from './tabMenu.ts';

export function LibraryItems({ into }: { into: LibraryTarget }) {
  useSyncExternalStore(subscribeDock, dockRevision);
  useStageView(workspaceContext()?.layoutId ?? null);
  return deskRows().map((row) => {
    const where = whereWords(row);
    return (
      <MenuItem
        key={row.def.kind}
        icon={row.def.icon}
        hint={where ?? undefined}
        {...(row.def.kind === 'chart'
          ? { shortcut: NEW_TAB_KEY }
          : row.def.shortcut
            ? { shortcut: row.def.shortcut }
            : {})}
        onSelect={() => chooseFromLibrary(row.def.kind, into)}
      >
        {row.def.title}
      </MenuItem>
    );
  });
}

export function LibraryMenu({
  into,
  label,
  tip,
  trigger,
  align = 'start',
}: {
  into: LibraryTarget;
  label: string;
  tip?: string;
  trigger: ReactNode;
  align?: 'start' | 'end' | 'center';
}) {
  const [open, setOpen] = useState(false);
  const button = <MenuTrigger asChild>{trigger}</MenuTrigger>;
  return (
    <Menu onOpenChange={setOpen}>
      {tip ? <Tooltip content={tip}>{button}</Tooltip> : button}
      <MenuContent align={align} className="dock-library" style={{ width: 248 }} onCloseAutoFocus={keepMovedFocus}>
        <MenuLabel>{label}</MenuLabel>
        {open ? <LibraryItems into={into} /> : null}
      </MenuContent>
    </Menu>
  );
}
