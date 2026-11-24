import { SPEC, focusConnections, openConnectionDialog } from '../../accounts/accountsUi.ts';
import { patch, makeStore, useStore } from '../../app/store.ts';
import { setSettingsSection } from '../../state/ui.ts';
import { showArea, showPreviousArea, areaStore } from '../store.ts';
import { categoryOf, isPageWord, landingOf, type SettingsCategory } from './model.ts';
import { read } from '../../app/store.ts';

interface SettingsNavState {
  query: string;
  target: { id: string; n: number } | null;
}

export const settingsNavStore = makeStore<SettingsNavState>({ query: '', target: null });

export function useSettingsNav<T>(pick: (s: SettingsNavState) => T): T {
  return useStore(settingsNavStore, pick);
}

let count = 0;

export function showCategory(category: SettingsCategory): void {
  setSettingsSection(category);
  patch(settingsNavStore, { target: null });
}

const ADD = 'connections.add.';

function revealed(where: string): string {
  if (!where.startsWith(ADD)) return where;
  const provider = where.slice(ADD.length);
  if (provider === SPEC) {
    openConnectionDialog({ kind: 'levels' });
    return 'connections.list';
  }
  focusConnections({ kind: 'add', provider });
  return 'connections.add';
}

function place(where: string | null | undefined): void {
  const category = where ? landingOf(where) : null;
  if (category) setSettingsSection(category);
  const target = where && category && !isPageWord(where) ? revealed(where) : null;
  patch(settingsNavStore, { query: '', target: target ? { id: target, n: ++count } : null });
}

export function openSettings(where?: string | null): void {
  place(where);
  showArea('settings');
}

export function placeSettings(where: string): void {
  if (landingOf(where)) place(where);
}

export function goToSetting(id: string, on?: SettingsCategory): void {
  const category = on ?? categoryOf(id) ?? landingOf(id);
  if (category) setSettingsSection(category);
  patch(settingsNavStore, { query: '', target: { id, n: ++count } });
}

export function toggleSettings(): void {
  if (read(areaStore).area === 'settings') showPreviousArea();
  else openSettings();
}
