import type { SettingInfo } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NumberSetting } from '../src/areas/settings/NumberSetting.tsx';
import { TestRuntime } from './support/runtime.tsx';

const KEY = 'market.savedTradeSessions';

const info: SettingInfo = {
  key: KEY,
  value: 60,
  default: 60,
  description: 'Sessions kept per contract',
  schema: { type: 'integer', minimum: 2, maximum: 1000 },
  userOnly: false,
};

function refusingBelow(min: number) {
  const asked: unknown[] = [];
  const client = {
    request: (_method: string, params: { name?: string; input?: { key: string; value: number } } | undefined) => {
      const value = params?.input?.value ?? 0;
      asked.push(value);
      const refused = value < min;
      return Promise.resolve({
        ok: !refused,
        status: refused ? 'error' : 'ok',
        callId: 'call-1',
        durationMs: 1,
        output: refused ? null : { key: KEY, value, previous: 60 },
        error: refused
          ? { code: 'invalid_input', message: `${KEY}: must be ≥ ${String(min)}`, details: null, retryable: false }
          : null,
        approval: null,
        deduped: false,
      });
    },
  };
  return { client, asked };
}

afterEach(cleanup);

describe('a number setting', () => {
  it('shows the value the runtime keeps, and why, when it refuses the one typed', async () => {
    const { client, asked } = refusingBelow(2);
    render(
      <TestRuntime client={client}>
        <NumberSetting info={info} unit="sessions" label="Sessions kept per contract" />
      </TestRuntime>,
    );
    const field = screen.getByRole('textbox', { name: 'Sessions kept per contract' });
    fireEvent.change(field, { target: { value: '1' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Must be ≥ 2'));
    expect(asked).toEqual([1]);
    expect((field as HTMLInputElement).value).toBe('60');
  });
});
