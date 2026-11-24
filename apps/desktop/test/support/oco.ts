import { DEFAULT_OCO, type OcoConfig } from '../../src/shell/oco.ts';

export const BRACKET_ON: OcoConfig = {
  ...DEFAULT_OCO,
  on: true,
  stop: { on: true, unit: 'ticks', value: 40 },
  target: { on: true, unit: 'ticks', value: 80 },
};
