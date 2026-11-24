import { Count, formatShortcut, RailItem, Tooltip, usePlatform } from '@tessera/ui';
import type { DragEvent, ReactNode } from 'react';
import { useAnalystAway, type AnalystAway } from '../analyst/away.ts';
import { AppMenu } from '../frame/AppMenu.tsx';
import { SETTINGS_KEY, STOP_KEY } from '../shell/keys.ts';
import { useWindowChrome } from '../shell/titleBar.ts';
import { tileDefinition } from '../workspace/tiles/registry.ts';
import { RAIL_TILE_TYPE, beginRailDrag, endRailDrag } from './railDrag.ts';
import { ProfileEntry } from './ProfileEntry.tsx';
import { FeedbackEntry } from '../feedback/FeedbackEntry.tsx';
import { UpdateEntry } from './UpdateEntry.tsx';
import { AREAS, type AreaDef } from './registry.ts';
import { showArea, useArea, areaStore } from './store.ts';
import { read } from '../app/store.ts';

/** HTML5 takes a picture of the ghost as the drag starts; it leaves the page on the next frame. */
function dragGhost(from: HTMLElement, title: string): HTMLElement {
  const doc = from.ownerDocument;
  const ghost = doc.createElement('div');
  ghost.className = 'ar-ghost';
  const icon = from.querySelector('svg')?.cloneNode(true);
  if (icon) ghost.appendChild(icon);
  ghost.appendChild(doc.createTextNode(title));
  doc.body.appendChild(ghost);
  requestAnimationFrame(() => ghost.remove());
  return ghost;
}

function dragProps(a: AreaDef) {
  const kind = a.tile;
  if (!kind) return {};
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLButtonElement>) => {
      const def = tileDefinition(kind);
      if (!def) {
        e.preventDefault();
        return;
      }
      const from = read(areaStore).area;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(RAIL_TILE_TYPE, def.kind);
      e.dataTransfer.setData('text/plain', def.title);
      e.dataTransfer.setDragImage(dragGhost(e.currentTarget, def.title), 16, 16);
      beginRailDrag(def.kind, from);
      if (from !== 'desk') setTimeout(() => showArea('desk'), 0);
    },
    onDragEnd: () => {
      const d = endRailDrag();
      if (d && !d.dropped && d.from !== 'desk') showArea(d.from);
    },
  };
}

function awayBadge(away: AnalystAway | null): ReactNode {
  if (!away) return null;
  if (away.count > 0)
    return (
      <Count n={away.count} label={away.words} className="min-w-[13px] h-[13px] px-0.5 text-[10px] leading-none" />
    );
  return away.unread ? <i className="an-unread" aria-hidden="true" /> : null;
}

export function AreaRail() {
  const area = useArea((s) => s.area);
  const chrome = useWindowChrome();
  const platform = usePlatform();
  const away = useAnalystAway();
  const item = (a: AreaDef) => {
    const agents = a.id === 'agents' && away !== null;
    const tip = agents
      ? `${a.label} · ${away.words}${away.working ? ` · ${formatShortcut(STOP_KEY, platform)} stops it` : ''}`
      : a.label;
    return (
      <Tooltip key={a.id} content={tip} shortcut={a.id === 'settings' ? SETTINGS_KEY : a.shortcut} side="right">
        <RailItem
          icon={a.icon}
          label={a.label}
          current={area === a.id}
          data-area={a.id}
          data-working={agents && away.working ? '' : undefined}
          badge={a.id === 'agents' ? awayBadge(away) : null}
          onClick={() => showArea(a.id)}
          {...dragProps(a)}
        />
      </Tooltip>
    );
  };
  return (
    <div className="ar-rail">
      <div className="ar-rail-head" data-tauri-drag-region>
        {chrome === 'mac' ? null : <AppMenu />}
      </div>
      {chrome === 'mac' ? (
        <div className="ar-rail-brand">
          <AppMenu />
        </div>
      ) : null}
      <nav className="ar-rail-nav" aria-label="Areas">
        <div className="ar-rail-top">{AREAS.filter((a) => !a.foot).map(item)}</div>
        <div className="ar-rail-foot">
          <UpdateEntry />
          <FeedbackEntry />
          {AREAS.filter((a) => a.foot).map((a) => (a.id === 'profile' ? <ProfileEntry key={a.id} /> : item(a)))}
        </div>
      </nav>
    </div>
  );
}
