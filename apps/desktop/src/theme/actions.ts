import type { JsonValue } from '@tessera/protocol';
import { runTool } from '../app/tools.ts';
import { writeSetting } from '../state/runtimeSettings.ts';
import { SCHEME_KEY, type Flip } from './scheme.ts';
import { setThemeSettings, THEME_KEY } from './store.ts';

export async function changeTheme(change: JsonValue): Promise<void> {
  await writeSetting(THEME_KEY, change, { merge: true });
}

export async function changeScheme(change: JsonValue): Promise<void> {
  setThemeSettings({ scheme: await writeSetting(SCHEME_KEY, change, { merge: true }) });
}

export async function writeFlip(flip: Flip): Promise<void> {
  await changeScheme(flip.keep as JsonValue);
  setThemeSettings({ active: await writeSetting(THEME_KEY, flip.show as JsonValue, { merge: true }) });
}

export async function saveTheme(name: string, source: { from?: string; theme?: JsonValue } = {}): Promise<void> {
  await runTool('appearance.save_theme', { name, ...source });
}

export async function renameTheme(id: string, name: string): Promise<void> {
  await runTool('appearance.rename_theme', { id, name });
}

export async function deleteTheme(id: string): Promise<void> {
  await runTool('appearance.delete_theme', { id });
}
