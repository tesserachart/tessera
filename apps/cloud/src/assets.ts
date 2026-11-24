import wordmark from '@tessera/ui/brand/wordmark-text.svg';
import sans from '@tessera/ui/fonts/InstrumentSans-VF.woff2';
import serif from '@tessera/ui/fonts/InstrumentSerif-Regular.woff2';

import type { Asset } from './app.ts';

export const ASSETS: Readonly<Record<string, Asset>> = {
  'instrument-sans.woff2': { body: sans, type: 'font/woff2' },
  'instrument-serif.woff2': { body: serif, type: 'font/woff2' },
  'wordmark.svg': { body: wordmark, type: 'image/svg+xml' },
};
