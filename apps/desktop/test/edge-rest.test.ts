import { describe, expect, it } from 'vitest';
import { planRest, setTileEmpty, tileEmpty, type RestInput } from '../src/workspace/dock/edgeRest.ts';
import { STORY_PRESETS, storyCollapsed, storyPreset } from '../src/workspace/presets.ts';

const open: RestInput = {
  chosen: false,
  focus: false,
  visible: true,
  collapsed: false,
  momentary: false,
  empty: null,
  short: false,
  settled: false,
};

describe('the bottom edge at rest (spec §2.2)', () => {
  it('rests on its strip when a desk loads with nothing in its tile, and opens when it loads with something', () => {
    expect(planRest({ ...open, empty: true })).toBe('rest');
    expect(planRest({ ...open, empty: true, collapsed: true })).toBeNull();
    expect(planRest({ ...open, empty: false, collapsed: true })).toBe('open');
    expect(planRest({ ...open, empty: false })).toBeNull();
  });

  it('never acts on an edge the user set by hand, nor before its tile knows, in focus mode or hidden', () => {
    expect(planRest({ ...open, empty: true, chosen: true })).toBeNull();
    expect(planRest({ ...open, empty: false, collapsed: true, chosen: true })).toBeNull();
    expect(planRest({ ...open, empty: null })).toBeNull();
    expect(planRest({ ...open, empty: true, focus: true })).toBeNull();
    expect(planRest({ ...open, empty: true, visible: false })).toBeNull();
  });

  it('rests only on what its tile first says after a load, never under the hands of a trader using it', () => {
    expect(planRest({ ...open, empty: true, settled: true })).toBeNull();
  });

  it('stays on its strip when the first order or fill arrives, so the charts keep their size at entry', () => {
    expect(planRest({ ...open, empty: false, collapsed: true, settled: true })).toBeNull();
  });

  it('leaves an edge a narrow window collapsed, and never opens one the dock is too short to hold', () => {
    expect(planRest({ ...open, empty: false, collapsed: true, momentary: true })).toBeNull();
    expect(planRest({ ...open, empty: false, collapsed: true, short: true })).toBeNull();
  });

  it('keeps what each tile last said until it goes', () => {
    setTileEmpty('positions', true);
    expect(tileEmpty('positions')).toBe(true);
    setTileEmpty('positions', false);
    expect(tileEmpty('positions')).toBe(false);
    setTileEmpty('positions', null);
    expect(tileEmpty('positions')).toBeNull();
  });

  it('is how a story that opens the bottom starts; a story that keeps it collapsed says so', () => {
    for (const s of STORY_PRESETS) {
      const c = storyCollapsed(s);
      expect(c.bottom).toBe(s.bottom === null ? true : undefined);
      expect('bottom' in c).toBe(s.bottom === null);
    }
    expect(storyCollapsed(storyPreset('analyse')).bottom).toBe(true);
  });
});
