import { patch, makeStore, useStore } from '../app/store.ts';

export type ConnectionDialog = { kind: 'levels'; id?: string; draft?: string } | null;

export const RITHMIC = 'rithmic';
export const SPEC = 'spec';

export type LoginMode = 'replace' | 'again';

export type ConnectionsFocus =
  { kind: 'add'; provider: string } | { kind: 'edit'; id: string; login: LoginMode | null } | null;

export interface AccountsUiState {
  selected: string | null;
  dialog: ConnectionDialog;
  focus: ConnectionsFocus;
}

export const accountsUiStore = makeStore<AccountsUiState>({ selected: null, dialog: null, focus: null });

export function useAccountsUi<T>(selector: (s: AccountsUiState) => T): T {
  return useStore(accountsUiStore, selector);
}

export const selectAccount = (selected: string | null) => patch(accountsUiStore, { selected });
export const openConnectionDialog = (dialog: ConnectionDialog) => patch(accountsUiStore, { dialog });
export const focusConnections = (focus: ConnectionsFocus) => patch(accountsUiStore, { focus });
