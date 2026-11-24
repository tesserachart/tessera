import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TradeTile } from '../src/workspace/tiles/TradeTile.tsx';

afterEach(cleanup);

describe('Trade with no chart to trade', () => {
  it('shows one quiet line asking for a chart, and nothing more', () => {
    const { container } = render(<TradeTile {...({} as Parameters<typeof TradeTile>[0])} />);
    expect(screen.getByText('Open a chart to trade from here.')).toBeTruthy();
    expect(container.querySelectorAll('button, input')).toHaveLength(0);
    expect(container.querySelector('.trade-tile')?.getAttribute('data-focus-zone')).toBe('ticket');
  });
});
