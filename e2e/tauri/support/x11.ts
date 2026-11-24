import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import type { Rect } from './webdriver.ts';

export interface OsWindow {
  id: string;
  title: string;
  pid: number | null;
  bounds: Rect;
  active: boolean;
  types: string[];
  states: string[];
}

function x(display: string, tool: string, ...args: string[]): string {
  return execFileSync(tool, ['-display', display, ...args], { encoding: 'utf8' });
}

function prop(output: string, name: string): string | null {
  const line = output.split('\n').find((l) => l.startsWith(`${name}(`));
  if (!line || line.includes('not found')) return null;
  return line.slice(line.search(/[=#:]/) + 1).trim();
}

function ids(value: string | null): string[] {
  return (value ?? '').match(/0x[0-9a-f]+/gi) ?? [];
}

function atoms(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

function geometry(display: string, id: string): Rect {
  const info = x(display, 'xwininfo', '-id', id);
  const n = (label: string) => Number(new RegExp(`${label}:\\s+(-?\\d+)`).exec(info)?.[1] ?? NaN);
  return { x: n('Absolute upper-left X'), y: n('Absolute upper-left Y'), width: n('Width'), height: n('Height') };
}

function exeOf(pid: number | null): string | null {
  if (pid === null) return null;
  try {
    return readlinkSync(`/proc/${String(pid)}/exe`);
  } catch {
    return null;
  }
}

export function osWindows(display: string, exe: string): OsWindow[] {
  const root = x(display, 'xprop', '-root', '_NET_ACTIVE_WINDOW', '_NET_CLIENT_LIST_STACKING');
  const active = ids(prop(root, '_NET_ACTIVE_WINDOW'))[0] ?? null;
  const topFirst = ids(prop(root, '_NET_CLIENT_LIST_STACKING')).reverse();
  const out: OsWindow[] = [];
  for (const id of topFirst) {
    const p = x(display, 'xprop', '-id', id, '_NET_WM_NAME', '_NET_WM_PID', '_NET_WM_WINDOW_TYPE', '_NET_WM_STATE');
    const pidText = prop(p, '_NET_WM_PID');
    const pid = pidText === null ? null : Number(pidText);
    if (exeOf(pid) !== exe) continue;
    out.push({
      id,
      title: JSON.parse(prop(p, '_NET_WM_NAME') ?? '""') as string,
      pid,
      bounds: geometry(display, id),
      active: active !== null && Number(active) === Number(id),
      types: atoms(prop(p, '_NET_WM_WINDOW_TYPE')),
      states: atoms(prop(p, '_NET_WM_STATE')),
    });
  }
  return out;
}

export function clickAt(display: string, point: { x: number; y: number }): void {
  execFileSync('xdotool', ['mousemove', '--sync', String(point.x), String(point.y), 'click', '1'], {
    env: { ...process.env, DISPLAY: display },
  });
}

export function closeByWindowManager(display: string, id: string): void {
  execFileSync('wmctrl', ['-i', '-c', id], { env: { ...process.env, DISPLAY: display } });
}
