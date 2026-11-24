import { makeStore, patch, useStore } from '../../app/store.ts';
import { showArea } from '../store.ts';

export interface CopySaid {
  groupId: string;
  tone: 'err' | 'info';
  text: string;
}

interface CopyUi {
  group: string | null;
  creating: boolean;
  said: CopySaid | null;
}

export const copyUiStore = makeStore<CopyUi>({ group: null, creating: false, said: null });

export const useCopyUi = <T>(pick: (s: CopyUi) => T): T => useStore(copyUiStore, pick);

export function selectCopyGroup(group: string): void {
  patch(copyUiStore, { group, creating: false });
}

export function openCopyGroup(group: string | null): void {
  patch(copyUiStore, group === null ? { creating: false } : { group, creating: false });
  showArea('copy');
}

export function setCreating(creating: boolean): void {
  patch(copyUiStore, { creating });
}

export function say(groupId: string, tone: CopySaid['tone'], text: string): void {
  patch(copyUiStore, { said: { groupId, tone, text } });
}

export function unsay(groupId: string): void {
  patch(copyUiStore, (s) => (s.said?.groupId === groupId ? { said: null } : {}));
}
