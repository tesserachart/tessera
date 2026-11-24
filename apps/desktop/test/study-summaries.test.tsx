import { INDICATOR_SPECS } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuiltinDetail } from '../src/areas/indicators/BuiltinDetail.tsx';
import { inputHelp, studySummary } from '../src/areas/indicators/summaries.ts';

vi.mock('../src/areas/indicators/PreviewChart.tsx', () => ({ PreviewChart: () => null }));

afterEach(cleanup);

const internal = /market\.|get_|\b[a-z]+[A-Z][A-Za-z]*\b|\binputs\.|\bpx\b|\d+ ?px/;
const sentences = (s: string) => s.split(/[.!?](\s|$)/).filter((x) => x.trim().length > 1).length;

describe('the study library speaks to traders', () => {
  it('gives every study a summary of one or two plain sentences, with no tool, input or pixel names', () => {
    for (const spec of INDICATOR_SPECS) {
      const s = studySummary(spec.kind);
      expect(s, spec.kind).toBeTruthy();
      expect(s, spec.kind).not.toMatch(internal);
      expect(sentences(s!), `${spec.kind}: ${s!}`).toBeLessThanOrEqual(2);
    }
  });

  it('explains every input in plain words', () => {
    for (const spec of INDICATOR_SPECS)
      for (const i of spec.inputs) {
        const help = inputHelp(spec.kind, i.key);
        expect(help, `${spec.kind}.${i.key}`).toBeTruthy();
        expect(help, `${spec.kind}.${i.key}`).not.toMatch(internal);
        expect(sentences(help!), `${spec.kind}.${i.key}`).toBeLessThanOrEqual(2);
      }
  });

  it('shows Big trades’ summary, not the agent’s spec, and each input’s help on focus', () => {
    const spec = INDICATOR_SPECS.find((s) => s.kind === 'big_trades')!;
    const { container } = render(
      <TooltipProvider>
        <BuiltinDetail spec={spec} chart={null} onChart={0} preview={{ instrument: 'NQZ6.CME', tf: '1m' }} />
      </TooltipProvider>,
    );
    const text = container.textContent;
    expect(text).toContain(studySummary('big_trades')!);
    expect(text).not.toMatch(/market\.get_big_trades|joinOrders|reachLimit|1 px/);
    const min = screen.getByText('Min size');
    expect(min.tabIndex).toBe(0);
    expect(min.getAttribute('aria-description')).toBe(inputHelp('big_trades', 'size'));
  });
});
