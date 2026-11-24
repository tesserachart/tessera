import 'dockview-react/dist/styles/dockview.css';
import '../styles/app.css';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { useEffect, useRef } from 'react';
import { currentTheme } from '../theme/store.ts';
import { putOnDesk } from '../workspace/deskPlace.ts';
import { tesseraDockTheme } from '../workspace/dockTheme.ts';

declare global {
  interface Window {
    __dock?: DockviewApi;
    __mounts?: Record<string, number>;
    __unmounts?: Record<string, number>;
  }
}

function KitChart({ api }: IDockviewPanelProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const m = (window.__mounts ??= {});
    m[api.id] = (m[api.id] ?? 0) + 1;
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (c && ctx) {
      ctx.fillStyle = currentTheme().vars['--color-aqua'];
      ctx.fillRect(10, 10, 40, 40);
    }
    return () => {
      const u = (window.__unmounts ??= {});
      u[api.id] = (u[api.id] ?? 0) + 1;
    };
  }, [api.id]);
  return (
    <div style={{ height: '100%', background: 'var(--ground)' }}>
      <canvas ref={ref} width={200} height={100} data-chart={api.id} />
    </div>
  );
}

function KitList({ api }: IDockviewPanelProps) {
  return (
    <div style={{ padding: 12, color: 'var(--t2)', height: '100%', background: 'var(--ground)' }}>{api.title}</div>
  );
}

function KitTab({ api }: IDockviewPanelHeaderProps) {
  const collapsed = api.group.api.isCollapsed();
  return (
    <div className="kit-dock-tab" data-collapsed={collapsed || undefined} title={api.title ?? ''}>
      {collapsed ? (api.title ?? '?').slice(0, 1) : api.title}
    </div>
  );
}

const components = { chart: KitChart, list: KitList };

export function DockKit() {
  const onReady = (e: DockviewReadyEvent) => {
    const api = e.api;
    window.__dock = api;
    const log = ((window as unknown as { __ev: unknown[] }).__ev = [] as unknown[]);
    api.onWillShowOverlay((ev) => {
      const n = ev.nativeEvent;
      log.push({
        t: 'overlay',
        kind: ev.kind,
        pos: ev.position,
        edge: ev.edge,
        x: n.clientX,
        y: n.clientY,
        group: ev.group?.id,
      });
      if ((window as unknown as { __band?: boolean }).__band && n.clientX < 40) ev.preventDefault();
    });
    api.onWillDrop((ev) => {
      const n = ev.nativeEvent;
      log.push({ t: 'willdrop', kind: ev.kind, pos: ev.position, x: n.clientX, y: n.clientY, data: ev.getData() });
    });
    api.onDidDrop((ev) => log.push({ t: 'diddrop', pos: ev.position }));
    putOnDesk(api, { id: 'chart-1', component: 'chart', title: 'NQ Z6 · 5m' }, { at: 'active' });
    putOnDesk(
      api,
      { id: 'chart-2', component: 'chart', title: 'ES Z6 · 1m' },
      { at: 'beside', panel: 'chart-1', side: 'right' },
    );
    const left = api.addEdgeGroup('left', { id: 'edge-left', initialSize: 256, minimumSize: 200, maximumSize: 360 });
    putOnDesk(api, { id: 'markets', component: 'list', title: 'Markets' }, { at: 'tabs', group: left.id });
    const right = api.addEdgeGroup('right', { id: 'edge-right', initialSize: 392, minimumSize: 320, maximumSize: 640 });
    putOnDesk(api, { id: 'analyst', component: 'list', title: 'Analyst' }, { at: 'tabs', group: right.id });
    const bottom = api.addEdgeGroup('bottom', {
      id: 'edge-bottom',
      initialSize: 192,
      minimumSize: 120,
      collapsed: true,
    });
    putOnDesk(api, { id: 'positions', component: 'list', title: 'Positions' }, { at: 'tabs', group: bottom.id });
    putOnDesk(api, { id: 'accounts', component: 'list', title: 'Accounts' }, { at: 'tabs', group: bottom.id });
  };
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <DockviewReact
        className="dock-host"
        components={components}
        defaultTabComponent={KitTab}
        onReady={onReady}
        theme={{ ...tesseraDockTheme, edgeGroupCollapsedSize: 32 }}
      />
    </div>
  );
}
