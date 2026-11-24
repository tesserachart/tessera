import {
  Icon,
  Menu,
  MenuContent,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Tooltip,
  type IconName,
} from '@tessera/ui';
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import { createElement, useState, type ReactNode } from 'react';
import { patch } from '../../../app/store.ts';
import { SPLIT_CHART_KEY } from '../../../shell/keys.ts';
import { splitChart } from '../../addChart.ts';
import { contextOf } from '../../controller.ts';
import { tileDefinition, type TileDefinition } from '../../tiles/registry.ts';
import { placeOf } from '../edges.ts';
import { isMaximised, toggleMaximise } from '../maximise.ts';
import { closeTile, panelKind } from '../open.ts';
import { LibraryItems } from '../PanelsLibrary.tsx';
import { popOutTile, requestDockBack } from '../popouts.ts';
import { TabMenuItems } from '../TabMenu.tsx';
import { keepMovedFocus, tabEntries } from '../tabMenu.ts';
import { tileParams, useTileSettingsVersion } from '../tileSettings.ts';
import { tileSettingsUiStore, useTileFacts, useTileSettingsUi } from '../tileSettingsUi.ts';
import type { Fold } from './fit.ts';
import { useFolded } from './folds.ts';

function HeadButton({
  icon,
  label,
  shortcut,
  fold,
  run,
}: {
  icon: IconName;
  label: string;
  shortcut?: string;
  fold: Fold;
  run: () => void;
}) {
  const folded = useFolded(fold);
  return (
    <Tooltip content={label} {...(shortcut ? { shortcut } : {})}>
      <button
        type="button"
        className="dock-act"
        data-fold={fold}
        data-folded={folded || undefined}
        aria-label={label}
        tabIndex={folded ? -1 : undefined}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={run}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}

function SettingsAnchor({ panel, def, children }: { panel: IDockviewPanel; def: TileDefinition; children: ReactNode }) {
  useTileSettingsVersion();
  const open = useTileSettingsUi((s) => s.open === panel.id);
  const note = useTileFacts(panel.id).note ?? null;
  const settings = def.settings;
  if (!settings) return children;
  const words = settings.summary?.(tileParams<Record<string, unknown>>(panel.api)) ?? null;
  const name = words ? `${def.title} settings: ${words}` : `${def.title} settings`;
  return (
    <Popover open={open} onOpenChange={(o) => patch(tileSettingsUiStore, { open: o ? panel.id : null })}>
      <PopoverAnchor asChild>
        <span className="dock-anchor">{children}</span>
      </PopoverAnchor>
      <PopoverContent align="end" className="tile-settings" aria-label={name}>
        {note ? <p className="tile-settings-note">≈ {note}</p> : null}
        {createElement(settings.component, { panel })}
      </PopoverContent>
    </Popover>
  );
}

function MoreMenu({
  containerApi,
  panel,
  group,
  title,
  folded,
}: {
  containerApi: DockviewApi;
  panel: IDockviewPanel;
  group: DockviewGroupPanel;
  title: string;
  folded: ReadonlySet<Fold>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu onOpenChange={setOpen}>
      <Tooltip content="More">
        <MenuTrigger asChild>
          <button
            type="button"
            className="dock-act"
            data-fit-fixed=""
            aria-label={`${title}: more`}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Icon name="more" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" onCloseAutoFocus={keepMovedFocus}>
        {open ? (
          <>
            <TabMenuItems entries={tabEntries(containerApi, panel, 'header', folded)} as="menu" />
            {folded.has('add') && !contextOf(containerApi)?.popout ? (
              <>
                <MenuSeparator />
                <MenuSub>
                  <MenuSubTrigger>Add a panel here</MenuSubTrigger>
                  <MenuSubContent className="dock-library">
                    <LibraryItems into={group} />
                  </MenuSubContent>
                </MenuSub>
              </>
            ) : null}
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

export function HeaderEnd({
  containerApi,
  group,
  panel,
  folded,
}: {
  containerApi: DockviewApi;
  group: DockviewGroupPanel;
  panel: IDockviewPanel;
  folded: ReadonlySet<Fold>;
}) {
  const ctx = contextOf(containerApi);
  const def = tileDefinition(panelKind(panel));
  const title = def?.title ?? 'Panel';
  const away = ctx?.popout === true;
  const ownWindow = away && ctx.windowPanel === panel.id;
  const maximised = !away && isMaximised(panel.id);
  const more = <MoreMenu containerApi={containerApi} panel={panel} group={group} title={title} folded={folded} />;
  return (
    <div className="dock-actions" role="toolbar" aria-label={title}>
      {def?.scope ? createElement(def.scope, { panel }) : null}
      {!away && placeOf(group) === 'centre' ? (
        <HeadButton
          icon="split-chart"
          label="Split chart"
          shortcut={SPLIT_CHART_KEY}
          fold="split"
          run={() => void splitChart(group)}
        />
      ) : null}
      {ownWindow ? (
        <HeadButton icon="dock-back" label="Dock back" fold="popout" run={() => requestDockBack(panel.id)} />
      ) : away ? null : (
        <HeadButton icon="pop-out" label="Pop out" fold="popout" run={() => void popOutTile(panel.id)} />
      )}
      {away ? null : (
        <HeadButton
          icon={maximised ? 'restore' : 'maximise'}
          label={maximised ? 'Restore' : 'Maximise'}
          shortcut="mod+shift+enter"
          fold="maximise"
          run={() => toggleMaximise(panel.id)}
        />
      )}
      {def ? (
        <SettingsAnchor panel={panel} def={def}>
          {more}
        </SettingsAnchor>
      ) : (
        more
      )}
      <HeadButton icon="close" label={`Close ${title}`} fold="close" run={() => void closeTile(panel.id)} />
    </div>
  );
}
