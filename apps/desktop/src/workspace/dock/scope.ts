import type { IDockviewPanel } from 'dockview-react';
import { displaySymbol } from '../../market/instruments.ts';
import { setSyncInterval } from '../controller.ts';
import { LINK_GROUPS, type LinkGroup } from './links.ts';
import { linkOf, setLink } from './tabMenu.ts';
import { setTileParams, tileParams } from './tileSettings.ts';

interface ScopeChoice {
  id: string;
  label: string;
  link?: LinkGroup;
  current: boolean;
  run: () => void;
}

export interface ScopeModel {
  label: string;
  tip: string;
  link: LinkGroup | null;
  choices: readonly ScopeChoice[];
  extra?: readonly ScopeChoice[];
}

const linkChoices = (panel: IDockviewPanel, link: LinkGroup | null): ScopeChoice[] =>
  LINK_GROUPS.map((g) => ({
    id: `link-${g}`,
    label: `Link ${g}`,
    link: g,
    current: link === g,
    run: () => setLink(panel, g),
  }));

export function flowScope(panel: IDockviewPanel): ScopeModel {
  const p = tileParams<{ link: string; instrument: string }>(panel.api);
  const link = linkOf(panel);
  const pinned = typeof p.instrument === 'string' && p.instrument !== '' ? p.instrument : null;
  const follow = () =>
    setTileParams<{ link: string | undefined; instrument: string | undefined }>(panel.api, {
      link: undefined,
      instrument: undefined,
    });
  const choices: ScopeChoice[] = [
    { id: 'active', label: 'Active chart', current: !pinned && !link, run: follow },
    ...linkChoices(panel, pinned ? null : link),
    ...(pinned
      ? [{ id: 'pinned', label: `Pinned to ${displaySymbol(pinned)}`, current: true, run: () => undefined }]
      : []),
  ];
  if (pinned) return { label: 'Pinned', tip: `Pinned to ${displaySymbol(pinned)}`, link: null, choices };
  if (link) return { label: `Link ${link}`, tip: `Follows the charts of link ${link}`, link, choices };
  return { label: 'Active chart', tip: 'Follows the active chart', link: null, choices };
}

export function chartScope(panel: IDockviewPanel, shareInterval: boolean): ScopeModel {
  const link = linkOf(panel);
  return {
    label: link ? `Link ${link}` : 'Unlinked',
    tip: link ? `Linked charts ${link}: a symbol change moves them all` : 'Not linked to other charts',
    link,
    choices: [
      ...linkChoices(panel, link),
      { id: 'link-none', label: 'Not linked', current: link === null, run: () => setLink(panel, null) },
    ],
    extra: [
      {
        id: 'share-interval',
        label: 'Share interval',
        current: shareInterval,
        run: () => void setSyncInterval(!shareInterval),
      },
    ],
  };
}
