import type { LegendNotice } from '@tessera/chart';

export const FIT_STEPS = 4;

export interface Fitted {
  readonly tight: boolean;
  readonly least: boolean;
  readonly suffix: string;
  readonly notice: string;
}

export function fitted(base: string, notice: LegendNotice | null, step: number): Fitted {
  const tight = step >= 1;
  const words = notice === null ? '' : step >= 3 ? notice.least : step >= 2 ? notice.short : notice.text;
  return { tight, least: step >= FIT_STEPS - 1, suffix: tight ? '' : base, notice: words };
}

export function firstFit(fits: (step: number) => boolean): number {
  for (let step = 0; step < FIT_STEPS - 1; step++) if (fits(step)) return step;
  return FIT_STEPS - 1;
}

export function squeezed(row: HTMLElement): boolean {
  const parts = row.querySelectorAll<HTMLElement>('.name > span, .ind-lg-notice');
  for (const part of parts) if (part.scrollWidth > part.clientWidth + 1) return true;
  return row.scrollWidth > row.clientWidth + 1;
}
