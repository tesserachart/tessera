import { packsFrom, type VoicePack } from './packs.ts';

const manifests = import.meta.glob<unknown>('./packs/*/manifest.json', { eager: true, import: 'default' });
const files = import.meta.glob<string>('./packs/*/*.mp3', { eager: true, query: '?url', import: 'default' });

export const BUNDLED_PACKS: readonly VoicePack[] = packsFrom(manifests, files);
