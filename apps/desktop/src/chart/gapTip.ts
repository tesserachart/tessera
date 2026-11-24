import { displayZone } from '../state/timeZone.ts';

export function gapTipWords(fromMs: number, toMs: number): string {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: displayZone(),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `No trade history ${clock.format(fromMs)}–${clock.format(toMs)}`;
}
