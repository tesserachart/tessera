import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Splash } from '../src/shell/Splash.tsx';
import { TestRuntime, answeringClient } from './support/runtime.tsx';

describe('a surface that loads says nothing in words', () => {
  it('shows only the mark while the window connects', () => {
    render(
      <TestRuntime client={answeringClient({}).client}>
        <Splash />
      </TestRuntime>,
    );
    const splash = screen.getByRole('alert', { name: 'Connecting' });
    expect(splash.textContent).toBe('');
  });
});
