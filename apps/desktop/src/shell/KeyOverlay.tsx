import { Key, Tooltip, cx, modifierLabel, usePlatform, type Platform } from '@tessera/ui';
import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { read, useStore } from '../app/store.ts';
import type { HeldModifier, ModifierRow } from '../commands/modifierMap.ts';
import { commands } from '../commands/registry.ts';
import { uiStore } from '../state/ui.ts';
import {
  anchorOf,
  canSummonFrom,
  closeKeyOverlay,
  hoverOverlay,
  keyOverlayStore,
  modifierGesture,
  openKeyOverlay,
  overlayView,
  runOverlayRow,
  type Anchor,
} from './keyOverlay.ts';

const WIDTH = 520;
const GUTTER = 16;

function placement(anchor: Anchor | null): CSSProperties {
  const vw = window.innerWidth;
  const width = Math.min(WIDTH, vw - 2 * GUTTER);
  const box = anchor ?? { left: 0, top: 0, width: vw };
  const left = Math.min(Math.max(box.left + (box.width - width) / 2, GUTTER), vw - width - GUTTER);
  const top = Math.max(box.top + 8, 8);
  return { left, top, width, maxHeight: `calc(100vh - ${String(top + GUTTER)}px)` };
}

function desk(): Element | null {
  return document.querySelector('.t-shell-body');
}

function useModifierGesture(platform: Platform, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const gesture = modifierGesture({
      canArm: (target) => canSummonFrom(target, read(uiStore).paletteOpen),
      open: (held: HeldModifier, pinned: boolean) => {
        const { zone, el } = anchorOf(document.activeElement);
        const box = (el ?? desk())?.getBoundingClientRect();
        const anchor = box ? { left: box.left, top: box.top, width: box.width } : null;
        return openKeyOverlay(held, pinned, { platform, zone, anchor });
      },
      inside: (target) => target !== null && (root.current?.contains(target) ?? false),
    });
    window.addEventListener('keydown', gesture.keydown, true);
    window.addEventListener('keyup', gesture.keyup, true);
    window.addEventListener('pointerdown', gesture.pointerdown, true);
    window.addEventListener('blur', gesture.blur);
    return () => {
      window.removeEventListener('keydown', gesture.keydown, true);
      window.removeEventListener('keyup', gesture.keyup, true);
      window.removeEventListener('pointerdown', gesture.pointerdown, true);
      window.removeEventListener('blur', gesture.blur);
      gesture.dispose();
      closeKeyOverlay();
    };
  }, [platform, root]);
}

export function KeyOverlay() {
  const platform = usePlatform();
  const root = useRef<HTMLDivElement>(null);
  useModifierGesture(platform, root);
  const state = useStore(keyOverlayStore);
  useSyncExternalStore(commands.subscribe, commands.getVersion);
  const { held } = state;
  if (!held) return null;
  const view = overlayView(state);
  const glyph = modifierLabel(held, platform);
  const active = view.rows[state.active] ?? null;
  const row = (r: ModifierRow, index: number, desc: string | null) => (
    <OverlayRow key={`${r.id}:${r.shortcut}`} row={r} index={index} active={index === state.active} desc={desc} />
  );
  let at = 0;
  return (
    <div
      ref={root}
      className="t-keyoverlay"
      role="dialog"
      aria-modal="false"
      aria-label={`${glyph} keys`}
      style={placement(state.anchor)}
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="ko-line">
        <kbd className="t-key ko-mod">{glyph}</kbd>
        <span className={cx('ko-query', !state.query && 'is-empty')} aria-live="polite">
          {state.query || 'Type a key or a name'}
        </span>
        {active ? (
          <span className="ko-enter">
            <Key shortcut="enter" className="text-inherit in-[.show-keys]:text-inherit" /> run
          </span>
        ) : null}
      </div>
      <div className="ko-list" role="listbox" aria-label={`${glyph} actions`}>
        {view.searching ? (
          view.rows.length > 0 ? (
            view.rows.map((r, i) => row(r, i, r.why ?? r.group))
          ) : (
            <div className="ko-empty">
              No {glyph} action matches “{state.query}”
            </div>
          )
        ) : (
          view.groups.map((g) => (
            <div key={g.group} role="group" aria-label={g.group}>
              <div className="ko-head" aria-hidden="true">
                {g.group}
              </div>
              {g.rows.map((r) => row(r, at++, r.why))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OverlayRow({
  row,
  index,
  active,
  desc,
}: {
  row: ModifierRow;
  index: number;
  active: boolean;
  desc: string | null;
}) {
  const el = (
    <div
      role="option"
      aria-selected={active}
      aria-disabled={!row.enabled}
      className={cx('ko-row', !row.enabled && 'is-off')}
      onPointerMove={() => {
        if (row.enabled && !active) hoverOverlay(index);
      }}
      onClick={() => runOverlayRow(row)}
    >
      <span className="name">{row.title}</span>
      <span className="desc">{desc}</span>
      <Key shortcut={row.shortcut} className="kind" />
    </div>
  );
  return row.why ? (
    <Tooltip content={row.why} side="right">
      {el}
    </Tooltip>
  ) : (
    el
  );
}
