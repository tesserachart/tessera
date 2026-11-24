import { CHART_MAX_BARS, FIB_DEFAULT_LEVELS } from '@tessera/chart';
import type { ChartLayer } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { COMPUTED_BUILTINS, plotChoices } from '../src/alerts/seed.ts';
import {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BYTES_PER_MESSAGE,
  UPLOAD_CHUNK_BYTES,
} from '../src/analyst/attachments.ts';
import { INSTRUCTIONS_MAX } from '../src/areas/settings/categories/Analyst.tsx';

import { LAUNCH_LINK_FILE } from '../dev/launch-link.ts';
import { DRAWING_DEFAULT_COLOR, LABEL_SIZE, LEVEL_MAX, LEVEL_MIN } from '../src/chart/drawings/model.ts';
import { DRAWING_TEMPLATE_NAME_MAX } from '../src/chart/drawings/templates.ts';
import { NAME_MAX as PRESET_NAME_MAX } from '../src/chart/presets/model.ts';
import { NAME_MAX as TEMPLATE_NAME_MAX } from '../src/chart/templates/model.ts';
import { HISTORY_LIMIT } from '../src/market/flow/bigTrades.ts';
import { FOOTPRINT_PAGE } from '../src/market/flow/footprints.ts';
import { crateSource, rustLiteral, rustNumber, rustStrings } from './support/rust.ts';

describe("the desk's copies of the runtime's constants", () => {
  it.each([
    ['LABEL_SIZE', 'tessera-protocol/src/drawings.rs', 'LABEL_SIZE', LABEL_SIZE],
    ['DRAWING_DEFAULT_COLOR', 'tessera-protocol/src/drawings.rs', 'DEFAULT_COLOR', DRAWING_DEFAULT_COLOR],
    ['fib_retracement levels', 'tessera-protocol/src/drawings.rs', 'FIB_LEVELS', FIB_DEFAULT_LEVELS.fib_retracement],
    [
      'fib_extension levels',
      'tessera-protocol/src/drawings.rs',
      'FIB_EXTENSION_LEVELS',
      FIB_DEFAULT_LEVELS.fib_extension,
    ],
    ['fib_fan levels', 'tessera-protocol/src/drawings.rs', 'FIB_FAN_LEVELS', FIB_DEFAULT_LEVELS.fib_fan],
    ['LEVEL_MIN, LEVEL_MAX', 'tessera-protocol/src/drawings.rs', 'LEVEL_RANGE', [LEVEL_MIN, LEVEL_MAX]],
    ['templates NAME_MAX', 'tessera-protocol/src/templates.rs', 'NAME_MAX', TEMPLATE_NAME_MAX],
    ['DRAWING_TEMPLATE_NAME_MAX', 'tessera-protocol/src/templates.rs', 'NAME_MAX', DRAWING_TEMPLATE_NAME_MAX],
    ['presets NAME_MAX', 'tessera-protocol/src/presets.rs', 'NAME_MAX', PRESET_NAME_MAX],
    ['CHART_MAX_BARS', 'tessera-market/src/history.rs', 'CHART_MAX_BARS', CHART_MAX_BARS],
    ['HISTORY_LIMIT', 'tessera-market/src/orderflow/tools.rs', 'MAX_BIG_TRADES', HISTORY_LIMIT],
    ['FOOTPRINT_PAGE', 'tessera-market/src/module.rs', 'USER_MAX_FOOTPRINTS', FOOTPRINT_PAGE],
    ['LAUNCH_LINK_FILE', 'tessera-runtime/src/auth.rs', 'LAUNCH_LINK_FILE', LAUNCH_LINK_FILE],
  ])('%s is %s %s', (_desk, file, name, ours) => {
    expect(ours).toEqual(rustLiteral(file, name));
  });
});

describe('the client’s copies of the runtime’s own values', () => {
  it('lets an alert read the plots of exactly the built-ins the runtime computes', () => {
    expect(new Set(rustStrings('tessera-indicators/src/studies/mod.rs', 'COMPUTED_BUILTINS'))).toEqual(
      COMPUTED_BUILTINS,
    );
  });

  it('offers an alert a plot of every built-in the runtime computes', () => {
    const layer = (kind: string): ChartLayer => ({
      id: `${kind}-1`,
      kind,
      params: {},
      visible: true,
      namespace: 'user',
      sessionId: null,
    });
    const plotless = rustStrings('tessera-indicators/src/studies/mod.rs', 'COMPUTED_BUILTINS').filter(
      (kind) => plotChoices(layer(kind)).length === 0,
    );
    expect(plotless).toEqual([]);
    expect(plotChoices(layer('effort'))).toEqual([]);
    expect(plotChoices(layer('sma')).map((c) => c.operand)).toEqual([
      { kind: 'plot', indicator: 'sma', inputs: expect.any(Object), plot: 'ma', label: 'SMA 20' },
    ]);
  });

  it('checks attachments against the limits the runtime checks them against again', () => {
    const limit = (name: string) => rustNumber('tessera-protocol/src/agent.rs', name);
    expect({
      MAX_IMAGE_BYTES,
      MAX_FILE_BYTES,
      MAX_ATTACHMENTS,
      MAX_IMAGE_BYTES_PER_MESSAGE,
      UPLOAD_CHUNK_BYTES,
    }).toEqual({
      MAX_IMAGE_BYTES: limit('ATTACHMENT_MAX_IMAGE_BYTES'),
      MAX_FILE_BYTES: limit('ATTACHMENT_MAX_FILE_BYTES'),
      MAX_ATTACHMENTS: limit('ATTACHMENT_MAX_PER_MESSAGE'),
      MAX_IMAGE_BYTES_PER_MESSAGE: limit('ATTACHMENT_MAX_IMAGE_BYTES_PER_MESSAGE'),
      UPLOAD_CHUNK_BYTES: limit('ATTACHMENT_MAX_CHUNK_BYTES'),
    });
  });

  it('caps custom instructions at the length the runtime’s setting schema allows', () => {
    const settings = crateSource('tessera-runtime/src/settings.rs');
    const schema = /key: "agent\.customInstructions",[^}]*?"maxLength": (\d+)/.exec(settings);
    expect(Number(schema?.[1])).toBe(INSTRUCTIONS_MAX);
  });
});
