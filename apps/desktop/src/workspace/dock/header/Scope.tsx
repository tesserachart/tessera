import { Icon, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip } from '@tessera/ui';
import type { IDockviewPanel } from 'dockview-react';
import { useSyncExternalStore } from 'react';
import { DEFAULT_VIEW, useLayouts } from '../../../state/layouts.ts';
import { workspaceContext } from '../../controller.ts';
import { dockRevision, subscribeDock } from '../edges.ts';
import { showLinkColours } from '../links.ts';
import { panelKind } from '../open.ts';
import { chartScope, flowScope, type ScopeModel } from '../scope.ts';
import { keepMovedFocus } from '../tabMenu.ts';
import { tileParams, useTileSettingsVersion } from '../tileSettings.ts';
import { useFolded } from './folds.ts';

export function ScopeChip({ model }: { model: ScopeModel }) {
  const wordsFolded = useFolded('scope');
  return (
    <Menu>
      <Tooltip content={model.tip}>
        <MenuTrigger asChild>
          <button
            type="button"
            className="dock-scope"
            aria-label={model.tip}
            data-link={model.link ?? undefined}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {model.link ? <i className="dock-link-swatch" data-link={model.link} aria-hidden="true" /> : null}
            <span className="tt" data-fold="scope" data-folded={wordsFolded || undefined}>
              {model.label}
            </span>
            <Icon name="chevron-down" className="chev" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" onCloseAutoFocus={keepMovedFocus}>
        {model.choices.map((c) => (
          <MenuItem
            key={c.id}
            current={c.current}
            {...(c.link ? { hint: <i className="dock-link-swatch" data-link={c.link} aria-hidden="true" /> } : {})}
            onSelect={c.run}
          >
            {c.label}
          </MenuItem>
        ))}
        {model.extra && model.extra.length > 0 ? (
          <>
            <MenuSeparator />
            {model.extra.map((c) => (
              <MenuItem key={c.id} current={c.current} onSelect={c.run}>
                {c.label}
              </MenuItem>
            ))}
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

function useDockRevision(): void {
  useSyncExternalStore(subscribeDock, dockRevision);
}

export function FlowScope({ panel }: { panel: IDockviewPanel }) {
  useTileSettingsVersion();
  useDockRevision();
  return <ScopeChip model={flowScope(panel)} />;
}

export function ChartScope({ panel }: { panel: IDockviewPanel }) {
  useTileSettingsVersion();
  useDockRevision();
  const layoutId = workspaceContext()?.layoutId ?? '';
  const links = useLayouts((s) =>
    Object.values(s.layouts[layoutId]?.charts ?? {})
      .map((c) => c.linkGroup ?? '')
      .join(','),
  );
  const share = useLayouts((s) => (s.views[layoutId] ?? DEFAULT_VIEW).syncInterval);
  const api = workspaceContext()?.api;
  const others = (api?.panels ?? [])
    .filter((p) => panelKind(p) !== 'chart')
    .map((p) => tileParams<{ link: string }>(p.api).link);
  if (!showLinkColours([...links.split(','), ...others])) return null;
  return <ScopeChip model={chartScope(panel, share)} />;
}
