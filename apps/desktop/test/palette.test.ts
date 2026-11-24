import { describe, expect, it } from 'vitest';
import { commandVerb, completePrice, paletteEnter, readingsOf, symbolValue } from '../src/shell/palette.ts';

describe('⌘K readings', () => {
  it('completes a shorthand price against the last, as traders type it', () => {
    expect(completePrice(615, 3, 20641.25)).toBe(20615);
    expect(completePrice(698, 3, 20641.25)).toBe(20698);
    expect(completePrice(485, 3, 487.83)).toBe(485);
    expect(completePrice(615, 3, null)).toBe(615);
  });

  it('reads a bare price as an answer, then a question; ? only asks', () => {
    expect(readingsOf('615', 20641.25)).toEqual([
      { kind: 'price', price: 20615 },
      { kind: 'ask', text: 'what about 615?' },
    ]);
    expect(readingsOf('?why did the flip hold', null)).toEqual([{ kind: 'ask', text: 'why did the flip hold' }]);
    expect(readingsOf('es', null)).toEqual([{ kind: 'rows' }]);
  });

  it('offers three words as a question: first when nothing matches, after the rows when a command does', () => {
    expect(readingsOf('what breaks plan a', null, false)[0]).toEqual({ kind: 'ask', text: 'what breaks plan a' });
    expect(readingsOf('reset this area', null, true)[0]).toEqual({ kind: 'rows' });
  });

  it('names the Enter of a command by its verb', () => {
    expect(commandVerb('Open Research')).toBe('open');
    expect(commandVerb('Show the trading panel')).toBe('show');
    expect(commandVerb('Timeframe 15m')).toBe('15m');
    expect(commandVerb('Nav: full or rail')).toBe('run');
  });

  it('Enter charts a desk symbol, runs a highlighted command, and never charts typed command names', () => {
    const es = [{ instrument: 'ES' }];
    expect(paletteEnter(es, symbolValue('ES'))).toEqual({ kind: 'symbol', instrument: 'ES' });
    expect(paletteEnter([], 'connections.open')).toEqual({ kind: 'command' });
    expect(paletteEnter(es, 'connections.open')).toEqual({ kind: 'command' });
    expect(paletteEnter([], '')).toEqual({ kind: 'none' });
    expect(paletteEnter([], symbolValue('Connections'))).toEqual({ kind: 'none' });
  });
});
