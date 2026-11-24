import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, isTextInput, zoneOf } from '../src/commands/registry.ts';

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('CommandRegistry', () => {
  it('registers, runs and unregisters commands; duplicates throw', () => {
    const r = new CommandRegistry();
    const run = vi.fn();
    const off = r.register({ id: 'a', title: 'Alpha', group: 'G', run });
    expect(() => r.register({ id: 'a', title: 'Again', group: 'G', run })).toThrow(/already registered/);
    expect(r.run('a')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    off();
    expect(r.get('a')).toBeNull();
    expect(r.run('a')).toBe(false);
  });

  it('respects `when` for running and enablement', () => {
    const r = new CommandRegistry();
    let enabled = false;
    const run = vi.fn();
    r.register({ id: 'x', title: 'X', group: 'G', when: () => enabled, run });
    expect(r.isEnabled('x')).toBe(false);
    expect(r.run('x')).toBe(false);
    enabled = true;
    expect(r.run('x')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('ranks search results and hides hidden commands', () => {
    const r = new CommandRegistry();
    const noop = () => undefined;
    r.registerAll([
      { id: 't', title: 'Toggle left sidebar', group: 'View', run: noop },
      { id: 'tf', title: 'Timeframe 5m', group: 'Chart', keywords: ['interval'], run: noop },
      { id: 'h', title: 'Hidden thing', group: 'View', hidden: true, run: noop },
      { id: 'o', title: 'Open Settings', group: 'Areas', run: noop },
      { id: 'tc', title: 'Show Trade copier', group: 'View', run: noop },
      { id: 'tr', title: 'Trade: show, focus or hide', group: 'View', keywords: ['show trade'], run: noop },
    ]);
    expect(r.search('time')[0]?.command.id).toBe('tf');
    expect(r.search('sidebar')[0]?.command.id).toBe('t');
    expect(r.search('interval').map((m) => m.command.id)).toEqual(['tf']);
    expect(r.search('hidden')).toEqual([]);
    expect(r.search('').map((m) => m.command.id)).toEqual(['t', 'tf', 'o', 'tc', 'tr']);
    expect(r.search('show trade').map((m) => m.command.id)).toEqual(['tr', 'tc']);
    expect(r.search('osttngs').map((m) => m.command.id)).toEqual(['o']);
  });

  it('dispatches shortcuts with zone precedence and input suppression', () => {
    const r = new CommandRegistry();
    const global = vi.fn();
    const chart = vi.fn();
    const plain = vi.fn();
    r.register({ id: 'g', title: 'Global', group: 'G', shortcut: 'mod+b', allowInInput: true, run: global });
    r.register({ id: 'c', title: 'Chart', group: 'G', shortcut: 'mod+b', zone: 'chart', run: chart });
    r.register({ id: 'p', title: 'Plain', group: 'G', shortcut: 'j', run: plain });
    expect(r.handleKey(key('b', { ctrlKey: true }), 'chart', 'other', false)).toBe('c');
    expect(r.handleKey(key('b', { ctrlKey: true }), 'agent', 'other', false)).toBe('g');
    expect(r.handleKey(key('b', { metaKey: true }), 'agent', 'mac', false)).toBe('g');
    expect(r.handleKey(key('b', { metaKey: true }), 'agent', 'other', false)).toBeNull();
    expect(r.handleKey(key('j'), 'global', 'other', true)).toBeNull();
    expect(r.handleKey(key('j'), 'global', 'other', false)).toBe('p');
    expect(r.handleKey(key('b', { ctrlKey: true }), 'chart', 'other', true)).toBe('g');
    expect(chart).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledTimes(3);
  });

  it('notifies subscribers on changes', () => {
    const r = new CommandRegistry();
    const l = vi.fn();
    r.subscribe(l);
    const v0 = r.getVersion();
    const off = r.register({ id: 'a', title: 'A', group: 'G', run: () => undefined });
    off();
    expect(l).toHaveBeenCalledTimes(2);
    expect(r.getVersion()).toBe(v0 + 2);
  });

  it('logs async command failures instead of throwing', async () => {
    const r = new CommandRegistry();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r.register({ id: 'bad', title: 'Bad', group: 'G', run: () => Promise.reject(new Error('nope')) });
    expect(r.run('bad')).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('focus zones', () => {
  it('finds the nearest zone and detects text inputs', () => {
    document.body.innerHTML = `<div data-focus-zone="chart"><button id="b"></button><input id="i" /></div><textarea id="t"></textarea><input id="c" type="checkbox" />`;
    expect(zoneOf(document.getElementById('b'))).toBe('chart');
    expect(zoneOf(document.getElementById('t'))).toBe('global');
    expect(isTextInput(document.getElementById('i'))).toBe(true);
    expect(isTextInput(document.getElementById('t'))).toBe(true);
    expect(isTextInput(document.getElementById('c'))).toBe(false);
    expect(isTextInput(document.getElementById('b'))).toBe(false);
  });
});
