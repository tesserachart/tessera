import { describe, expect, it } from 'vitest';
import { keepExisting, keepShown, KEPT_WORKSPACES } from '../src/workspace/kept.ts';

describe('the workspaces kept mounted', () => {
  it('keeps the shown one and the ones shown just before, the shown one first', () => {
    let k = keepShown(null, 'a');
    expect(k).toEqual({ mounted: ['a'], recent: ['a'] });
    k = keepShown(k, 'b');
    k = keepShown(k, 'c');
    expect(k.recent).toEqual(['c', 'b', 'a']);
    k = keepShown(k, 'a');
    expect(k.recent).toEqual(['a', 'c', 'b']);
    expect(k.mounted).toEqual(['a', 'b', 'c']);
  });

  it('lets the one shown longest ago go past the limit', () => {
    let k = keepShown(null, 'a', 3);
    for (const id of ['b', 'c', 'a', 'd']) k = keepShown(k, id, 3);
    expect(k.recent).toEqual(['d', 'a', 'c']);
    expect(k.mounted).toEqual(['a', 'c', 'd']);
    expect(KEPT_WORKSPACES).toBeGreaterThanOrEqual(2);
    expect(keepShown(k, 'e', 0)).toEqual({ mounted: ['e'], recent: ['e'] });
  });

  it('lets a deleted workspace go, never the shown one', () => {
    let k = keepShown(null, 'a');
    k = keepShown(k, 'b');
    k = keepShown(k, 'c');
    const same = keepExisting(k, () => true);
    expect(same).toBe(k);
    const gone = keepExisting(k, (id) => id !== 'b' && id !== 'c');
    expect(gone).toEqual({ mounted: ['a', 'c'], recent: ['c', 'a'] });
  });
});
