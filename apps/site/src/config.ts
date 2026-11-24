import { RELEASE_DOWNLOADS, PLATFORM_NAMES, publishedPlatforms } from '@tessera/ui/downloads';

export const UPDATES_URL: string = import.meta.env.PUBLIC_UPDATES_URL ?? '';
export const PLATFORMS = publishedPlatforms(import.meta.env.PUBLIC_PLATFORMS ?? 'mac');

const names = PLATFORMS.map((p) => PLATFORM_NAMES[p]);
export const ON_PLATFORMS =
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;

export const APPLY_URL = `${(import.meta.env.PUBLIC_CLOUD_URL ?? 'https://account.tesserachart.com').replace(/\/+$/, '')}/apply`;

export const ENTITY = 'Individual Entrepreneur NICOLAS NOUR GOMEZ TOUA';
const ENTITY_ID = '305891121';
export const ENTITY_ADDRESS = 'Zakaria Paliashvili St. 41, Vake, Tbilisi, Georgia';
export const ENTITY_FULL = `${ENTITY}, registered in Georgia with identification number ${ENTITY_ID}, ${ENTITY_ADDRESS}`;

export const DOWNLOAD_META =
  PLATFORMS.length === 1
    ? `Alpha · ${ON_PLATFORMS} · ${RELEASE_DOWNLOADS.find((d) => d.platform === PLATFORMS[0])!.meta}`
    : `Alpha · ${ON_PLATFORMS}`;

export const NAME = 'Tessera';
export const TAGLINE = 'Every piece, in place.';

export const DESCRIPTION = `A trading desk for ${ON_PLATFORMS}: charts and order flow, the ladder and Rithmic execution, custom indicators, research, a journal and your own Claude Code or Codex as an analyst, built as one.`;

export { CONTACT_EMAIL, LEGAL_UPDATED } from '@tessera/ui/legal';
