import { patch, makeStore } from '../app/store.ts';

export type AppMenuSub = 'workspaces' | 'arrange';

export const appMenuStore = makeStore<{ open: boolean; sub: AppMenuSub | null }>({ open: false, sub: null });

export function openAppMenu(sub: AppMenuSub | null = null): void {
  patch(appMenuStore, { open: true, sub });
}
