import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readout, ReadoutRow, SettingsRow, Stepper, parseStep, steppedValue } from '../src/index.ts';

afterEach(cleanup);

function Held(props: {
  initial: number;
  min?: number;
  max?: number;
  onStep?: (n: number) => void;
  shiftSteps?: number;
}) {
  const [v, setV] = useState(props.initial);
  return (
    <Stepper
      label="Contracts"
      value={v}
      onValueChange={setV}
      min={props.min}
      max={props.max}
      onStep={props.onStep}
      shiftSteps={props.shiftSteps}
      suffix="t"
    />
  );
}

const field = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Contracts' });

describe('the stepper', () => {
  it('steps by its targets and by ↑ ↓, ⇧ taking several steps, within its bounds', () => {
    render(<Held initial={2} min={1} max={10} shiftSteps={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'More contracts' }));
    expect(field().value).toBe('3');
    fireEvent.keyDown(field(), { key: 'ArrowUp', shiftKey: true });
    expect(field().value).toBe('8');
    fireEvent.keyDown(field(), { key: 'ArrowUp', shiftKey: true });
    expect(field().value).toBe('10');
    expect(screen.getByRole('button', { name: 'More contracts' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(field().value).toBe('9');
    expect(screen.getByRole('button', { name: 'Less contracts' }).getAttribute('tabindex')).toBe('-1');
  });

  it('keeps what is typed until it reads as a value in bounds, and the value again on leaving', () => {
    render(<Held initial={2} min={1} />);
    fireEvent.change(field(), { target: { value: '' } });
    expect(field().value).toBe('');
    fireEvent.change(field(), { target: { value: '0' } });
    expect(field().value).toBe('0');
    fireEvent.blur(field());
    expect(field().value).toBe('2');
    fireEvent.change(field(), { target: { value: '1,250' } });
    fireEvent.blur(field());
    expect(field().value).toBe('1250');
  });

  it('hands its steps to the caller where they round to their own increments', () => {
    const onStep = vi.fn();
    render(<Held initial={250} onStep={onStep} />);
    fireEvent.keyDown(field(), { key: 'ArrowDown', shiftKey: true });
    expect(onStep).toHaveBeenCalledWith(-4);
    fireEvent.click(screen.getByRole('button', { name: 'More contracts' }));
    expect(onStep).toHaveBeenLastCalledWith(1);
  });

  it('offers its unit as a menu at the field’s end, after the figure in the tab order', () => {
    const onChange = vi.fn();
    const { container } = render(
      <Stepper
        label="Stop distance"
        value={40}
        onValueChange={() => undefined}
        buttons={false}
        unit={{
          value: 'ticks',
          label: 'Stop unit',
          onChange,
          options: [
            { value: 'ticks', short: 't', label: 'Ticks' },
            { value: 'usd', short: '$', label: 'Dollars' },
            { value: 'pct', short: '%', label: '% of the balance', disabled: true },
          ],
        }}
      />,
    );
    const box = container.querySelector('.t-stepper')!;
    const trigger = screen.getByRole('button', { name: 'Stop unit: Ticks' });
    expect(trigger.textContent).toBe('t');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(box.querySelector('.post')).toBeNull();
    expect(box.lastElementChild).toBe(trigger);
    expect(box.firstElementChild?.tagName).toBe('INPUT');
  });

  it('takes its unit menu out of reach while the field is off', () => {
    render(
      <Stepper
        label="Stop distance"
        value={40}
        onValueChange={() => undefined}
        disabled
        unit={{
          value: 't',
          label: 'Stop unit',
          onChange: () => undefined,
          options: [{ value: 't', short: 't', label: 'Ticks' }],
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Stop unit: Ticks' })).toHaveProperty('disabled', true);
  });

  it('draws its unit beside the figure, and no targets when asked', () => {
    const { container } = render(
      <Stepper label="Stop" value={40} onValueChange={() => undefined} suffix="t" prefix="$" buttons={false} invalid />,
    );
    const box = container.querySelector('.t-stepper')!;
    expect(box.querySelector('.pre')?.textContent).toBe('$');
    expect(box.querySelector('.post')?.textContent).toBe('t');
    expect(box.querySelector('.t-step')).toBeNull();
    expect(box.classList.contains('is-invalid')).toBe(true);
  });

  it('reads money, ticks and percents as numbers, and steps free of float noise', () => {
    expect(parseStep('$1,250')).toBe(1250);
    expect(parseStep('40 t')).toBe(40);
    expect(parseStep('0.5%')).toBe(0.5);
    expect(parseStep('')).toBeNull();
    expect(parseStep('-')).toBeNull();
    expect(steppedValue(0.1, 2, 0.1)).toBe(0.3);
    expect(steppedValue(1, -3, 1, 1)).toBe(1);
  });
});

describe('the read-out', () => {
  it('reads figures as rows: the label, a note, the value in its tone', () => {
    const { container } = render(
      <Readout label="Sample read-out">
        <ReadoutRow label="Position" value="Flat" quiet />
        <ReadoutRow label="Open P/L" value="+$125" tone="up" />
        <ReadoutRow label="Today" value="−$660" tone="down" note="$340 left" noteBinds />
        <ReadoutRow label="Fees" value="$0" tone="flat" />
      </Readout>,
    );
    const list = screen.getByLabelText('Sample read-out');
    expect(list.tagName).toBe('DL');
    const rows = [...container.querySelectorAll('.t-readout-row')].map((r) => [
      r.querySelector('dt')?.textContent,
      r.querySelector('dd')?.textContent,
      r.querySelector('.v')?.getAttribute('data-tone'),
    ]);
    expect(rows).toEqual([
      ['Position', 'Flat', null],
      ['Open P/L', '+$125', 'up'],
      ['Today', '$340 left−$660', 'down'],
      ['Fees', '$0', null],
    ]);
    expect(container.querySelector('.note')?.hasAttribute('data-binds')).toBe(true);
    expect(container.querySelector('.v.is-quiet')?.textContent).toBe('Flat');
  });
});

describe('a panel’s settings row', () => {
  it('is the settings row, compact', () => {
    const { container } = render(
      <SettingsRow compact label="Stop" help="20,620.25 · $200">
        <span>40 t</span>
      </SettingsRow>,
    );
    const row = container.querySelector('.t-set-row')!;
    expect(row.classList.contains('is-compact')).toBe(true);
    expect(row.querySelector('.lab .help')?.textContent).toBe('20,620.25 · $200');
    cleanup();
    const page = render(<SettingsRow label="Commission" />);
    expect(page.container.querySelector('.t-set-row')?.classList.contains('is-compact')).toBe(false);
  });
});
