import { join } from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';

const fontsDir = join(import.meta.dirname, '../../ui/fonts');
GlobalFonts.registerFromPath(join(fontsDir, 'InstrumentSans-VF.woff2'), 'Instrument Sans');
GlobalFonts.registerFromPath(join(fontsDir, 'InstrumentSerif-Regular.woff2'), 'Instrument Serif');
GlobalFonts.registerFromPath(join(fontsDir, 'TesseraFigures-Regular.woff2'), 'Tessera Figures');
GlobalFonts.registerFromPath(join(fontsDir, 'TesseraKeys.woff2'), 'Tessera Keys');
