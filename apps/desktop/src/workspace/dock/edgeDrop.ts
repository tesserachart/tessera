import type { DockviewApi } from 'dockview-react';
import { markRailDropped, railDragKind } from '../../areas/railDrag.ts';
import type { EdgePos } from './edges.ts';
import { moveTile } from './open.ts';
import { placeTile } from './railDrop.ts';

/** dockview cancels its own drop when its overlay is refused. */

const ROOT_BAND = 24;
const EDGE_BAND = 12;

export const DND_EDGES = {
  size: { type: 'pixels' as const, value: ROOT_BAND },
  activationSize: { type: 'pixels' as const, value: ROOT_BAND },
};

export function edgeBandAt(
  rect: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
  side?: string,
  band = EDGE_BAND,
): EdgePos | null {
  if (x < rect.left - band || x > rect.right + band || y < rect.top - band || y > rect.bottom + band) return null;
  const at: EdgePos | null =
    x - rect.left <= band ? 'left' : rect.right - x <= band ? 'right' : rect.bottom - y <= band ? 'bottom' : null;
  if (!at || (side !== undefined && side !== at)) return null;
  return at;
}

export function installEdgeDrop(api: DockviewApi, centre: HTMLElement): () => void {
  const shell = centre.parentElement ?? centre;
  const band = centre.ownerDocument.createElement('div');
  band.className = 'dock-edge-band';
  band.setAttribute('aria-hidden', 'true');
  shell.appendChild(band);
  let armed: { pos: EdgePos; panelId: string | null; groupId: string; rail: string | null } | null = null;

  const hide = () => {
    armed = null;
    band.removeAttribute('data-pos');
  };
  const show = (pos: EdgePos) => {
    const r = centre.getBoundingClientRect();
    const s = shell.getBoundingClientRect();
    const st = band.style;
    st.left = `${String(pos === 'right' ? r.right - s.left - ROOT_BAND : r.left - s.left)}px`;
    st.top = `${String(pos === 'bottom' ? r.bottom - s.top - ROOT_BAND : r.top - s.top)}px`;
    st.width = `${String(pos === 'bottom' ? r.width : ROOT_BAND)}px`;
    st.height = `${String(pos === 'bottom' ? ROOT_BAND : r.height)}px`;
    band.dataset.pos = pos;
  };

  const overlay = api.onWillShowOverlay((ev) => {
    const n = ev.nativeEvent;
    const pos = edgeBandAt(centre.getBoundingClientRect(), n.clientX, n.clientY);
    const data = ev.getData();
    const rail = data ? null : railDragKind();
    if (!pos || (!data && !rail)) {
      hide();
      return;
    }
    ev.preventDefault();
    armed = { pos, panelId: data?.panelId ?? null, groupId: data?.groupId ?? '', rail };
    show(pos);
  });

  const commit = (e: Event) => {
    const a = armed;
    // Esc ends an HTML drag with a dragend and no drop
    if (a?.rail && e.type !== 'drop') {
      hide();
      return;
    }
    hide();
    if (!a) return;
    if (a.rail) {
      markRailDropped();
      placeTile(api, a.rail, { edge: a.pos });
      return;
    }
    const ids = a.panelId ? [a.panelId] : (api.getGroup(a.groupId)?.panels.map((p) => p.id) ?? []);
    for (const id of ids) moveTile(id, a.pos, 'pointer');
  };
  const doc = centre.ownerDocument;
  const leave = (e: DragEvent) => {
    // Chromium sends dragleave with no related target all along a drag, so the pointer's place says it left the window
    const w = doc.defaultView;
    if (!w) return;
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= w.innerWidth || e.clientY >= w.innerHeight) hide();
  };
  doc.addEventListener('dragend', commit, true);
  doc.addEventListener('drop', commit, true);
  doc.addEventListener('pointerup', commit, true);
  doc.addEventListener('dragleave', leave, true);
  return () => {
    overlay.dispose();
    doc.removeEventListener('dragend', commit, true);
    doc.removeEventListener('drop', commit, true);
    doc.removeEventListener('pointerup', commit, true);
    doc.removeEventListener('dragleave', leave, true);
    band.remove();
  };
}
