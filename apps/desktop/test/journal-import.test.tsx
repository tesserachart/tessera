import { QueryClientProvider } from '@tanstack/react-query';
import type { ImportResult } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../src/app/queries.ts';
import { Import } from '../src/areas/journal/sections/Import.tsx';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { seedTools } from './support/runtime.tsx';

afterEach(cleanup);

const result = (trades: number): ImportResult => ({
  platform: 'tradovate',
  format: 'Tradovate orders',
  rows: trades * 2,
  fills: trades * 2,
  newFills: trades * 2,
  duplicates: 0,
  trades,
  skipped: 0,
  errors: [],
  warnings: [],
  preview: [],
  importId: null,
  accountId: null,
  unknownSymbols: [],
});

function mount() {
  const rt = fakeRuntime();
  seedTools(['journal.preview_import', 'journal.import_csv', 'journal.log_trade']);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Import />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { rt, view };
}

const csv = new File(['Date,Symbol,Qty\n'], 'orders.csv', { type: 'text/csv' });

describe('importing a broker export', () => {
  it('shows the newest preview whichever answers last, and imports exactly what it showed, once', async () => {
    const { rt, view } = mount();
    const picker = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
    fireEvent.change(picker, { target: { files: [csv] } });
    await vi.waitFor(() => expect(rt.toolCalls('journal.preview_import')).toHaveLength(1));
    fireEvent.click(screen.getByText('Auto-detect'));
    await vi.waitFor(() => expect(rt.toolCalls('journal.preview_import')).toHaveLength(2));
    await act(async () => {
      rt.toolCalls('journal.preview_import')[1]!.ok(result(3));
      await Promise.resolve();
    });
    await act(async () => {
      rt.toolCalls('journal.preview_import')[0]!.ok(result(1));
      await Promise.resolve();
    });
    const importNow = await screen.findByText('Import 3 trades');
    fireEvent.click(importNow);
    fireEvent.click(importNow);
    await vi.waitFor(() => expect(rt.toolCalls('journal.import_csv')).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(rt.toolCalls('journal.import_csv')).toHaveLength(1);
    expect(rt.toolCalls('journal.import_csv')[0]!.input).toEqual(rt.toolCalls('journal.preview_import')[1]!.input);
  });

  it('logs a trade by hand once, however often Log the trade is pressed while it goes', async () => {
    const { rt, view } = mount();
    fireEvent.click(screen.getByText('Manual entry'));
    fireEvent.change(screen.getByLabelText('Contract'), { target: { value: 'NQZ6' } });
    fireEvent.change(screen.getByLabelText('Entry price'), { target: { value: '20640' } });
    fireEvent.change(screen.getByLabelText('Entry time'), { target: { value: '09:31' } });
    const form = view.container.querySelector('form.jr-logform')!;
    fireEvent.submit(form);
    await vi.waitFor(() => expect(rt.toolCalls('journal.log_trade')).toHaveLength(1));
    fireEvent.submit(form);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rt.toolCalls('journal.log_trade')).toHaveLength(1);
  });
});
