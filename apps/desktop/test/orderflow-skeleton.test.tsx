import { SampleSkeleton } from '@tessera/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LadderSample } from '../src/orderflow/dom/LadderSample.tsx';
import { ladderRow } from '../src/orderflow/dom/ladderView.ts';
import { TapeSample } from '../src/orderflow/tape/TapeSample.tsx';
import { tapeRow } from '../src/orderflow/tape/tapeView.ts';

afterEach(cleanup);

const shape = (el: Element): string =>
  `${el.tagName.toLowerCase()}.${el.className}(${[...el.children].map(shape).join(',')})`;

describe('the loading book', () => {
  it('is drawn from rows the ladder itself builds, with the live ladder’s columns, and no words', () => {
    const live = document.createElement('div');
    live.className = 't-ladder has-pnl has-ps';
    live.dataset.vol = 'session';
    const like = createRef<HTMLElement>();
    (like as { current: HTMLElement }).current = live;
    render(
      <SampleSkeleton label="Loading the book">
        <LadderSample like={like} />
      </SampleSkeleton>,
    );
    const status = screen.getByRole('status', { name: 'Loading the book' });
    const sample = status.querySelector<HTMLElement>('[skullet-ghost] .t-ladder')!;
    expect(sample.className).toBe('t-ladder has-pnl has-ps');
    expect(sample.dataset.vol).toBe('session');
    const row = sample.querySelector('.r')!;
    expect(shape(row)).toBe(shape(ladderRow(document).el));
    expect(status.querySelector('[skullet-loading]')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the loading tape', () => {
  it('is drawn from rows the tape itself builds, one row height apart', () => {
    render(
      <SampleSkeleton label="Loading prints">
        <TapeSample millis aggregate />
      </SampleSkeleton>,
    );
    const rows = [...screen.getByRole('status', { name: 'Loading prints' }).querySelectorAll('.t-tape-rows > .r')];
    expect(rows.length).toBeGreaterThan(20);
    expect(shape(rows[0]!)).toBe(shape(tapeRow(document).el));
    expect((rows[3] as HTMLElement).style.top).toBe('calc(var(--row-h-ladder) * 3)');
  });

  it('leaves out the print count column when the tape shows single prints', () => {
    render(
      <SampleSkeleton label="Loading prints">
        <TapeSample millis={false} aggregate={false} />
      </SampleSkeleton>,
    );
    expect(document.querySelector('.t-tape-rows > .r .n')).toBeNull();
  });
});
