import { describe, expect, it } from 'vitest';
import {
  centreWidth,
  centreWithLeftOpen,
  planHandExpand,
  planResponsive,
  type AutoEdge,
  type ResponsiveInput,
} from '../src/workspace/dock/responsive.ts';
import { EDGE_STRIP } from '../src/workspace/dock/edges.ts';

function dock(
  w: number,
  h: number,
  over: Partial<ResponsiveInput> & { leftCollapsed?: boolean; bottomCollapsed?: boolean } = {},
): ResponsiveInput {
  const narrow = w < 1600;
  const { leftCollapsed = false, bottomCollapsed = false, ...rest } = over;
  return {
    width: w,
    height: h - 40,
    left: { visible: true, collapsed: leftCollapsed, size: narrow ? 216 : 256 },
    right: { visible: true, collapsed: false, size: narrow ? 344 : 392 },
    bottom: { visible: true, collapsed: bottomCollapsed, size: 192 },
    auto: new Set<AutoEdge>(),
    held: new Set<AutoEdge>(),
    ...rest,
  };
}

describe('small windows (spec §8)', () => {
  it('leaves a 1920 × 1080 and a 1600 × 1000 desk as it is', () => {
    expect(planResponsive(dock(1920, 1080))).toEqual({ collapse: [], restore: [], release: [] });
    expect(planResponsive(dock(1600, 1000))).toEqual({ collapse: [], restore: [], release: [] });
  });

  it('collapses the left edge at 1440 × 900 and at 1280 × 800, and keeps the bottom', () => {
    expect(planResponsive(dock(1440, 900)).collapse).toEqual(['left']);
    expect(planResponsive(dock(1280, 800)).collapse).toEqual(['left']);
  });

  it('collapses the left and the bottom at the 1100 × 680 minimum, leaving the centre between the strip and the analyst', () => {
    const input = dock(1100, 680);
    expect(planResponsive(input).collapse).toEqual(['left', 'bottom']);
    expect(centreWidth({ ...input, left: { ...input.left!, collapsed: true } })).toBe(1100 - EDGE_STRIP - 344);
  });

  it('never collapses the analyst', () => {
    const plan = planResponsive(dock(1100, 680));
    expect(plan.collapse).not.toContain('right' as AutoEdge);
  });

  it('gives back only what size took, with 40px of hysteresis', () => {
    const auto = new Set<AutoEdge>(['left', 'bottom']);
    expect(planResponsive(dock(1500, 790, { auto, leftCollapsed: true, bottomCollapsed: true })).restore).toEqual([]);
    expect(planResponsive(dock(1520, 840, { auto, leftCollapsed: true, bottomCollapsed: true })).restore).toEqual([
      'left',
      'bottom',
    ]);
  });

  it('never opens an edge the user collapsed', () => {
    const plan = planResponsive(dock(1920, 1080, { leftCollapsed: true, bottomCollapsed: true }));
    expect(plan.restore).toEqual([]);
  });

  it('leaves an edge the user opened by hand while narrow until the window grows past the rule', () => {
    const held = new Set<AutoEdge>(['left']);
    expect(planResponsive(dock(1200, 900, { held }))).toEqual({ collapse: [], restore: [], release: [] });
    expect(planResponsive(dock(1700, 900, { held })).release).toEqual(['left']);
  });

  it('measures the centre as it would be with the left edge open', () => {
    const input = dock(1440, 900, { leftCollapsed: true });
    expect(centreWithLeftOpen(input)).toBe(1440 - 344 - 216);
    expect(centreWidth(input)).toBe(1440 - 344 - EDGE_STRIP);
  });

  it('a hidden edge takes nothing and is never collapsed', () => {
    const input = dock(1100, 680);
    const plan = planResponsive({ ...input, left: { ...input.left!, visible: false } });
    expect(plan.collapse).toEqual(['bottom']);
  });

  it('makes room when an edge opened by hand leaves the centre under 560 (rule 5)', () => {
    expect(planHandExpand(dock(1100, 680), 'right')).toBe('left');
    expect(planHandExpand(dock(1100, 680), 'left')).toBe('bottom');
    expect(planHandExpand(dock(1600, 1000), 'right')).toBeNull();
  });
});

describe('a settled size', () => {
  it('is judged by the rule alone, so a 1600 desk never stays without Markets', () => {
    const auto = new Set<AutoEdge>(['left']);
    expect(planResponsive(dock(1600, 1000, { auto, leftCollapsed: true })).restore).toEqual([]);
    expect(planResponsive(dock(1600, 1000, { auto, leftCollapsed: true }), { settled: true }).restore).toEqual([
      'left',
    ]);
  });
});

describe('the analyst docked in another edge', () => {
  it('is never collapsed for size: the left edge holding it stays open at 1100', () => {
    const keep = new Set<AutoEdge>(['left']);
    expect(planResponsive(dock(1100, 680)).collapse).toContain('left');
    expect(planResponsive(dock(1100, 680, { keep })).collapse).not.toContain('left');
    expect(planResponsive(dock(1600, 700, { keep: new Set<AutoEdge>(['bottom']) })).collapse).not.toContain('bottom');
  });

  it('is never the edge that steps back to make room for one opened by hand', () => {
    const input = dock(1100, 680, { keep: new Set<AutoEdge>(['left']) });
    expect(planHandExpand(input, 'right')).toBe('bottom');
    expect(planHandExpand({ ...input, bottom: null }, 'right')).toBeNull();
  });
});
